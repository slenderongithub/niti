import { test, expect } from "bun:test";
import { priceFor, costOf } from "./pricing.ts";

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
