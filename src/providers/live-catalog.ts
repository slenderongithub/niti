import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CATALOG, LIVE_CONTEXT } from "./catalog.ts";
import { LIVE_PRICES, type Price } from "./pricing.ts";

// Keeps every provider's model list current without a niti release. Model lists used to be a
// snapshot frozen at build time, so a picker months old offered models that had been deprecated
// and missed the ones that replaced them.
//
// Source: models.dev, the same keyless registry scripts/gen-catalog.ts builds the shipped snapshot
// from. It marks deprecated models, dates releases, and says what a model can input and output —
// enough to keep only models an niti agent can actually run, newest first.
//
// Order of precedence, freshest first: the live fetch (once a day, in the background) → the copy
// cached from the last fetch (~/.config/niti/models.json) → the snapshot built into this binary.
// Offline or with models.dev down, niti keeps working on whichever of those it has.

const SOURCE = "https://models.dev/api.json";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
export const MAX_MODELS = 12; // newest N per provider; anything older is still usable via "custom…"

// niti's provider id → models.dev's, where they differ. Everything else is the same id.
const MODELS_DEV_ID: Record<string, string> = {
  moonshot: "moonshotai",
  together: "togetherai",
  fireworks: "fireworks-ai",
};

export interface RawModel {
  id?: string;
  tool_call?: boolean;
  status?: string; // "deprecated" | "beta" | "alpha" | undefined
  release_date?: string;
  family?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number };
  cost?: { input?: number; output?: number; cache_read?: number };
}

export interface ProviderModels {
  models: string[]; // newest first, at most MAX_MODELS
  deprecated: string[]; // models.dev says these are on their way out
  prices: Record<string, Price>;
  contexts: Record<string, number>;
}

export interface ModelsCache {
  fetchedAt: number;
  providers: Record<string, ProviderModels>; // keyed by niti provider id
}

// Whether an niti agent can run this model at all. Exported for the build-time generator, so the
// shipped snapshot and the live list can never disagree about what belongs in a picker.
export function usable(m: RawModel, vendor: string): boolean {
  if (!m.tool_call) return false; // niti is a tool loop
  if (m.status === "deprecated" || m.status === "alpha") return false;
  // Text in, text out, and nothing else out: image, audio and video generators (and Gemini's
  // deep-research agents, which return images) cannot sit in a chat-completions tool loop.
  const out = m.modalities?.output ?? ["text"];
  if (!out.includes("text") || out.some((o) => o !== "text")) return false;
  // OpenAI's -pro and -codex models are served by the Responses API only; niti speaks Chat Completions.
  if (vendor === "openai" && /(^|-)(pro|codex)/.test(m.family ?? "")) return false;
  return true;
}

// A gateway lists hundreds of models, and "newest first" there is whatever a small reseller
// published this week. On OpenRouter, offer the major labs' models only, without the :free /
// :beta variants (rate-limited copies of the same model). The rest are a "custom…" away.
const GATEWAY_LABS = /^(anthropic|openai|google|deepseek|moonshotai|x-ai|qwen|z-ai|mistralai|meta-llama|minimax|nvidia)\/[^:]+$/;

function gatewayOk(id: string, vendor: string): boolean {
  return vendor !== "openrouter" || GATEWAY_LABS.test(id);
}

// The newest usable models, without duplicates of one another: a dated pin
// ("claude-opus-4-5-20251101" beside "claude-opus-4-5") or a regional copy ("…@eu") is the same
// model, and listing both just pushes a real choice off the end of the list.
export function pickModels(models: Record<string, RawModel>, vendor: string, max = MAX_MODELS): string[] {
  const ids = Object.entries(models)
    .filter(([id, m]) => usable(m, vendor) && gatewayOk(id, vendor))
    .sort(([a, ma], [b, mb]) => (mb.release_date ?? "").localeCompare(ma.release_date ?? "") || a.localeCompare(b))
    .map(([id]) => id);
  const all = new Set(ids);
  const dated = /^(.*)-(\d{8}|\d{4}-\d{2}-\d{2})$/;
  const copyOf = (id: string) => (id.includes("@") ? id.slice(0, id.indexOf("@")) : dated.exec(id)?.[1]) ?? "";
  return ids.filter((id) => !all.has(copyOf(id))).slice(0, max);
}

// The models.dev registry boiled down to what niti keeps for each of its own providers.
export function digest(data: Record<string, { models?: Record<string, RawModel> }>, ids = Object.keys(CATALOG)): ModelsCache["providers"] {
  const out: ModelsCache["providers"] = {};
  for (const id of ids) {
    const entry = Object.hasOwn(CATALOG, id) ? CATALOG[id] : undefined;
    if (!entry || entry.category === "local" || id === "custom") continue; // these list what is installed, not a registry
    const raw = data[MODELS_DEV_ID[id] ?? id]?.models;
    if (!raw) continue;
    const models = pickModels(raw, id);
    if (models.length === 0) continue;
    const prices: Record<string, Price> = {};
    const contexts: Record<string, number> = {};
    for (const [mid, m] of Object.entries(raw)) {
      if (typeof m.cost?.input === "number" && typeof m.cost?.output === "number") {
        prices[mid] = { input: m.cost.input, output: m.cost.output, ...(typeof m.cost.cache_read === "number" ? { cacheRead: m.cost.cache_read } : {}) };
      }
      if (typeof m.limit?.context === "number" && m.limit.context > 0) contexts[mid] = m.limit.context;
    }
    const deprecated = Object.entries(raw).filter(([, m]) => m.status === "deprecated").map(([mid]) => mid);
    out[id] = { models, deprecated, prices, contexts };
  }
  return out;
}

const DEPRECATED = new Map<string, Set<string>>();

// Puts a digest into effect: the picker lists, and the exact prices and windows behind the cost
// meter and compaction. Mutates the shared CATALOG entries, so every reader sees it at once.
export function applyModels(providers: ModelsCache["providers"]): void {
  for (const [id, p] of Object.entries(providers)) {
    const entry = Object.hasOwn(CATALOG, id) ? CATALOG[id] : undefined;
    if (!entry || p.models.length === 0) continue;
    entry.models = p.models;
    DEPRECATED.set(id, new Set(p.deprecated));
    for (const [mid, price] of Object.entries(p.prices)) LIVE_PRICES.set(`${id}/${mid}`, price);
    for (const [mid, n] of Object.entries(p.contexts)) LIVE_CONTEXT.set(`${id}/${mid}`, n);
  }
}

// True when models.dev marks this model deprecated — an agent configured with it should be told.
export function isDeprecated(provider: string, model: string): boolean {
  return DEPRECATED.get(provider)?.has(model) ?? false;
}

export function cachePath(): string {
  return process.env.NITI_MODELS_FILE || join(homedir(), ".config", "niti", "models.json");
}

export function readCache(path = cachePath()): ModelsCache | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const c = JSON.parse(readFileSync(path, "utf8")) as ModelsCache;
    return typeof c.fetchedAt === "number" && c.providers && typeof c.providers === "object" ? c : undefined;
  } catch {
    return undefined; // a corrupt cache is a missing cache — the next refresh rewrites it
  }
}

export async function fetchModels(fetchImpl: typeof fetch = fetch): Promise<ModelsCache> {
  const res = await fetchImpl(SOURCE, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`models.dev: HTTP ${res.status}`);
  return { fetchedAt: Date.now(), providers: digest((await res.json()) as Record<string, { models?: Record<string, RawModel> }>) };
}

// Apply the cached lists now (synchronously, so the very first picker request sees them), then
// fetch fresh ones in the background if the cache is missing or older than a day. Never throws and
// never blocks startup. NITI_OFFLINE=1 keeps it off the network entirely.
// The cached lists only, no network — for one-shot headless runs, which shouldn't wait on a fetch
// they'd exit before using. Prices and windows still come out current as of the last refresh.
export function applyCachedModels(): void {
  const cached = readCache();
  if (cached) applyModels(cached.providers);
}

export function startModelRefresh(opts: { fetchImpl?: typeof fetch; now?: number; onUpdate?: (c: ModelsCache) => void } = {}): Promise<void> {
  const cached = readCache();
  if (cached) applyModels(cached.providers);
  const now = opts.now ?? Date.now();
  if (process.env.NITI_OFFLINE === "1" || (cached && now - cached.fetchedAt < MAX_AGE_MS)) return Promise.resolve();
  return fetchModels(opts.fetchImpl)
    .then((fresh) => {
      applyModels(fresh.providers);
      const path = cachePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(fresh));
      opts.onUpdate?.(fresh);
    })
    .catch((err: unknown) => console.error(`niti: model list refresh skipped (${err instanceof Error ? err.message : String(err)}) — using the ${cached ? "cached" : "built-in"} list`));
}

// Local runtimes list what is actually installed. Both Ollama and LM Studio serve the OpenAI
// `GET /v1/models`; a server that isn't running falls back to the catalog's seed names.
export async function localModels(provider: string, fetchImpl: typeof fetch = fetch): Promise<string[] | undefined> {
  const entry = Object.hasOwn(CATALOG, provider) ? CATALOG[provider] : undefined;
  if (entry?.category !== "local" || !entry.baseURL) return undefined;
  try {
    const res = await fetchImpl(`${entry.baseURL.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return undefined;
    const ids = ((await res.json()) as { data?: { id?: string }[] }).data?.map((m) => m.id).filter((id): id is string => !!id) ?? [];
    return ids.length ? ids : undefined;
  } catch {
    return undefined;
  }
}
