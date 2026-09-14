// What a session has cost so far, in USD — the number the TUI's context panel shows next to tokens.
//
// ponytail: a hand-maintained table for the model families people actually run, matched by longest
// name prefix. An unknown model returns undefined (the UI shows "—") rather than a confidently
// wrong number. Upgrade path: models.dev — already the source for catalog.generated.ts — ships a
// per-model `cost` block; teach scripts/gen-catalog.ts to emit it and read from there instead.

import { GENERATED_PRICES } from "./catalog.generated.ts";

export interface Price {
  input: number; // USD per 1M input tokens
  output: number; // USD per 1M output tokens
}

// Prefix → price. Longest matching prefix wins, so "claude-opus" beats "claude".
const PRICES: Record<string, Price> = {
  "claude-opus": { input: 15, output: 75 },
  "claude-sonnet": { input: 3, output: 15 },
  "claude-haiku": { input: 0.8, output: 4 },
  "claude-3.7-sonnet": { input: 3, output: 15 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4.1": { input: 2, output: 8 },
  "o3-mini": { input: 1.1, output: 4.4 },
  o3: { input: 2, output: 8 },
  o1: { input: 15, output: 60 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-3": { input: 0.3, output: 2.5 },
  "gemini-3.6-flash": { input: 0.3, output: 2.5 },
  // The `-latest` aliases are what the catalog actually ships for Google, and Google is
  // hand-maintained in catalog.ts, so GENERATED_PRICES never covers it. Without these three the
  // cost meter read "$0.00+" for the project's own default team.
  "gemini-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-flash": { input: 0.3, output: 2.5 },
  "gemini-pro": { input: 1.25, output: 10 },
  "deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
  "glm-4": { input: 0.6, output: 2.2 },
  "glm-5": { input: 0.6, output: 2.2 },
  grok: { input: 2, output: 10 },
  kimi: { input: 0.6, output: 2.5 },
  moonshot: { input: 0.6, output: 2.5 },
  "mistral-large": { input: 2, output: 6 },
  "mistral-small": { input: 0.2, output: 0.6 },
  codestral: { input: 0.3, output: 0.9 },
  llama: { input: 0.59, output: 0.79 },
  qwen: { input: 0.4, output: 1.2 },
};

// Local runtimes bill nothing, whatever model name they serve — a locally-hosted llama costing
// $0.59/Mtok would be plainly wrong, and "—" would be too.
const FREE_PROVIDERS = new Set(["ollama", "lmstudio"]);

export function priceFor(provider: string, model: string): Price | undefined {
  if (FREE_PROVIDERS.has(provider)) return { input: 0, output: 0 };
  // Exact match from models.dev first — it knows the actual per-model price, including for names
  // the prefix table below has no hope of matching (`gemini-flash-latest`, `nvidia/nemotron-…`).
  const exact = GENERATED_PRICES[`${provider}/${model}`];
  if (exact) return exact;
  // Provider-prefixed ids ("anthropic/claude-opus-4-8" via OpenRouter) match on the model half.
  const name = (model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model).toLowerCase();
  let best: Price | undefined;
  let bestLen = 0;
  for (const [prefix, price] of Object.entries(PRICES)) {
    if (name.startsWith(prefix) && prefix.length > bestLen) {
      best = price;
      bestLen = prefix.length;
    }
  }
  return best;
}

// Anthropic's standard ephemeral cache multipliers, applied against the model's own input price: a
// cache write costs slightly more than a fresh input token (writing the cache costs something),
// a cache read costs a small fraction of one. OpenAI's own auto-caching only ever reports reads
// (no write-side token count exists to bill), so cacheWriteTokens is simply 0 there — same formula
// still applies correctly.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

// USD for one agent's cumulative usage. 0 for an unpriced model, so a mixed team still reports the
// cost of the models it does know — `priced` tells the caller whether the total is complete.
export function costOf(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): { usd: number; priced: boolean } {
  const p = priceFor(provider, model);
  if (!p) return { usd: 0, priced: false };
  const usd =
    (inputTokens * p.input +
      outputTokens * p.output +
      cacheReadTokens * p.input * CACHE_READ_MULTIPLIER +
      cacheWriteTokens * p.input * CACHE_WRITE_MULTIPLIER) /
    1_000_000;
  return { usd, priced: true };
}
