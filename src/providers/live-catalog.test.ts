import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG, LIVE_CONTEXT, contextWindow } from "./catalog.ts";
import { LIVE_PRICES, priceFor } from "./pricing.ts";
import { pickModels, digest, applyModels, startModelRefresh, isDeprecated, localModels, readCache, type RawModel } from "./live-catalog.ts";

// applyModels mutates the shared catalog; put it back so other test files see the shipped lists.
const saved = Object.fromEntries(Object.entries(CATALOG).map(([id, e]) => [id, e.models]));
afterEach(() => {
  for (const [id, models] of Object.entries(saved)) CATALOG[id]!.models = models;
  LIVE_PRICES.clear();
  LIVE_CONTEXT.clear();
  delete process.env.NITI_MODELS_FILE;
  delete process.env.NITI_OFFLINE;
});

const chat = (release: string, extra: Partial<RawModel> = {}): RawModel => ({ tool_call: true, release_date: release, modalities: { output: ["text"] }, ...extra });

test("newest first; deprecated, tool-less, image/audio and dated duplicates are dropped", () => {
  const picked = pickModels(
    {
      "m-old": chat("2025-01-01"),
      "m-new": chat("2026-09-01"),
      "m-mid": chat("2026-03-01"),
      "m-mid-20260301": chat("2026-03-01"), // a dated pin of m-mid
      "m-mid@eu": chat("2026-03-01"), // a regional copy of m-mid
      "m-gone": chat("2026-08-01", { status: "deprecated" }),
      "m-embed": chat("2026-09-02", { tool_call: false }),
      "m-image": chat("2026-09-03", { modalities: { output: ["text", "image"] } }),
      "m-voice": chat("2026-09-04", { modalities: { output: ["text", "audio"] } }),
    },
    "x",
  );
  expect(picked).toEqual(["m-new", "m-mid", "m-old"]);
  expect(pickModels(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`m${i}`, chat(`2026-01-${String(i + 1).padStart(2, "0")}`)])), "x")).toHaveLength(12);
});

test("OpenAI's Responses-only families are left out; OpenRouter offers major labs without :free copies", () => {
  expect(pickModels({ "gpt-x": chat("2026-01-01", { family: "gpt" }), "gpt-x-pro": chat("2026-01-02", { family: "gpt-pro" }), "gpt-x-codex": chat("2026-01-03", { family: "gpt-codex" }) }, "openai")).toEqual(["gpt-x"]);
  expect(pickModels({ "openai/gpt-x": chat("2026-01-01"), "openai/gpt-x:free": chat("2026-01-02"), "tiny-reseller/model": chat("2026-01-03") }, "openrouter")).toEqual(["openai/gpt-x"]);
});

test("a digest replaces the picker list and supplies exact prices and windows", () => {
  const providers = digest({
    google: {
      models: {
        "gemini-9-flash": chat("2026-09-01", { cost: { input: 0.5, output: 3, cache_read: 0.05 }, limit: { context: 2_000_000 } }),
        "gemini-1-flash": chat("2024-01-01", { status: "deprecated" }),
      },
    },
  });
  expect(providers.google).toMatchObject({ models: ["gemini-9-flash"], deprecated: ["gemini-1-flash"] });
  applyModels(providers);
  expect(CATALOG.google!.models).toEqual(["gemini-9-flash"]);
  expect(priceFor("google", "gemini-9-flash")).toEqual({ input: 0.5, output: 3, cacheRead: 0.05 });
  expect(contextWindow("google", "gemini-9-flash")).toBe(2_000_000);
  expect(isDeprecated("google", "gemini-1-flash")).toBe(true);
  expect(isDeprecated("google", "gemini-9-flash")).toBe(false);
});

test("local runtimes and the custom entry are never overwritten by the registry", () => {
  const p = digest({ ollama: { models: { a: chat("2026-01-01") } }, lmstudio: { models: { a: chat("2026-01-01") } }, custom: { models: { a: chat("2026-01-01") } } });
  expect(Object.keys(p)).toEqual([]);
});

const registry = { anthropic: { models: { "claude-new": chat("2026-10-01") } } };
const fakeFetch = (body: unknown, calls: { n: number }) =>
  (async () => {
    calls.n++;
    return new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;

test("refresh: a fresh cache applies with no fetch; a stale or missing one is fetched, applied and saved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "niti-models-"));
  process.env.NITI_MODELS_FILE = join(dir, "models.json");
  const calls = { n: 0 };

  await startModelRefresh({ fetchImpl: fakeFetch(registry, calls) }); // no cache yet → fetch
  expect(calls.n).toBe(1);
  expect(CATALOG.anthropic!.models).toEqual(["claude-new"]);
  expect(readCache()?.providers.anthropic?.models).toEqual(["claude-new"]);

  CATALOG.anthropic!.models = ["stale"];
  await startModelRefresh({ fetchImpl: fakeFetch(registry, calls) }); // cache is minutes old → no fetch
  expect(calls.n).toBe(1);
  expect(CATALOG.anthropic!.models).toEqual(["claude-new"]); // but it was applied

  await startModelRefresh({ fetchImpl: fakeFetch(registry, calls), now: Date.now() + 25 * 3600_000 }); // a day later → refetch
  expect(calls.n).toBe(2);
});

test("refresh never throws: offline, a failing registry, or a corrupt cache all keep the lists working", async () => {
  const dir = mkdtempSync(join(tmpdir(), "niti-models-"));
  process.env.NITI_MODELS_FILE = join(dir, "models.json");
  const before = CATALOG.anthropic!.models;

  await startModelRefresh({ fetchImpl: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch });
  expect(CATALOG.anthropic!.models).toBe(before);

  writeFileSync(join(dir, "models.json"), "{not json");
  await startModelRefresh({ fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
  expect(CATALOG.anthropic!.models).toBe(before);

  process.env.NITI_OFFLINE = "1";
  const calls = { n: 0 };
  await startModelRefresh({ fetchImpl: fakeFetch(registry, calls) });
  expect(calls.n).toBe(0);
  expect(readFileSync(join(dir, "models.json"), "utf8")).toBe("{not json"); // untouched
});

test("Ollama / LM Studio list what is installed; a server that isn't up returns nothing", async () => {
  const up = (async (url: string) => {
    expect(url).toBe("http://localhost:11434/v1/models");
    return new Response(JSON.stringify({ data: [{ id: "qwen3:8b" }, { id: "llama3.3" }] }));
  }) as unknown as typeof fetch;
  expect(await localModels("ollama", up)).toEqual(["qwen3:8b", "llama3.3"]);
  expect(await localModels("ollama", (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch)).toBeUndefined();
  expect(await localModels("anthropic", up)).toBeUndefined(); // not a local runtime
});

test("a local runtime's model list comes from the endpoint saved with auth login, not only the default", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.NITI_AUTH_FILE = join(mkdtempSync(join(tmpdir(), "niti-local-")), "auth.json");
  writeFileSync(process.env.NITI_AUTH_FILE, JSON.stringify({ credentials: [{ provider: "ollama", type: "local", baseURL: "http://gpu-box:11434/v1" }] }));
  const asked: string[] = [];
  const up = (async (url: string) => (asked.push(url), new Response(JSON.stringify({ data: [{ id: "qwen3:32b" }] })))) as unknown as typeof fetch;
  try {
    expect(await localModels("ollama", up)).toEqual(["qwen3:32b"]);
    expect(asked).toEqual(["http://gpu-box:11434/v1/models"]);
  } finally {
    delete process.env.NITI_AUTH_FILE;
  }
});
