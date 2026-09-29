import { test, expect } from "bun:test";
import { CATALOG, providersByCategory, contextWindow, probeOllamaContext } from "./catalog.ts";
import { GENERATED_CATALOG } from "./catalog.generated.ts";

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

test("the catalog stays curated, not the full models.dev breadth", () => {
  expect(Object.keys(CATALOG).length).toBeGreaterThan(20);
  expect(Object.keys(CATALOG).length).toBeLessThan(60);
});

test("hand-maintained entries override generated ones on id collision", () => {
  // "anthropic" exists in models.dev too, but ours must keep the native client + context window.
  expect(CATALOG["anthropic"]!.client).toBe("anthropic");
  expect(CATALOG["anthropic"]!.context).toBe(1_000_000);
});

test("no shipped baseURL contains an unsubstituted template placeholder", () => {
  // models.dev publishes some URLs with ${ACCOUNT_ID}/${HOST} placeholders. Nothing substitutes
  // them, so such a provider appears in the picker and then resolves DNS for the literal string.
  for (const [id, entry] of Object.entries(CATALOG)) {
    expect(`${id}: ${entry.baseURL ?? ""}`).not.toContain("${");
  }
});

test("every generated envVar is actually a key/token variable", () => {
  // models.dev lists env vars in arbitrary order; taking env[0] blindly shipped providers whose
  // "API key" prompt was really asking for an account id or a hostname.
  for (const [id, entry] of Object.entries(GENERATED_CATALOG)) {
    expect(`${id}: ${entry.envVar}`).toMatch(/(_KEY|_TOKEN)$/);
  }
});

test("no two providers point at the same host", () => {
  // A generated id and a hand-maintained one pointing at the same vendor is not an id collision,
  // so nothing caught it: the picker showed "Fireworks" and "Fireworks AI" as separate providers,
  // one with 1 model and one with 8, and picking the wrong one was a silent downgrade.
  const byHost = new Map<string, string>();
  for (const [id, entry] of Object.entries(CATALOG)) {
    if (!entry.baseURL) continue;
    const host = new URL(entry.baseURL).host;
    const prev = byHost.get(host);
    expect(prev ? `${prev} and ${id} both claim ${host}` : host).toBe(host);
    byHost.set(host, id);
  }
});

test("context window is per model: Haiku 4.5 is 200k even though the Anthropic default is 1M", () => {
  expect(contextWindow("anthropic", "claude-haiku-4-5")).toBe(200_000);
  expect(contextWindow("anthropic", "claude-opus-4-8")).toBe(1_000_000);
  expect(contextWindow("openai", "gpt-5-mini")).toBe(400_000);
  expect(contextWindow("openrouter", "anthropic/claude-sonnet-4-5")).toBe(200_000); // gateway ids match on the model half
  expect(contextWindow("groq", "some-unlisted-model")).toBe(128_000); // unknown → conservative default
});

test("an Ollama server's own num_ctx overrides the table, since it truncates silently past it", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ parameters: "stop <eot>\nnum_ctx 4096", model_info: { "llama.context_length": 131072 } }),
  });
  try {
    expect(await probeOllamaContext("llama3.3", `http://localhost:${server.port}/v1`)).toBe(4096);
    expect(contextWindow("ollama", "llama3.3")).toBe(4096);
  } finally {
    server.stop(true);
  }
});
