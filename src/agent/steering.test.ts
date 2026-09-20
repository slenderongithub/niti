import { test, expect } from "bun:test";
import { familyOf, steeringFor } from "./steering.ts";

test("the model id decides the family, not the provider that served it", () => {
  // The catalog routes many providers through the OpenAI client — OpenRouter, Groq and a custom
  // endpoint all arrive as provider "openai" while serving someone else's weights entirely.
  expect(familyOf("openai", "google/gemini-2.5-flash")).toBe("gemini");
  expect(familyOf("openrouter", "anthropic/claude-sonnet-4")).toBe("anthropic");
  expect(familyOf("groq", "llama-3.3-70b")).toBe("other");
  expect(familyOf("openai", "gpt-4o")).toBe("openai");
});

test("falls back to the provider when the id says nothing", () => {
  expect(familyOf("google", "flash-latest")).toBe("gemini");
  expect(familyOf("anthropic", "some-internal-id")).toBe("anthropic");
  expect(familyOf("deepseek", "deepseek-chat")).toBe("other");
});

test("Gemini is told to stop writing reports, which is what it actually does wrong", () => {
  const s = steeringFor("google", "gemini-flash-lite-latest");
  expect(s).toContain("Do the work, then stop");
  expect(s.toLowerCase()).toContain("summary");
});

test("a family needing no extra steering gets nothing, not an empty header", () => {
  // An empty "For this model specifically:" block is pure noise in the prompt.
  expect(steeringFor("anthropic", "claude-opus-4-8")).toBe("");
  expect(steeringFor("deepseek", "deepseek-chat")).toBe("");
});

test("steering stays mechanical — it never redefines anything two agents must agree on", () => {
  // Conventions (hand-off phrasing, review verdicts, escalation) must stay in the shared guidance:
  // agents from different families message each other, and a convention only one side follows is a
  // coordination bug that presents as a model bug.
  for (const [provider, model] of [["google", "gemini-flash-latest"], ["openai", "gpt-4o"]]) {
    const s = steeringFor(provider!, model!).toLowerCase();
    for (const shared of ["handoff", "hand-off", "send_message", "ask_agent", "verdict", "review"]) {
      expect(s).not.toContain(shared);
    }
  }
});
