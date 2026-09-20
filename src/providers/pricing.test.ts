import { test, expect } from "bun:test";
import { priceFor, costOf, inputIncludesCache } from "./pricing.ts";
import { CATALOG } from "./catalog.ts";
import { GENERATED_PRICES } from "./catalog.generated.ts";

test("longest matching prefix wins, so a family's variants don't all collapse to one price", () => {
  expect(priceFor("anthropic", "claude-opus-4-8")).toEqual({ input: 15, output: 75 });
  expect(priceFor("anthropic", "claude-haiku-4-5")).toEqual({ input: 0.8, output: 4 });
  // "gpt-4o-mini" must not match the shorter "gpt-4o" entry.
  expect(priceFor("openai", "gpt-4o-mini")).toEqual({ input: 0.15, output: 0.6 });
});

test("provider-prefixed ids (OpenRouter) are priced on the model half", () => {
  expect(priceFor("openrouter", "anthropic/claude-sonnet-5")).toEqual({ input: 3, output: 15 });
});

test("local runtimes are free whatever they name their model", () => {
  expect(priceFor("ollama", "llama3.3")).toEqual({ input: 0, output: 0 });
});

test("an unknown model reports unpriced rather than guessing", () => {
  expect(priceFor("acme", "totally-made-up-v9")).toBeUndefined();
  expect(costOf("acme", "totally-made-up-v9", 1_000_000, 1_000_000)).toEqual({ usd: 0, priced: false });
});

test("cost is per million tokens, input and output billed separately", () => {
  const { usd, priced } = costOf("anthropic", "claude-sonnet-5", 1_000_000, 200_000);
  expect(priced).toBe(true);
  expect(usd).toBeCloseTo(3 + 0.2 * 15, 6); // $3 in + $3 out
});

test("cache read/write tokens are priced off the model's own input rate, not billed as full-price input", () => {
  const base = costOf("anthropic", "claude-sonnet-5", 1_000_000, 0);
  const withCache = costOf("anthropic", "claude-sonnet-5", 1_000_000, 0, 1_000_000, 1_000_000);
  // input=$3, +cache-read (0.1x input)=$0.30, +cache-write (1.25x input)=$3.75
  expect(withCache.usd).toBeCloseTo(base.usd + 0.3 + 3.75, 6);
  expect(withCache.priced).toBe(true);
});

test("costOf defaults cache tokens to 0 — omitting them changes nothing", () => {
  const withDefaults = costOf("anthropic", "claude-sonnet-5", 500_000, 100_000);
  const explicitZero = costOf("anthropic", "claude-sonnet-5", 500_000, 100_000, 0, 0);
  expect(withDefaults).toEqual(explicitZero);
});

test("the shipped default models are priced, not silently $0.00", () => {
  // Google is hand-maintained in catalog.ts, so GENERATED_PRICES never covers it — and the
  // `-latest` aliases match no version-prefixed entry. The default team read "$0.00+" out of the box.
  for (const model of CATALOG["google"]!.models) {
    expect(priceFor("google", model)).toBeDefined();
  }
  expect(priceFor("google", "gemini-flash-lite-latest")).toEqual({ input: 0.1, output: 0.4 });
});

test("models.dev prices are used for generated providers", () => {
  const [pair] = Object.keys(GENERATED_PRICES);
  expect(pair).toBeDefined();
  const [provider, ...rest] = pair!.split("/");
  expect(priceFor(provider!, rest.join("/"))).toEqual(GENERATED_PRICES[pair!]!);
});

test("OpenAI and Gemini report cached tokens inside the input count, so they are billed at 0.1x, not 1.1x", () => {
  // 1M prompt tokens, of which 800k were served from cache: 200k full price + 800k at 0.1x.
  for (const [provider, model, input] of [
    ["openai", "gpt-4o", 2.5],
    ["google", "gemini-flash-lite-latest", 0.1],
  ] as const) {
    const cached = costOf(provider, model, 1_000_000, 0, 800_000);
    expect(cached.usd).toBeCloseTo(0.2 * input + 0.8 * input * 0.1, 6);
    // The old formula charged input + 0.1x cache on top: 1.08x of the uncached price, i.e. more
    // than a run with no cache at all.
    expect(cached.usd).toBeLessThan(costOf(provider, model, 1_000_000, 0).usd);
  }
});

test("Anthropic reports cache beside the input count, so it is still added, not subtracted", () => {
  expect(inputIncludesCache("anthropic")).toBe(false);
  expect(inputIncludesCache("openai")).toBe(true);
  expect(inputIncludesCache("google")).toBe(true);
  expect(inputIncludesCache("github-copilot")).toBe(true);
  // 1M uncached + 1M read: both billed, nothing subtracted.
  expect(costOf("anthropic", "claude-sonnet-5", 1_000_000, 0, 1_000_000).usd).toBeCloseTo(3 + 0.3, 6);
});

test("cache reads larger than the reported input never produce a negative bill", () => {
  expect(costOf("openai", "gpt-4o", 100, 0, 500).usd).toBeGreaterThanOrEqual(0);
});
