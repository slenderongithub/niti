#!/usr/bin/env bun
// Regenerates src/providers/catalog.generated.ts from models.dev's provider registry — the same
// source opencode uses — so amux's BYOK list actually matches "every provider opencode has"
// instead of a hand-curated subset. Run: bun run gen:catalog
//
// Providers needing non-API-key auth (AWS SigV4, Azure AD, GCP service accounts, gateway
// abstractions) are skipped — they need a dedicated SDK/auth flow amux doesn't implement.
// Anthropic/OpenAI/Google themselves are hand-maintained in catalog.ts and override these
// generated entries on id collision, so this script doesn't special-case them.

interface RawModel {
  id: string;
  limit?: { context?: number };
  tool_call?: boolean; // amux is a tool-use loop; a model without this cannot run an agent at all
  modalities?: { output?: string[] };
  cost?: { input?: number; output?: number }; // $ per 1M tokens, same unit as pricing.ts
}
interface RawProvider {
  id: string;
  name: string;
  npm?: string;
  api?: string | null;
  env?: string[];
  models?: Record<string, RawModel>;
}

// Needs a dedicated auth flow (SigV4, Azure AD, GCP SA, gateway routing) — not a plain API key.
const SKIP_IDS = new Set([
  "amazon-bedrock",
  "azure",
  "azure-cognitive-services",
  "google-vertex",
  "google-vertex-anthropic",
  "sap-ai-core",
  "cloudflare-ai-gateway",
  "merge-gateway",
  "vercel",
  "v0",
]);

// Recognizable inference providers worth offering unprompted. models.dev's registry is 149+ wide
// and mostly small resellers/gateways (LucidQuery, Claudinio, ...) — noise in a picker a new user
// sees on first launch. Anything not listed here is still usable via "custom…"; this only trims
// what's shown by default. Extend as providers earn a spot.
const ALLOW_IDS = new Set([
  "deepseek",
  "openrouter",
  "perplexity-agent",
  "huggingface",
  "novita-ai",
  "baseten",
  "nvidia",
  "scaleway",
  "digitalocean",
  "siliconflow",
  "minimax",
  "zai",
  "alibaba",
  "requesty",
  "ollama-cloud",
  "lmstudio",
]);

function clientFor(npm: string | undefined): "anthropic" | "openai" | "skip" {
  if (!npm) return "skip";
  if (npm.includes("@ai-sdk/anthropic")) return "anthropic";
  if (npm.includes("@ai-sdk/google")) return "skip"; // needs the native Gemini SDK, not a baseURL
  return "openai"; // openai-compatible + vendor packages that speak the OpenAI chat wire format
}

async function main() {
  const res = await fetch("https://models.dev/api.json");
  if (!res.ok) throw new Error(`models.dev fetch failed: ${res.status}`);
  const data = (await res.json()) as Record<string, RawProvider>;

  const entries: string[] = [];
  const prices: string[] = [];
  const hostsById: [string, string][] = []; // id → host, for the duplicate-vendor check below
  let skipped = 0;
  let generated = 0;

  for (const p of Object.values(data)) {
    if (SKIP_IDS.has(p.id) || !ALLOW_IDS.has(p.id)) {
      skipped++;
      continue;
    }
    const client = clientFor(p.npm);
    if (client === "skip") {
      skipped++;
      continue;
    }
    // Without an explicit base URL there's no way to route the request anywhere but the default
    // (api.anthropic.com / api.openai.com) — silently sending another provider's key there is
    // worse than skipping. (Anthropic and OpenAI themselves are hand-maintained in catalog.ts.)
    if (!p.api) {
      skipped++;
      continue;
    }
    // models.dev publishes some base URLs with a shell-style placeholder for an account id or
    // workspace host (Cloudflare, Databricks). Nothing here substitutes them, so shipping one
    // means a provider that appears in the picker as an ordinary choice and resolves DNS for the
    // literal string "${databricks_host}". Skip until per-provider URL templating exists.
    if (p.api.includes("${")) {
      skipped++;
      continue;
    }
    // env[0] is not reliably the API key — some providers list an account id or a hostname first
    // (CLOUDFLARE_ACCOUNT_ID, DATABRICKS_HOST), which shipped as the thing amux asks the user for.
    const envVar = p.env?.find((v) => /_(API_)?KEY$|_TOKEN$/.test(v)) ?? p.env?.at(-1);
    if (!envVar) {
      skipped++;
      continue;
    }
    // Only models that can actually call tools and emit text. Without this filter the picker
    // offered embedding and image models that physically cannot run an amux agent.
    const usable = Object.entries(p.models ?? {}).filter(
      ([, m]) => m.tool_call && (m.modalities?.output?.includes("text") ?? true),
    );
    const models = usable.map(([id]) => id).slice(0, 8); // cap for a scannable selector list
    if (models.length === 0) {
      skipped++;
      continue;
    }
    generated++;
    try {
      hostsById.push([p.id, new URL(p.api).host]);
    } catch {
      /* unparsable URL — the ${ } guard above already covers the realistic case */
    }
    // models.dev publishes cost per 1M tokens, the same unit pricing.ts uses. Emitting it turns
    // the cost meter from "$0.00+ for every model the hand-written prefix table missed" into a
    // real number, and it stays in step with the catalog because it is regenerated with it.
    for (const [id, m] of usable.slice(0, 8)) {
      if (typeof m.cost?.input === "number" && typeof m.cost?.output === "number") {
        prices.push(`  ${JSON.stringify(`${p.id}/${id}`)}: { input: ${m.cost.input}, output: ${m.cost.output} },`);
      }
    }
    const label = JSON.stringify(p.name || p.id);
    const baseURL = p.api ? `\n    baseURL: ${JSON.stringify(p.api)},` : "";
    entries.push(
      `  ${JSON.stringify(p.id)}: {\n    label: ${label},\n    client: ${JSON.stringify(client)},${baseURL}\n    envVar: ${JSON.stringify(envVar)},\n    models: ${JSON.stringify(models)},\n  },`,
    );
  }

  // The hand-maintained entries in catalog.ts carry client/category information the generator
  // cannot infer, so they win — but a *different* generated id pointing at the same host is not an
  // id collision and slipped straight through, putting one vendor in the picker twice with two
  // labels and two model counts. Fail the generation instead of shipping that again.
  const seenHosts = new Map<string, string>();
  for (const [id, url] of hostsById) {
    const prev = seenHosts.get(url);
    if (prev) throw new Error(`two providers resolve to ${url}: '${prev}' and '${id}' — fold one into the other or drop it from ALLOW_IDS`);
    seenHosts.set(url, id);
  }

  const out = `// GENERATED — do not hand-edit. Regenerate with: bun run gen:catalog
// Source: https://models.dev/api.json (the same provider registry opencode uses), filtered to ALLOW_IDS.
// ${generated} providers included, ${skipped} skipped (unlisted, need a dedicated SDK/auth flow, or missing an env var/base URL/model list).
import type { CatalogEntry } from "./catalog.ts";

export const GENERATED_CATALOG: Record<string, CatalogEntry> = {
${entries.join("\n")}
};

// Exact "provider/model" → USD per 1M tokens, straight from models.dev. pricing.ts consults this
// before its hand-maintained prefix table.
export const GENERATED_PRICES: Record<string, { input: number; output: number }> = {
${prices.join("\n")}
};
`;
  await Bun.write("src/providers/catalog.generated.ts", out);
  console.log(`wrote src/providers/catalog.generated.ts: ${generated} providers, ${skipped} skipped`);
}

main();
