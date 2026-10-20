import { test, expect, beforeEach, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "niti-local-"));
process.env.NITI_LOCAL_MODELS_DIR = join(dir, "models");
process.env.NITI_LOCAL_IDLE_MS = "600000";
process.env.NITI_DISCOVER_DIRS = join(dir, "found"); // a fake LM Studio folder, filled by the tests
process.env.NITI_MLX_ENGINE_DIR = join(dir, "engine");
delete process.env.NITI_HF_URL;
delete process.env.NITI_OFFLINE;

const { quantOf, quantFiles, bitsPerWeight, isAuxiliary } = await import("./quant.ts");
const { fitModel, bestQuant, gpuBudget } = await import("./fit.ts");
const { searchCatalog, modelDetail, clearCatalogCache, templateHasTools, cleanReadme } = await import("./catalog.ts");
const { parseModelId, listInstalled, getInstalled, saveManifest, removeInstalled, repoDir } = await import("./store.ts");
const { DownloadManager, safeRel } = await import("./downloads.ts");
const { LocalRuntime, serverArgs } = await import("./runtime.ts");
const { LocalProvider, requestExtras } = await import("./provider.ts");
const { localApi } = await import("./routes.ts");
const { contextWindow } = await import("../providers/catalog.ts");
const { ensureMlxEngine, mlxEngineInstalled, removeMlxEngine, mlxSupported } = await import("./mlx.ts");

const GB = 1024 ** 3;
const MAC16 = { gpuBudget: gpuBudget(16 * GB, true) };

afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => clearCatalogCache());

// ---- a fake Hugging Face Hub -------------------------------------------------------------------

const WEIGHTS = Buffer.from("GGUF" + "x".repeat(200_000));
const SHA = createHash("sha256").update(WEIGHTS).digest("hex");
const TOOLS_TEMPLATE = "{%- if tools %}<tool_call>{{ tools }}</tool_call>{%- endif %}{%- if enable_thinking %}<think>{%- endif %}";

function hubModel(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    author: id.split("/")[0],
    downloads: 1000,
    likes: 10,
    trendingScore: 3,
    lastModified: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    gated: false,
    tags: ["gguf", "license:apache-2.0", "base_model:Qwen/Qwen3-4B"],
    cardData: { license: "apache-2.0", base_model: "Qwen/Qwen3-4B" },
    gguf: { total: 4e9, architecture: "qwen3", context_length: 262144, chat_template: TOOLS_TEMPLATE },
    siblings: [{ rfilename: "Qwen3-4B-Q4_K_M.gguf" }, { rfilename: "Qwen3-4B-Q8_0.gguf" }, { rfilename: "mmproj-F16.gguf" }, { rfilename: "README.md" }],
    ...over,
  };
}

// One MLX repo: weights, config, tokenizer and a chat template with tools; the README, licence and a
// stray Python file are not part of the model.
const MLX_FILES = ["config.json", "model.safetensors", "tokenizer.json", "tokenizer_config.json", "chat_template.jinja", "generation_config.json"];
const MLX_LIST = [
  {
    id: "mlx-community/Qwen3-4B-Instruct-4bit",
    author: "mlx-community",
    downloads: 20000,
    likes: 30,
    lastModified: "2026-10-02T00:00:00.000Z",
    gated: false,
    tags: ["mlx", "license:apache-2.0", "base_model:Qwen/Qwen3-4B"],
    cardData: { license: "apache-2.0", base_model: "Qwen/Qwen3-4B" },
    config: { model_type: "qwen3", tokenizer_config: { chat_template: TOOLS_TEMPLATE } },
    safetensors: { total: 4e9 },
    siblings: [...MLX_FILES, "README.md", "LICENSE.txt", "convert.py"].map((rfilename) => ({ rfilename, size: rfilename.endsWith(".safetensors") ? WEIGHTS.length : 64, ...(rfilename.endsWith(".safetensors") ? { lfs: { sha256: SHA, size: WEIGHTS.length } } : {}) })),
  },
];

const LIST = [
  hubModel("unsloth/Qwen3-4B-GGUF", { downloads: 9000 }),
  hubModel("bartowski/Qwen3-4B-GGUF", { downloads: 5000 }), // same base model: deduped in Recommended
  hubModel("someone/NoTools-7B-GGUF", { gguf: { total: 7e9, architecture: "llama", context_length: 8192, chat_template: "{{ messages }}" }, cardData: { base_model: "x/NoTools" } }),
  hubModel("big/Huge-235B-GGUF", { gguf: { total: 235e9, architecture: "qwen3moe", context_length: 32768, chat_template: TOOLS_TEMPLATE }, cardData: { base_model: "x/Huge" } }),
];

let hubRequests: string[] = [];
let ignoreRange = false;
const fakeHub: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  hubRequests.push(url.pathname + url.search);
  const p = url.pathname;
  if (p === "/api/models") return Response.json(url.searchParams.get("filter") === "mlx" ? MLX_LIST : LIST);
  if (p.startsWith("/api/models/")) {
    const id = p.slice("/api/models/".length);
    const mlx = MLX_LIST.find((x) => x.id === id);
    if (mlx) return Response.json(mlx);
    const m = LIST.find((x) => x.id === id) ?? hubModel(id);
    return Response.json({
      ...m,
      siblings: [
        { rfilename: "Qwen3-4B-Q4_K_M.gguf", size: WEIGHTS.length, lfs: { sha256: SHA, size: WEIGHTS.length } },
        { rfilename: "Qwen3-4B-Q8_0.gguf", size: WEIGHTS.length, lfs: { sha256: "0".repeat(64), size: WEIGHTS.length } },
      ],
    });
  }
  if (p.endsWith("/raw/main/README.md")) return new Response("---\nlicense: mit\n---\n# Qwen3 4B\n\nA <b>small</b> model.");
  if (p.endsWith("/raw/main/generation_config.json")) {
    return p.startsWith("/Qwen/") ? Response.json({ temperature: 0.7, top_p: 0.8, top_k: 20 }) : new Response("no", { status: 404 });
  }
  if (p.includes("/resolve/main/")) {
    const range = (init?.headers as Record<string, string> | undefined)?.range;
    if (range && !ignoreRange) {
      const start = Number(/bytes=(\d+)-/.exec(range)![1]);
      return new Response(WEIGHTS.subarray(start), { status: 206 });
    }
    return new Response(WEIGHTS);
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

// ---- quant -------------------------------------------------------------------------------------

test("quantOf reads the quantization from GGUF file names, shards and Unsloth dynamic quants included", () => {
  expect(quantOf("Qwen3-4B-Instruct-2507-Q4_K_M.gguf")).toBe("Q4_K_M");
  expect(quantOf("model-UD-Q4_K_XL.gguf")).toBe("UD-Q4_K_XL");
  expect(quantOf("Q8_0/Big-Q8_0-00001-of-00003.gguf")).toBe("Q8_0");
  expect(quantOf("gpt-oss-20b-MXFP4.gguf")).toBe("MXFP4");
  expect(quantOf("Llama-3.2-3B-Instruct-IQ4_XS.gguf")).toBe("IQ4_XS");
  expect(quantOf("model.gguf")).toBeUndefined();
});

test("quantFiles groups shards, drops projectors and orders smallest first", () => {
  const q = quantFiles([
    { rfilename: "Big-Q8_0-00002-of-00002.gguf", lfs: { size: 10, sha256: "b" } },
    { rfilename: "Big-Q8_0-00001-of-00002.gguf", lfs: { size: 20, sha256: "a" } },
    { rfilename: "Big-Q4_K_M.gguf", size: 15 },
    { rfilename: "mmproj-Big-F16.gguf", size: 5 },
    { rfilename: "notes.txt" },
  ]);
  expect(q.map((x) => x.quant)).toEqual(["Q4_K_M", "Q8_0"]);
  expect(q[1]!.files).toEqual(["Big-Q8_0-00001-of-00002.gguf", "Big-Q8_0-00002-of-00002.gguf"]);
  expect(q[1]!.sha256).toEqual(["a", "b"]);
  expect(q[1]!.size).toBe(30);
  expect(isAuxiliary("mmproj-model-f16.gguf")).toBe(true);
  expect(bitsPerWeight("UD-Q4_K_XL")).toBeGreaterThan(4);
});

// ---- fit ---------------------------------------------------------------------------------------

test("fit: a 4B Q4 model runs well on a 16 GB Mac, a 235B model won't fit, and slots cost context", () => {
  const small = fitModel({ params: 4e9, quant: "Q4_K_M", contextLength: 262144 }, MAC16);
  expect(small.tier).toBe("runs-well");
  expect(small.ctx).toBe(32768);
  expect(fitModel({ params: 235e9, quant: "Q4_K_M" }, MAC16).tier).toBe("wont-fit");
  const team = fitModel({ params: 8e9, quant: "Q4_K_M", slots: 4 }, MAC16);
  expect(team.ctx).toBeLessThan(32768);
  // Never above what the model was trained on.
  expect(fitModel({ params: 1e9, quant: "Q4_K_M", contextLength: 8192 }, MAC16).ctx).toBe(8192);
});

test("bestQuant prefers Q4_K_M, steps up with room to spare, and down when memory is short", () => {
  const quants = quantFiles(["Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0", "BF16"].map((q) => ({ rfilename: `m-${q}.gguf` })));
  expect(bestQuant(quants, 1e9, { gpuBudget: 64 * GB })!.quant.quant).toBe("Q8_0");
  expect(bestQuant(quants, 8e9, MAC16)!.quant.quant).toBe("Q4_K_M");
  expect(bestQuant(quants, 20e9, MAC16)!.quant.quant).toBe("Q3_K_M");
  expect(bestQuant(quantFiles([{ rfilename: "m-BF16.gguf" }]), 1e9, MAC16)).toBeUndefined();
});

// ---- catalog -----------------------------------------------------------------------------------

test("the catalogue reads tools support from the chat template", () => {
  expect(templateHasTools(TOOLS_TEMPLATE)).toBe(true);
  expect(templateHasTools("{{ messages }}")).toBe(false);
  expect(cleanReadme("---\na: b\n---\n# T\n\n\n\n<i>x</i>")).toBe("# T\n\nx");
});

test("Recommended keeps tool-capable models that run well here, one per base model", async () => {
  const r = await searchCatalog({ tab: "recommended", format: "gguf" }, MAC16, fakeHub);
  expect(r.models.map((m) => m.repo)).toEqual(["unsloth/Qwen3-4B-GGUF"]);
  const m = r.models[0]!;
  expect(m.tools).toBe(true);
  expect(m.thinking).toBe(true);
  expect(m.license).toBe("apache-2.0");
  expect(m.pick!.fit.tier).toBe("runs-well");
  expect(m.quants.every((q) => q.estimated && q.size! > 0)).toBe(true);
});

test("All models passes search and sort to the Hub, applies filters, and caches", async () => {
  hubRequests = [];
  const all = await searchCatalog({ tab: "all", q: "qwen", sort: "likes", format: "gguf" }, MAC16, fakeHub);
  expect(all.models.length).toBe(4);
  expect(hubRequests[0]).toContain("search=qwen");
  expect(hubRequests[0]).toContain("sort=likes");
  expect(hubRequests[0]).toContain("expand%5B%5D=gguf");
  const asked = hubRequests.length;
  await searchCatalog({ tab: "all", q: "qwen", sort: "likes", format: "gguf" }, MAC16, fakeHub);
  expect(hubRequests.length).toBe(asked);
  const tools = await searchCatalog({ tab: "all", tools: true, fits: true }, MAC16, fakeHub);
  expect(tools.models.map((m) => m.repo)).not.toContain("someone/NoTools-7B-GGUF");
  expect(tools.models.map((m) => m.repo)).not.toContain("big/Huge-235B-GGUF");
  const large = await searchCatalog({ tab: "all", size: "large" }, MAC16, fakeHub);
  expect(large.models.map((m) => m.repo)).toEqual(["big/Huge-235B-GGUF"]);
});

test("an unreachable Hub reads as offline, not as an error", async () => {
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const r = await searchCatalog({ tab: "all" }, MAC16, down);
  expect(r).toEqual({ models: [], offline: true, error: undefined });
});

test("modelDetail has exact sizes, checksums, per-quant fit and the cleaned model card", async () => {
  const d = await modelDetail("unsloth/Qwen3-4B-GGUF", MAC16, fakeHub);
  expect(d.quants[0]!.size).toBe(WEIGHTS.length);
  expect(d.quants[0]!.sha256).toEqual([SHA]);
  expect(d.fits.Q4_K_M!.tier).toBe("runs-well");
  expect(d.readme).toBe("# Qwen3 4B\n\nA small model.");
  await expect(modelDetail("../etc", MAC16, fakeHub)).rejects.toThrow();
});

// ---- store + downloads -------------------------------------------------------------------------

test("model ids are <repo>:<quant> and never reach outside the models directory", () => {
  expect(parseModelId("unsloth/Qwen3-4B-GGUF:Q4_K_M")).toEqual({ repo: "unsloth/Qwen3-4B-GGUF", quant: "Q4_K_M" });
  expect(parseModelId("../../etc:Q4")).toBeUndefined();
  expect(parseModelId("no-quant")).toBeUndefined();
  expect(() => safeRel("../evil.gguf")).toThrow();
  expect(safeRel("Q8_0/a.gguf")).toBe("Q8_0/a.gguf");
});

async function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

test("a download resumes from its .part, verifies the checksum, and installs with sampling", async () => {
  const events: { state: string; received: number }[] = [];
  const dm = new DownloadManager((p) => events.push({ state: p.state, received: p.received }), MAC16, fakeHub);
  // Half a file left over from an interrupted attempt.
  mkdirSync(repoDir("unsloth/Qwen3-4B-GGUF"), { recursive: true });
  writeFileSync(join(repoDir("unsloth/Qwen3-4B-GGUF"), "Qwen3-4B-Q4_K_M.gguf.part"), WEIGHTS.subarray(0, 1000));
  hubRequests = [];
  await dm.start("unsloth/Qwen3-4B-GGUF", "Q4_K_M");
  await waitFor(() => events.find((e) => e.state === "done" || e.state === "error"));
  expect(events.at(-1)!.state).toBe("done");
  expect(events.at(-1)!.received).toBe(WEIGHTS.length);
  const m = getInstalled("unsloth/Qwen3-4B-GGUF:Q4_K_M")!;
  expect(m.tools).toBe(true);
  expect(m.sampling).toEqual({ temperature: 0.7, top_p: 0.8, top_k: 20 }); // from the base model's config
  expect(readFileSync(join(repoDir(m.repo), m.files[0]!)).equals(WEIGHTS)).toBe(true);
  expect(listInstalled().map((x) => x.id)).toEqual(["unsloth/Qwen3-4B-GGUF:Q4_K_M"]);
  await expect(dm.start("unsloth/Qwen3-4B-GGUF", "Q4_K_M")).rejects.toThrow("already installed");
});

test("a corrupted download fails its checksum and installs nothing", async () => {
  const events: { state: string; error?: string }[] = [];
  const dm = new DownloadManager((p) => events.push({ state: p.state, error: p.error }), MAC16, fakeHub);
  await dm.start("unsloth/Qwen3-4B-GGUF", "Q8_0"); // its listed sha256 is all zeros
  await waitFor(() => events.find((e) => e.state === "error"));
  expect(events.at(-1)!.error).toContain("checksum");
  expect(getInstalled("unsloth/Qwen3-4B-GGUF:Q8_0")).toBeUndefined();
  expect(existsSync(join(repoDir("unsloth/Qwen3-4B-GGUF"), "Qwen3-4B-Q8_0.gguf.part"))).toBe(false);
});

test("a server that ignores Range restarts the file instead of appending a second copy", async () => {
  removeInstalled("unsloth/Qwen3-4B-GGUF:Q4_K_M");
  mkdirSync(repoDir("unsloth/Qwen3-4B-GGUF"), { recursive: true });
  writeFileSync(join(repoDir("unsloth/Qwen3-4B-GGUF"), "Qwen3-4B-Q4_K_M.gguf.part"), WEIGHTS.subarray(0, 500));
  ignoreRange = true;
  const done: string[] = [];
  const dm = new DownloadManager((p) => done.push(p.state), MAC16, fakeHub);
  await dm.start("unsloth/Qwen3-4B-GGUF", "Q4_K_M");
  await waitFor(() => done.find((s) => s === "done" || s === "error"));
  ignoreRange = false;
  expect(done.at(-1)).toBe("done");
});

test("gated repos are refused with a reason", async () => {
  LIST.push(hubModel("meta/Gated-GGUF", { gated: "manual" }));
  const dm = new DownloadManager(() => {}, MAC16, fakeHub);
  await expect(dm.start("meta/Gated-GGUF", "Q4_K_M")).rejects.toThrow("gated");
  LIST.pop();
});

// ---- runtime + provider (fake llama-server) ----------------------------------------------------

const FAKE = join(import.meta.dir, "../../scripts/e2e/fakellama.ts");

test("serverArgs: loopback only, jinja, reasoning extracted, one full-context slot per agent, f16 KV", () => {
  saveManifest({ id: "a/b-GGUF:Q4_K_M", repo: "a/b-GGUF", quant: "Q4_K_M", files: ["b-Q4_K_M.gguf"], bytes: 1, installedAt: 0 });
  const args = serverArgs(getInstalled("a/b-GGUF:Q4_K_M") ?? ({ id: "a/b-GGUF:Q4_K_M", repo: "a/b-GGUF", quant: "Q4_K_M", files: ["b-Q4_K_M.gguf"], bytes: 1, installedAt: 0 } as never), { port: 1234, slots: 3, ctx: 16384, apiKey: "k" });
  const at = (f: string) => args[args.indexOf(f) + 1];
  expect(at("--host")).toBe("127.0.0.1");
  expect(args).toContain("--jinja");
  expect(at("--reasoning-format")).toBe("deepseek");
  expect(at("-np")).toBe("3");
  expect(at("-c")).toBe(String(16384 * 3));
  expect(args).toContain("--no-kv-unified");
  expect(args).not.toContain("-ctk");
  expect(at("--api-key")).toBe("k");
});

test("requestExtras: the model's sampling over the defaults, the slot, and the thinking switch", () => {
  const m = { id: "x/y:Q4", repo: "x/y", quant: "Q4", files: [], bytes: 0, installedAt: 0, thinking: true, sampling: { temperature: 0.7 } };
  expect(requestExtras(m, 2, false)).toMatchObject({ temperature: 0.7, top_k: 20, id_slot: 2, cache_prompt: true, chat_template_kwargs: { enable_thinking: false } });
  expect(requestExtras({ ...m, thinking: false }, 0, true).chat_template_kwargs).toBeUndefined();
});

test("a local agent starts the runtime on first call, learns its context, and talks on its own slot", async () => {
  process.env.NITI_LLAMA_SERVER = FAKE;
  const statuses: string[] = [];
  const rt = new LocalRuntime((s) => statuses.push(s.state));
  const id = "unsloth/Qwen3-4B-GGUF:Q4_K_M";
  expect(getInstalled(id)).toBeDefined();
  const a = new LocalProvider(id, "backend", undefined, undefined, rt);
  const b = new LocalProvider(id, "frontend", undefined, undefined, rt);
  try {
    const reply = await a.send("sys", [{ role: "user", text: "hello" }], []);
    expect(reply.text).toContain("Done");
    const r2 = await b.send("sys", [{ role: "user", text: "hello" }], [], () => {});
    expect(r2.usage?.inputTokens).toBe(100);
    // The one-time model check runs first (probe.ts), then the agent's own request.
    expect(statuses).toEqual(["checking", "loading", "ready", "ready"]);
    expect(getInstalled(id)!.probe).toMatchObject({ toolMode: "native", planMode: "lines", verdict: "ready" });
    expect(rt.status()[0]).toMatchObject({ state: "ready", slots: 2, ctx: 16384 });
    expect(contextWindow("local", id)).toBe(16384);
    const args = JSON.parse(readFileSync(join(process.env.NITI_LOCAL_MODELS_DIR!, "llama-server.log.args"), "utf8")) as string[];
    expect(args[args.indexOf("-np") + 1]).toBe("2");
    const log = await waitFor(() => {
      const f = join(process.env.NITI_LOCAL_MODELS_DIR!, "fakellm.log");
      const t = existsSync(f) ? readFileSync(f, "utf8") : "";
      return t.includes("slot=1") ? t : undefined;
    });
    expect(log).toContain("LOCAL slot=0 temp=0.7 max=8192");
    expect(getInstalled(id)!.toolFormat).toBe("native");
  } finally {
    rt.stopAll();
    delete process.env.NITI_LLAMA_SERVER;
  }
});

test("a server a killed core left behind is stopped by the next runtime", async () => {
  process.env.NITI_LLAMA_SERVER = FAKE;
  const { reapOrphans } = await import("./runtime.ts");
  const id = "unsloth/Qwen3-4B-GGUF:Q4_K_M";
  if (!getInstalled(id)) saveManifest({ id, repo: "unsloth/Qwen3-4B-GGUF", quant: "Q4_K_M", files: ["Qwen3-4B-Q4_K_M.gguf"], bytes: 1, installedAt: 0 });
  writeFileSync(join(repoDir("unsloth/Qwen3-4B-GGUF"), "Qwen3-4B-Q4_K_M.gguf"), "GGUF");
  const rt = new LocalRuntime();
  await rt.ensure(id, "a");
  const pid = (rt as unknown as { servers: Map<string, { proc: { pid: number } }> }).servers.get(id)!.proc.pid;
  // Pretend the core that started it died without cleaning up: its record names a dead owner.
  writeFileSync(join(process.env.NITI_LOCAL_MODELS_DIR!, "runtime.pids"), JSON.stringify({ owner: 999_999, pids: [pid] }));
  expect(reapOrphans()).toBe(1);
  await Bun.sleep(300);
  expect(() => process.kill(pid, 0)).toThrow();
  delete process.env.NITI_LLAMA_SERVER;
});

test("a model that isn't installed fails with where to get it", async () => {
  const rt = new LocalRuntime();
  await expect(new LocalProvider("nobody/none-GGUF:Q4_K_M", "a", undefined, undefined, rt).send("s", [], [])).rejects.toThrow("not installed");
});

// ---- routes ------------------------------------------------------------------------------------

test("/local/* routes: device, catalogue, installed, delete", async () => {
  const published: string[] = [];
  const api = localApi({ download: (d) => published.push(d.state), runtime: () => {} }, fakeHub);
  const call = async (path: string, method = "GET", body: unknown = {}) => {
    const u = new URL(`http://x${path}`);
    const res = await api.handle(u.pathname, method, u, async () => body);
    return { status: res!.status, body: (await res!.json()) as any };
  };
  const dev = await call("/local/device");
  expect(dev.body.device.totalMemory).toBeGreaterThan(0);
  expect(typeof dev.body.runtimeAvailable).toBe("boolean");
  expect((await call("/local/catalog?tab=recommended")).body.models.length).toBe(1);
  expect((await call("/local/catalog/model?repo=unsloth/Qwen3-4B-GGUF")).body.readme).toContain("Qwen3");
  expect((await call("/local/models")).body.models.length).toBeGreaterThan(0);
  expect((await call("/local/download", "POST", { repo: "bad" })).status).toBe(400);
  expect((await call("/local/models?id=../x", "DELETE")).status).toBe(400);
  expect((await call("/local/models?id=unsloth/Qwen3-4B-GGUF:Q4_K_M", "DELETE")).body.ok).toBe(true);
  expect(getInstalled("unsloth/Qwen3-4B-GGUF:Q4_K_M")).toBeUndefined();
  expect(await api.handle("/elsewhere", "GET", new URL("http://x/elsewhere"), async () => ({}))).toBeUndefined();
});

test("niti-core models: recommended, search, get the best quant, list, rm", async () => {
  const { modelsCommand } = await import("./cli.ts");
  const lines: string[] = [];
  const out = (s: string) => lines.push(s);
  expect(await modelsCommand([], out, fakeHub)).toBe(0);
  // One upload per family: the GGUF one, or the more downloaded MLX one where MLX runs.
  expect(lines.join("\n")).toMatch(mlxSupported() ? /mlx-community\/Qwen3-4B-Instruct-4bit {2}\[MLX\]/ : /unsloth\/Qwen3-4B-GGUF/);
  lines.length = 0;
  expect(await modelsCommand(["search", "qwen"], out, fakeHub)).toBe(0);
  expect(lines.join("\n")).toContain("someone/NoTools-7B-GGUF");
  lines.length = 0;
  // The fixture's files are tiny, so the best quant for this Mac is Q8_0, whose listed checksum is
  // wrong on purpose: the default pick downloads it, and the bad checksum is reported, not installed.
  expect(await modelsCommand(["get", "unsloth/Qwen3-4B-GGUF"], out, fakeHub)).toBe(1);
  expect(lines.join("\n")).toContain("Downloading unsloth/Qwen3-4B-GGUF:Q8_0");
  expect(lines.at(-1)).toContain("checksum");
  lines.length = 0;
  expect(await modelsCommand(["get", "unsloth/Qwen3-4B-GGUF:Q4_K_M"], out, fakeHub)).toBe(0);
  expect(lines.at(-1)).toBe("Installed unsloth/Qwen3-4B-GGUF:Q4_K_M. Use it: provider local, model unsloth/Qwen3-4B-GGUF:Q4_K_M");
  lines.length = 0;
  expect(await modelsCommand(["list"], out, fakeHub)).toBe(0);
  expect(lines.join("\n")).toContain("unsloth/Qwen3-4B-GGUF:Q4_K_M");
  expect(await modelsCommand(["rm", "unsloth/Qwen3-4B-GGUF:Q4_K_M"], out, fakeHub)).toBe(0);
  expect(await modelsCommand(["rm", "nope"], out, fakeHub)).toBe(2);
  expect(await modelsCommand(["bogus"], out, fakeHub)).toBe(2);
});

// ---- MLX ---------------------------------------------------------------------------------------

const FAKE_MLX = join(import.meta.dir, "../../scripts/e2e/fakemlx.ts");

test("MLX names say their bits and size; only the files the engine loads are fetched", async () => {
  const { mlxBits, paramsFromName } = await import("./quant.ts");
  const { mlxFiles } = await import("./catalog.ts");
  expect(mlxBits("Qwen2.5-Coder-14B-Instruct-MLX-4bit")).toBe(4);
  expect(mlxBits("gemma-3-12b-it-qat-8bit")).toBe(8);
  expect(mlxBits("Llama-3.2-3B-Instruct-bf16")).toBe(16);
  expect(paramsFromName("Qwen2.5-Coder-14B-Instruct")).toBe(14e9);
  expect(paramsFromName("Qwen3-30B-A3B-4bit")).toBe(30e9);
  expect(paramsFromName("SmolLM2-360M-Instruct")).toBe(360e6);
  expect(mlxFiles(MLX_LIST[0]!.siblings).sort()).toEqual([...MLX_FILES].sort());
});

test("MLX repos join the catalogue where the engine runs, as one quant per repo", async () => {
  process.env.NITI_MLX_SERVER = FAKE_MLX;
  try {
    const mlx = await searchCatalog({ tab: "all", format: "mlx" }, MAC16, fakeHub);
    expect(mlx.models.map((m) => [m.repo, m.format])).toEqual([["mlx-community/Qwen3-4B-Instruct-4bit", "mlx"]]);
    const m = mlx.models[0]!;
    expect(m.tools).toBe(true);
    expect(m.quants.map((q) => q.quant)).toEqual(["mlx"]);
    expect(m.pick?.fit.tier).toBe("runs-well");
    // Recommended: one per model family across formats — the MLX upload of Qwen3-4B is the more
    // downloaded one here, so it stands for the family.
    clearCatalogCache();
    const rec = await searchCatalog({ tab: "recommended" }, MAC16, fakeHub);
    expect(rec.models.map((x) => x.repo)).toEqual(["mlx-community/Qwen3-4B-Instruct-4bit"]);
  } finally {
    delete process.env.NITI_MLX_SERVER;
  }
});

test("an MLX download fetches the model's files into one folder and records the format", async () => {
  const done: string[] = [];
  const dm = new DownloadManager((p) => done.push(p.state), MAC16, fakeHub);
  await dm.start("mlx-community/Qwen3-4B-Instruct-4bit", "mlx");
  await waitFor(() => done.find((x) => x === "done" || x === "error"));
  expect(done.at(-1)).toBe("done");
  const m = getInstalled("mlx-community/Qwen3-4B-Instruct-4bit:mlx")!;
  expect(m.format).toBe("mlx");
  expect([...m.files].sort()).toEqual([...MLX_FILES].sort());
  for (const f of m.files) expect(existsSync(join(repoDir(m.repo), f))).toBe(true);
});

test("an MLX model runs on the MLX engine: default_model, usage in the stream, no llama.cpp slot", async () => {
  process.env.NITI_MLX_SERVER = FAKE_MLX;
  const statuses: { state: string; engine?: string }[] = [];
  const rt = new LocalRuntime((s) => statuses.push({ state: s.state, engine: s.engine }));
  const id = "mlx-community/Qwen3-4B-Instruct-4bit:mlx";
  try {
    const p = new LocalProvider(id, "coder", undefined, undefined, rt);
    const r = await p.send("sys", [{ role: "user", text: "hello" }], [], () => {});
    expect(r.text).toContain("Done");
    expect(r.usage?.inputTokens).toBe(100);
    expect(statuses.map((x) => x.state)).toEqual(["checking", "loading", "ready", "ready"]);
    expect(statuses.every((x) => x.engine === "mlx")).toBe(true);
    const log = await waitFor(() => {
      const f = join(repoDir("mlx-community/Qwen3-4B-Instruct-4bit"), "fakellm.log");
      return existsSync(f) ? readFileSync(f, "utf8") : undefined;
    });
    expect(log).toContain("MLX model=default_model temp=0.7 usage=true slot=none");
    const args = JSON.parse(readFileSync(join(repoDir("mlx-community/Qwen3-4B-Instruct-4bit"), ".fakemlx-args"), "utf8")) as string[];
    expect(args[args.indexOf("--host") + 1]).toBe("127.0.0.1");
    expect(args).not.toContain("--api-key"); // the key travels in the environment, never argv
  } finally {
    rt.stopAll();
    delete process.env.NITI_MLX_SERVER;
  }
});

// A minimal GGUF v3 header: four metadata keys and no tensors.
function ggufBytes(kv: [string, number, string | number][]): Buffer {
  const parts: Buffer[] = [Buffer.from("GGUF"), u32(3), u64(0), u64(kv.length)];
  for (const [k, type, v] of kv) {
    parts.push(str(k), u32(type));
    parts.push(type === 8 ? str(String(v)) : type === 4 ? u32(Number(v)) : u64(Number(v)));
  }
  return Buffer.concat(parts);
  function u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
  function u64(n: number) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
  function str(x: string) { const t = Buffer.from(x, "utf8"); return Buffer.concat([u64(t.length), t]); }
}

test("models already on this Mac are found, added where they are, and removing one leaves its files", async () => {
  const { discoverModels, addFoundModel, ggufMetadata } = await import("./discover.ts");
  const root = process.env.NITI_DISCOVER_DIRS!;
  const mlxDir = join(root, "lmstudio-community", "Coder-7B-Instruct-MLX-4bit");
  mkdirSync(mlxDir, { recursive: true });
  writeFileSync(join(mlxDir, "config.json"), JSON.stringify({ model_type: "qwen2", max_position_embeddings: 32768 }));
  writeFileSync(join(mlxDir, "tokenizer_config.json"), JSON.stringify({ chat_template: TOOLS_TEMPLATE }));
  writeFileSync(join(mlxDir, "model.safetensors"), "weights");
  writeFileSync(join(mlxDir, "README.md"), "# hi");
  const ggufDir = join(root, "bartowski", "Small-3B-GGUF");
  mkdirSync(ggufDir, { recursive: true });
  writeFileSync(join(ggufDir, "Small-3B-Q4_K_M.gguf"), ggufBytes([["general.architecture", 8, "llama"], ["llama.context_length", 4, 8192], ["general.parameter_count", 10, 3_200_000_000], ["tokenizer.chat_template", 8, "{% if tools %}x{% endif %}"]]));
  expect(ggufMetadata(join(ggufDir, "Small-3B-Q4_K_M.gguf"))).toEqual({ architecture: "llama", contextLength: 8192, params: 3_200_000_000, chatTemplate: "{% if tools %}x{% endif %}" });

  const found = discoverModels();
  const mlx = found.find((f) => f.format === "mlx")!;
  const gguf = found.find((f) => f.format === "gguf")!;
  expect(mlx).toMatchObject({ id: "lmstudio-community/Coder-7B-Instruct-MLX-4bit:mlx", params: 7e9, contextLength: 32768, tools: true, added: false });
  expect(mlx.files).not.toContain("README.md");
  expect(gguf).toMatchObject({ id: "bartowski/Small-3B-GGUF:Q4_K_M", params: 3_200_000_000, contextLength: 8192, tools: true });

  const m = addFoundModel(mlx.id);
  expect(m.path).toBe(realpathSync(mlxDir));
  expect(getInstalled(mlx.id)?.format).toBe("mlx");
  expect(discoverModels().find((f) => f.id === mlx.id)?.added).toBe(true);
  expect(() => addFoundModel(mlx.id)).toThrow("already");
  expect(removeInstalled(mlx.id)).toBe(true);
  expect(existsSync(join(mlxDir, "model.safetensors"))).toBe(true); // LM Studio's file is untouched
  expect(getInstalled(mlx.id)).toBeUndefined();
});

test.skipIf(!mlxSupported())("the MLX engine installs from a checksum-pinned Python with hash-locked packages", async () => {
  // A stand-in Python: records what pip was asked to do, and succeeds.
  const build = mkdtempSync(join(tmpdir(), "niti-fakepy-"));
  mkdirSync(join(build, "python", "bin"), { recursive: true });
  writeFileSync(join(build, "python", "bin", "python3"), `#!/bin/sh\necho "$@" > "$(dirname "$0")/../pip-args"\n`, { mode: 0o755 });
  Bun.spawnSync(["tar", "-czf", join(build, "py.tgz"), "-C", build, "python"]);
  const tgz = readFileSync(join(build, "py.tgz"));
  process.env.NITI_MLX_PYTHON_URL = "https://python.example/py.tgz";
  process.env.NITI_MLX_PYTHON_SHA = createHash("sha256").update(tgz).digest("hex");
  const fetchPy = (async () => new Response(tgz, { headers: { "content-length": String(tgz.length) } })) as unknown as typeof fetch;
  const stages: string[] = [];
  try {
    const cmd = await ensureMlxEngine((p) => stages.push(p.stage), fetchPy);
    expect(cmd[1]).toBe(join(process.env.NITI_MLX_ENGINE_DIR!, "niti_mlx_server.py"));
    expect(readFileSync(cmd[1]!, "utf8")).toContain("ModelProvider.load = load");
    const pip = readFileSync(join(process.env.NITI_MLX_ENGINE_DIR!, "python", "pip-args"), "utf8");
    expect(pip).toContain("--require-hashes");
    expect(pip).toContain("--only-binary=:all:");
    expect(readFileSync(join(process.env.NITI_MLX_ENGINE_DIR!, "requirements.txt"), "utf8")).toContain("mlx-lm==");
    expect(stages).toContain("packages");
    expect(stages.at(-1)).toBe("done");
    expect(mlxEngineInstalled()).toBe(true);
    // A tampered download is refused and leaves nothing behind.
    removeMlxEngine();
    process.env.NITI_MLX_PYTHON_SHA = "0".repeat(64);
    await expect(ensureMlxEngine(() => {}, fetchPy)).rejects.toThrow("checksum");
    expect(existsSync(process.env.NITI_MLX_ENGINE_DIR!)).toBe(false);
  } finally {
    delete process.env.NITI_MLX_PYTHON_URL;
    delete process.env.NITI_MLX_PYTHON_SHA;
    removeMlxEngine();
  }
});

test("a local engine that dies is replaced, and an engine error is recognised for a retry", async () => {
  const { engineDied } = await import("./provider.ts");
  expect(engineDied(new Error('404 "generation thread died"'))).toBe(true);
  expect(engineDied(new Error("400 bad request"))).toBe(false);
  process.env.NITI_LLAMA_SERVER = FAKE;
  const id = "unsloth/Qwen3-4B-GGUF:Q4_K_M";
  if (!getInstalled(id)) saveManifest({ id, repo: "unsloth/Qwen3-4B-GGUF", quant: "Q4_K_M", files: ["Qwen3-4B-Q4_K_M.gguf"], bytes: 1, installedAt: 0 });
  writeFileSync(join(repoDir("unsloth/Qwen3-4B-GGUF"), "Qwen3-4B-Q4_K_M.gguf"), "GGUF");
  const rt = new LocalRuntime();
  try {
    const p = new LocalProvider(id, "a", undefined, undefined, rt);
    await p.send("s", [{ role: "user", text: "hi" }], []); // up and serving
    // Kill the server behind the provider's back, as a crash would.
    (rt as unknown as { servers: Map<string, { proc: { kill(): void } }> }).servers.get(id)!.proc.kill();
    await Bun.sleep(300);
    // A dead process is forgotten and a fresh one serves the next request. (A server whose process
    // lives on with a dead generation thread — the MLX case — is what engineDied + stop handle.)
    const r = await p.send("s", [{ role: "user", text: "hi" }], []);
    expect(r.text).toContain("Done");
    expect(rt.status().find((x) => x.model === id)?.state).toBe("ready");
  } finally {
    rt.stopAll();
    delete process.env.NITI_LLAMA_SERVER;
  }
});

test("the model check reads plan lines however they're dressed up", async () => {
  const { parsePlanLines, callOpeners } = await import("./probe.ts");
  expect(parsePlanLines("- **frontend**: build index.html\n2. backend — build server.js with /menu\nreviewer: -", ["frontend", "backend", "reviewer"])).toEqual({ frontend: "build index.html", backend: "build server.js with /menu" });
  expect(parsePlanLines("Sure! Here is the plan.", ["frontend"])).toEqual({});
  expect(callOpeners("{% if tools %}<tool_call>{% endif %}")[0]).toBe('<tool_call>\n{"name": "');
  expect(callOpeners("").at(-1)).toBe('{"name": "');
});

test("a model that never calls a tool is chat only, with the reason", async () => {
  const { probeModel } = await import("./probe.ts");
  const id = "quiet/Talker-GGUF:Q4_K_M";
  saveManifest({ id, repo: "quiet/Talker-GGUF", quant: "Q4_K_M", files: ["t.gguf"], bytes: 1, installedAt: 0 });
  writeFileSync(join(repoDir("quiet/Talker-GGUF"), "t.gguf"), "GGUF");
  // A runtime whose "server" only ever talks (a stand-in, never started).
  const rt = { ensure: async () => ({ baseURL: "http://127.0.0.1:1/v1", apiKey: "k", slot: 0, ctx: 8192, manifest: getInstalled(id)! }), begin() {}, end() {}, stop() {}, register() {}, unregister() {}, onStatus() {} } as never;
  const realSend = LocalProvider.prototype.send;
  LocalProvider.prototype.send = async function () {
    return { text: "I would create hello.txt with the text hi. Here's how you can do it yourself…", toolCalls: [] };
  };
  try {
    const r = await probeModel(id, { runtime: rt });
    expect(r.verdict).toBe("chat-only");
    expect(r.toolMode).toBe("none");
    expect(r.notes[0]).toContain("never called a tool");
    expect(getInstalled(id)!.probe?.verdict).toBe("chat-only");
  } finally {
    LocalProvider.prototype.send = realSend;
  }
});
