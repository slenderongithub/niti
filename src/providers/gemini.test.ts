import { test, expect } from "bun:test";
import { GeminiProvider } from "./gemini.ts";

// Construction is offline (no network); the send() mapping is exercised via the tool-bridge
// tests in tools.test.ts and end-to-end runs.
test("GeminiProvider constructs without a network call", () => {
  expect(new GeminiProvider("gemini-2.0-flash", "k")).toBeInstanceOf(GeminiProvider);
});
