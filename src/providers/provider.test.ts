import { test, expect } from "bun:test";
import { summarizeError } from "./provider.ts";

test("unwraps a Google-style nested-JSON ApiError into a readable summary", () => {
  // Matches what @google/genai's ApiError actually produces: .message is a JSON *string*
  // containing another {"error": {...}} body, so raw String(err) buries the real reason.
  const err = Object.assign(new Error(JSON.stringify({ error: { message: "Resource has been exhausted", code: 429 } })), {
    status: 429,
    name: "ApiError",
  });
  expect(summarizeError(err)).toBe("429: Resource has been exhausted");
});

test("falls back to the plain message when it isn't nested JSON", () => {
  expect(summarizeError(new Error("boom"))).toBe("boom");
  expect(summarizeError(Object.assign(new Error("boom"), { status: 500 }))).toBe("500: boom");
});

test("handles a non-Error thrown value without throwing itself", () => {
  expect(summarizeError("plain string")).toBe("plain string");
});
