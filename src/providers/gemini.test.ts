import { test, expect } from "bun:test";
import { GeminiProvider, thinkingConfig } from "./gemini.ts";

// Construction is offline (no network); the send() mapping is exercised via the tool-bridge
// tests in tools.test.ts and end-to-end runs.
test("GeminiProvider constructs without a network call", () => {
  expect(new GeminiProvider("gemini-2.0-flash", "k")).toBeInstanceOf(GeminiProvider);
});

test("reasoning maps to a thinking budget, and sends nothing unless asked", () => {
  // Flash and Flash-Lite default to thinking off, so this is the difference between a model that
  // reasons about a coding task and one that does not.
  expect(thinkingConfig("auto")).toEqual({ thinkingConfig: { thinkingBudget: -1 } }); // -1 = model decides
  expect(thinkingConfig("off")).toEqual({ thinkingConfig: { thinkingBudget: 0 } });
  expect(thinkingConfig("high")).toEqual({ thinkingConfig: { thinkingBudget: 24576 } });
  // The default has to stay empty: models with no thinking mode reject the parameter outright.
  expect(thinkingConfig(undefined)).toEqual({});
});
