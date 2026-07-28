import { test, expect } from "bun:test";
import { CATALOG, providersByCategory } from "./catalog.ts";

test("every catalog entry is well-formed", () => {
  for (const [key, e] of Object.entries(CATALOG)) {
    // process.env[name] works with any string key (bracket access, not a shell `export`), so
    // real providers like "302ai" whose env var starts with a digit are still valid here.
    expect(e.envVar, `${key} envVar`).toMatch(/^[A-Z0-9_]+$/);
    if (key !== "custom") expect(e.models.length, `${key} models`).toBeGreaterThan(0); // custom prompts for the id
    expect(["anthropic", "gemini", "openai", "copilot"]).toContain(e.client);
    // OpenAI-compatible providers must carry a baseURL to route correctly — except "openai"
    // itself (default URL) and "custom" (URL comes from the agent config).
    if (e.client === "openai" && key !== "openai" && key !== "custom") {
      expect(e.baseURL, `${key} baseURL`).toBeTruthy();
    }
  }
});

test("local providers are categorized and need no key; byok excludes them", () => {
  const local = providersByCategory("local");
  expect(local).toContain("ollama");
  expect(local).toContain("lmstudio");
  for (const k of local) expect(CATALOG[k]!.keyOptional, `${k} keyOptional`).toBe(true);

  const byok = providersByCategory("byok");
  expect(byok).toContain("anthropic");
  expect(byok).toContain("custom");
  expect(byok).not.toContain("ollama");
});

test("github-copilot is a login provider using the copilot client", () => {
  expect(providersByCategory("login")).toContain("github-copilot");
  expect(CATALOG["github-copilot"]!.client).toBe("copilot");
});

test("z.ai is present via the generated catalog (models.dev), routed as OpenAI-compatible", () => {
  expect(CATALOG["zai"]).toBeDefined();
  expect(CATALOG["zai"]!.client).toBe("openai");
  expect(CATALOG["zai"]!.baseURL).toBe("https://api.z.ai/api/paas/v4");
  expect(CATALOG["zai"]!.models.length).toBeGreaterThan(0);
});

test("the catalog covers well over 100 providers (matches opencode/models.dev breadth)", () => {
  expect(Object.keys(CATALOG).length).toBeGreaterThan(100);
});

test("hand-maintained entries override generated ones on id collision", () => {
  // "anthropic" exists in models.dev too, but ours must keep the native client + context window.
  expect(CATALOG["anthropic"]!.client).toBe("anthropic");
  expect(CATALOG["anthropic"]!.context).toBe(1_000_000);
});
