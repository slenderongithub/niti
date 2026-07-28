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
  let skipped = 0;
  let generated = 0;

  for (const p of Object.values(data)) {
    if (SKIP_IDS.has(p.id)) {
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
    const envVar = p.env?.[0];
    if (!envVar) {
      skipped++;
      continue;
    }
    const models = Object.keys(p.models ?? {}).slice(0, 8); // cap for a scannable selector list
    if (models.length === 0) {
      skipped++;
      continue;
    }
    generated++;
    const label = JSON.stringify(p.name || p.id);
    const baseURL = p.api ? `\n    baseURL: ${JSON.stringify(p.api)},` : "";
    entries.push(
      `  ${JSON.stringify(p.id)}: {\n    label: ${label},\n    client: ${JSON.stringify(client)},${baseURL}\n    envVar: ${JSON.stringify(envVar)},\n    models: ${JSON.stringify(models)},\n  },`,
    );
  }

  const out = `// GENERATED — do not hand-edit. Regenerate with: bun run gen:catalog
// Source: https://models.dev/api.json (the same provider registry opencode uses).
// ${generated} providers included, ${skipped} skipped (need a dedicated SDK/auth flow, or missing an env var/base URL/model list).
import type { CatalogEntry } from "./catalog.ts";

export const GENERATED_CATALOG: Record<string, CatalogEntry> = {
${entries.join("\n")}
};
`;
  await Bun.write("src/providers/catalog.generated.ts", out);
  console.log(`wrote src/providers/catalog.generated.ts: ${generated} providers, ${skipped} skipped`);
}

main();
