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

test("Pro models can't turn thinking off, and Gemini 3 takes a level instead of a budget", () => {
  expect(thinkingConfig("off", "gemini-2.5-pro")).toEqual({ thinkingConfig: { thinkingBudget: 128 } }); // 0 is a 400 on Pro
  expect(thinkingConfig("off", "gemini-2.5-flash")).toEqual({ thinkingConfig: { thinkingBudget: 0 } });
  expect(thinkingConfig("low", "gemini-3-pro-preview")).toEqual({ thinkingConfig: { thinkingLevel: "low" } });
  expect(thinkingConfig("high", "gemini-3-flash")).toEqual({ thinkingConfig: { thinkingLevel: "high" } });
  expect(thinkingConfig("auto", "gemini-3-pro-preview")).toEqual({});
});

test("thinking tokens are counted as output — candidatesTokenCount leaves them out", async () => {
  const p = new GeminiProvider("gemini-flash-latest", "k");
  (p as unknown as { client: unknown }).client = {
    models: {
      generateContent: async () => ({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 250, cachedContentTokenCount: 60 },
      }),
    },
  };
  const out = await p.send("S", [{ role: "user", text: "hi" }], []);
  expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 260, reasoningTokens: 250, cacheReadTokens: 60 });
});
