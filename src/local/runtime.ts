// Runs the bundled llama.cpp `llama-server` for local agents: one process per loaded model, shared
// by every agent using it, each agent on its own slot so its prompt prefix stays cached between
// turns (re-reading a 20k-token conversation costs tens of seconds on a laptop; a cache hit costs
// nothing). Started on first use, stopped after a quiet spell and when the core exits. It listens on
// 127.0.0.1 only, on a free port, so nothing off this Mac can reach it.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";
import { getInstalled, modelPath, modelsDir, updateManifest, type InstalledModel } from "./store.ts";
import { fitModel, device, MIN_CONTEXT } from "./fit.ts";
import { learnContext } from "../providers/catalog.ts";

export type RuntimeState = "loading" | "ready" | "stopped" | "error";

export interface RuntimeStatus {
  model: string;
  state: RuntimeState;
  ctx?: number; // per slot
  slots?: number;
  error?: string;
}

// Where the server binary is, in the order a user would expect to be honoured: an explicit
// override (tests point this at scripts/e2e/fakellama.ts), the copy bundled beside niti-core in the
// app or npm package, then one on PATH (a developer's `brew install llama.cpp`).
export function findLlamaServer(): string[] | undefined {
  const env = process.env.NITI_LLAMA_SERVER;
  if (env) {
    if (!existsSync(env)) return undefined;
    // A TypeScript stand-in (the tests' fake server) runs under bun.
    return env.endsWith(".ts") ? [Bun.which("bun") ?? process.execPath, env] : [env];
  }
  const here = dirname(process.execPath);
  for (const p of [join(here, "llama", "llama-server"), join(here, "llama-server"), join(here, "../Resources/llama/llama-server")]) {
    if (existsSync(p)) return [p];
  }
  const onPath = Bun.which("llama-server");
  return onPath ? [onPath] : undefined;
}

async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

// Arguments for one server. Kept pure so a test can check what a model is launched with.
export function serverArgs(m: InstalledModel, opts: { port: number; slots: number; ctx: number; log?: string }): string[] {
  return [
    "-m", modelPath(m),
    "--host", "127.0.0.1",
    "--port", String(opts.port),
    "-a", m.id,
    // Tool calling needs the model's own chat template, rendered by the Jinja engine.
    "--jinja",
    // Thoughts go to reasoning_content, never into the answer the user (and the next turn) sees.
    "--reasoning-format", "deepseek",
    "-ngl", "999",
    // One slot per agent, each with the full context. A unified pool would let one agent's long
    // conversation evict another's cache.
    "-np", String(opts.slots),
    "--no-kv-unified",
    "-c", String(opts.ctx * opts.slots),
    // The KV cache stays f16: quantizing it (q4_0 especially) measurably hurts tool calling.
    // Reuse cached chunks even when an earlier part of the conversation changed.
    "--cache-reuse", "256",
    "--no-webui",
    ...(opts.log ? ["--log-file", opts.log] : []),
  ];
}

interface Server {
  model: string;
  proc?: Subprocess;
  port: number;
  slots: number;
  ctx: number;
  ready: Promise<void>;
  state: RuntimeState;
  inFlight: number;
  lastUsed: number;
  slotOf: Map<string, number>; // agent id → slot
  error?: string;
}

const IDLE_MS = Number(process.env.NITI_LOCAL_IDLE_MS ?? 15 * 60_000);

export class LocalRuntime {
  private servers = new Map<string, Server>();
  private wanted = new Map<string, Set<string>>(); // model → agent ids that use it
  private timer?: ReturnType<typeof setInterval>;

  constructor(public onStatus: (s: RuntimeStatus) => void = () => {}) {
    process.on("exit", () => this.stopAll());
  }

  // Agents announce which model they use before their first call, so the server starts with one
  // slot each instead of restarting every time another agent joins.
  register(agentId: string, model: string): void {
    for (const set of this.wanted.values()) set.delete(agentId);
    const set = this.wanted.get(model) ?? new Set<string>();
    set.add(agentId);
    this.wanted.set(model, set);
  }

  status(): RuntimeStatus[] {
    return [...this.servers.values()].map((s) => ({ model: s.model, state: s.state, ctx: s.ctx, slots: s.slots, ...(s.error ? { error: s.error } : {}) }));
  }

  // The model's server, started if needed. Resolves with the address and this agent's slot.
  async ensure(model: string, agentId: string): Promise<{ baseURL: string; slot: number; ctx: number; manifest: InstalledModel }> {
    const manifest = getInstalled(model);
    if (!manifest) throw new Error(`local model '${model}' is not installed — download it from the Models page (or /models in the CLI)`);
    if (!this.wanted.get(model)?.has(agentId)) this.register(agentId, model);
    let s = this.servers.get(model);
    if (!s || s.state === "stopped" || s.state === "error") s = await this.start(manifest);
    await s.ready;
    s.lastUsed = Date.now();
    let slot = s.slotOf.get(agentId);
    if (slot === undefined) {
      slot = s.slotOf.size % s.slots;
      s.slotOf.set(agentId, slot);
    }
    updateManifest(model, { lastUsed: Date.now() });
    return { baseURL: `http://127.0.0.1:${s.port}/v1`, slot, ctx: s.ctx, manifest: getInstalled(model) ?? manifest };
  }

  begin(model: string): void {
    const s = this.servers.get(model);
    if (s) s.inFlight++;
  }

  end(model: string): void {
    const s = this.servers.get(model);
    if (s) {
      s.inFlight = Math.max(0, s.inFlight - 1);
      s.lastUsed = Date.now();
    }
  }

  private async start(m: InstalledModel): Promise<Server> {
    const bin = findLlamaServer();
    if (!bin) throw new Error("the local model runtime (llama-server) is missing — reinstall niti, or `brew install llama.cpp` when running from source");
    const slots = Math.max(1, this.wanted.get(m.id)?.size ?? 1);
    const dev = device();
    // Free memory for this one: a model nobody is using right now gives way.
    for (const other of this.servers.values()) {
      if (other.model !== m.id && other.inFlight === 0) this.stop(other.model);
    }
    const fit = fitModel({ params: m.params ?? 0, fileBytes: m.bytes, quant: m.quant, contextLength: m.contextLength, slots }, dev);
    const ctx = Math.max(MIN_CONTEXT, fit.ctx);
    const port = await freePort();
    mkdirSync(modelsDir(), { recursive: true });
    const args = serverArgs(m, { port, slots, ctx, log: join(modelsDir(), "llama-server.log") });
    const cmd = [...bin, ...args];
    const s: Server = { model: m.id, port, slots, ctx, state: "loading", inFlight: 0, lastUsed: Date.now(), slotOf: new Map(), ready: Promise.resolve() };
    this.servers.set(m.id, s);
    this.onStatus({ model: m.id, state: "loading", ctx, slots });
    s.proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
    const stderr = collect(s.proc.stderr as ReadableStream<Uint8Array>);
    s.ready = (async () => {
      const deadline = Date.now() + Number(process.env.NITI_LOCAL_LOAD_MS ?? 300_000);
      for (;;) {
        if (s.proc!.exitCode !== null || s.proc!.killed) throw new Error(`llama-server exited while loading ${m.id}: ${lastLines(stderr.text())}`);
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
          if (res.ok) break;
        } catch {
          // still starting
        }
        if (Date.now() > deadline) throw new Error(`${m.id} took too long to load`);
        await Bun.sleep(250);
      }
      await this.learn(s, m);
      s.state = "ready";
      this.onStatus({ model: m.id, state: "ready", ctx: s.ctx, slots });
      this.watchIdle();
    })().catch((err) => {
      s.state = "error";
      s.error = err instanceof Error ? err.message : String(err);
      s.proc?.kill();
      this.onStatus({ model: m.id, state: "error", error: s.error });
      throw err;
    });
    // A server that dies on its own (killed, crashed, out of memory) is forgotten, so the next
    // call starts a fresh one instead of talking to a dead port.
    void s.proc.exited.then(() => {
      if (s.state === "ready" && this.servers.get(m.id) === s) {
        this.servers.delete(m.id);
        this.onStatus({ model: m.id, state: "stopped" });
      }
    });
    return s;
  }

  // What the running server says about itself: the real per-slot context (compaction has to fire
  // before it, not before a guess) and whether llama.cpp has a dedicated parser for this model's
  // tool calls or falls back to its generic format.
  private async learn(s: Server, m: InstalledModel): Promise<void> {
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/props`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return;
      const props = (await res.json()) as {
        default_generation_settings?: { n_ctx?: number };
        n_ctx?: number;
        chat_template?: string;
        chat_template_caps?: Record<string, boolean>;
      };
      const nctx = props.default_generation_settings?.n_ctx ?? props.n_ctx;
      if (nctx && nctx > 0) s.ctx = nctx;
      learnContext("local", m.id, s.ctx);
      const caps = props.chat_template_caps;
      const tools = caps ? !!(caps.supports_tools || caps.supports_tool_calls) : /\btools\b/.test(props.chat_template ?? "");
      const toolFormat = !tools ? "none" : /<tool_call>|<function=|\[TOOL_CALLS\]|<\|python_tag\|>|<\|channel\|>|tool_calls/.test(props.chat_template ?? "") ? "native" : "generic";
      updateManifest(m.id, { toolFormat, tools });
    } catch {
      learnContext("local", m.id, s.ctx);
    }
  }

  private watchIdle(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const s of this.servers.values()) {
        if (s.state === "ready" && s.inFlight === 0 && Date.now() - s.lastUsed > IDLE_MS) this.stop(s.model);
      }
    }, Math.min(60_000, IDLE_MS));
    this.timer.unref?.();
  }

  stop(model: string): void {
    const s = this.servers.get(model);
    if (!s) return;
    s.proc?.kill();
    this.servers.delete(model);
    this.onStatus({ model, state: "stopped" });
  }

  stopAll(): void {
    for (const m of [...this.servers.keys()]) this.stop(m);
  }
}

function collect(stream: ReadableStream<Uint8Array> | undefined): { text: () => string } {
  let buf = "";
  if (stream) {
    void (async () => {
      const dec = new TextDecoder();
      try {
        for await (const chunk of stream) buf = (buf + dec.decode(chunk)).slice(-8000);
      } catch {
        // the process went away
      }
    })();
  }
  return { text: () => buf };
}

function lastLines(s: string): string {
  return s.trim().split("\n").slice(-4).join(" | ") || "no output";
}

// One runtime per core: every local agent's provider shares it.
let shared: LocalRuntime | undefined;
export function localRuntime(onStatus?: (s: RuntimeStatus) => void): LocalRuntime {
  shared ??= new LocalRuntime();
  if (onStatus) shared.onStatus = onStatus;
  return shared;
}
