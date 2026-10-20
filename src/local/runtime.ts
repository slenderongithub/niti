// Runs the bundled llama.cpp `llama-server` for local agents: one process per loaded model, shared
// by every agent using it, each agent on its own slot so its prompt prefix stays cached between
// turns (re-reading a 20k-token conversation costs tens of seconds on a laptop; a cache hit costs
// nothing). Started on first use, stopped after a quiet spell and when the core exits. It listens on
// 127.0.0.1 only, on a free port, so nothing off this Mac can reach it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";
import { getInstalled, modelPath, modelsDir, updateManifest, formatOf, type InstalledModel } from "./store.ts";
import { ensureMlxEngine } from "./mlx.ts";
import { fitModel, device, MIN_CONTEXT } from "./fit.ts";
import { learnContext } from "../providers/catalog.ts";

// "waiting": this model doesn't fit beside the ones in use; it loads when they're idle (`waitingFor`).
export type RuntimeState = "installing" | "waiting" | "loading" | "checking" | "ready" | "stopped" | "error";

export interface RuntimeStatus {
  model: string;
  state: RuntimeState;
  engine?: "llama.cpp" | "mlx";
  ctx?: number; // per slot
  slots?: number;
  error?: string;
  // While the MLX engine installs (its first use): which step, and bytes of the Python download.
  stage?: "python" | "packages";
  received?: number;
  total?: number;
  waitingFor?: string[]; // "waiting": the models holding the memory
  // "stopped": why — "swap" when it made room for another model, "idle" after a quiet spell.
  reason?: "swap" | "idle";
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
  // Running from a checkout: the copy the repo's fetcher left for the app (scripts/llama.ts).
  const checkout = join(import.meta.dir, "../../niti-app/resources", process.arch === "arm64" ? "arm64" : "x64", "llama", "llama-server");
  if (existsSync(checkout)) return [checkout];
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
export function serverArgs(m: InstalledModel, opts: { port: number; slots: number; ctx: number; apiKey?: string; log?: string }): string[] {
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
    // A key only this core knows. The server allows any origin, so without one a web page open in
    // the user's browser could find the port and use the model.
    ...(opts.apiKey ? ["--api-key", opts.apiKey] : []),
    ...(opts.log ? ["--log-file", opts.log] : []),
  ];
}

// The MLX server: niti's wrapper (mlx.ts WRAPPER) around mlx_lm.server. No KV preallocation to
// size — it grows with the conversation; the context niti compacts at is the fitted one.
export function mlxServerArgs(m: InstalledModel, opts: { port: number; concurrency?: number; cacheBytes?: number }): string[] {
  return [
    "--model", modelPath(m),
    "--host", "127.0.0.1",
    "--port", String(opts.port),
    // Browsers get no CORS grant: only niti (which isn't a browser) calls this server.
    "--allowed-origins", "http://127.0.0.1",
    // Agents on one model decode together when there's room (see start), else one at a time.
    "--decode-concurrency", String(opts.concurrency ?? 1),
    "--prompt-concurrency", String(opts.concurrency ?? 1),
    // Cached conversation prefixes are kept within what the weights leave free; unbounded, they
    // grew until the GPU ran out of memory.
    ...(opts.cacheBytes ? ["--prompt-cache-bytes", String(Math.round(opts.cacheBytes))] : []),
    "--log-level", "WARNING",
  ];
}

interface Server {
  model: string;
  proc?: Subprocess;
  port: number;
  slots: number;
  ctx: number;
  apiKey: string;
  ready: Promise<void>;
  state: RuntimeState;
  inFlight: number;
  lastUsed: number;
  slotOf: Map<string, number>; // agent id → slot
  error?: string;
  need: number; // bytes it holds: weights, KV for its slots, overhead (fit.ts)
}

const IDLE_MS = Number(process.env.NITI_LOCAL_IDLE_MS ?? 15 * 60_000);
// A loaded model keeps its memory while its agents are working: through a request, and for this long
// after one (the tool runs between turns). A model waiting for room takes it after that — also when
// the holder is stuck waiting on something else (an approval, a teammate's answer), so two agents
// waiting on each other can't hold the memory forever.
const swapGraceMs = () => Number(process.env.NITI_LOCAL_SWAP_GRACE_MS ?? 30_000);

export class LocalRuntime {
  private servers = new Map<string, Server>();
  private wanted = new Map<string, Set<string>>(); // model → agent ids that use it
  private starting = new Map<string, Promise<Server>>(); // one start per model, however many agents ask
  // Admission and start, one model at a time: two models admitted side by side would each see the
  // memory the other is about to take as free. Also first come, first served.
  private gate: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;

  constructor(public onStatus: (s: RuntimeStatus) => void = () => {}) {
    process.on("exit", () => this.stopAll());
    reapOrphans();
  }

  // Agents announce which model they use before their first call, so the server starts with one
  // slot each instead of restarting every time another agent joins.
  unregister(agentId: string): void {
    for (const set of this.wanted.values()) set.delete(agentId);
  }

  register(agentId: string, model: string): void {
    // The model check (probe.ts) borrows a slot; it isn't an agent and mustn't size the server.
    if (agentId.startsWith("probe:")) return;
    for (const set of this.wanted.values()) set.delete(agentId);
    const set = this.wanted.get(model) ?? new Set<string>();
    set.add(agentId);
    this.wanted.set(model, set);
  }

  status(): RuntimeStatus[] {
    return [...this.servers.values()].map((s) => ({ model: s.model, state: s.state, ctx: s.ctx, slots: s.slots, ...(s.error ? { error: s.error } : {}) }));
  }

  // The model's server, started if needed. Resolves with the address and this agent's slot.
  async ensure(model: string, agentId: string): Promise<{ baseURL: string; apiKey: string; slot: number; ctx: number; manifest: InstalledModel }> {
    const manifest = getInstalled(model);
    if (!manifest) throw new Error(`local model '${model}' is not installed — download it from the Models page (or /models in the CLI)`);
    if (!this.wanted.get(model)?.has(agentId)) this.register(agentId, model);
    let s = this.servers.get(model);
    if (!s || s.state === "stopped" || s.state === "error") {
      let p = this.starting.get(model);
      if (!p) {
        const prev = this.gate;
        let open!: () => void;
        this.gate = new Promise((r) => (open = r));
        p = (async () => {
          await prev;
          try {
            await this.admit(manifest);
            return await this.start(manifest);
          } finally {
            open();
          }
        })().finally(() => this.starting.delete(model));
        this.starting.set(model, p);
      }
      s = await p;
    }
    await s.ready;
    s.lastUsed = Date.now();
    let slot = s.slotOf.get(agentId);
    if (slot === undefined) {
      slot = s.slotOf.size % s.slots;
      s.slotOf.set(agentId, slot);
    }
    updateManifest(model, { lastUsed: Date.now() });
    return { baseURL: `http://127.0.0.1:${s.port}/v1`, apiKey: s.apiKey, slot, ctx: s.ctx, manifest: getInstalled(model) ?? manifest };
  }

  // Done with it for now: it gives way to a model waiting for room without the swap grace.
  release(model: string): void {
    const s = this.servers.get(model);
    if (s && s.inFlight === 0) s.lastUsed = 0;
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

  // What a model will hold once loaded, at the slots it would start with.
  private needOf(m: InstalledModel): number {
    const mlx = formatOf(m) === "mlx";
    const agents = Math.max(1, this.wanted.get(m.id)?.size ?? 1);
    return fitModel({ params: m.params ?? 0, fileBytes: m.bytes, quant: m.quant, contextLength: m.contextLength, slots: mlx ? 1 : agents }, device()).need;
  }

  // Waits until `m` fits beside the models already loaded. Ones that are idle (no request for the
  // swap grace) give way at once; ones in use are waited for. Models that fit together stay loaded
  // together. A model too big for this Mac on its own still loads once it is alone.
  private async admit(m: InstalledModel): Promise<void> {
    const budget = device().gpuBudget;
    const need = this.needOf(m);
    let announced = false;
    for (;;) {
      const others = [...this.servers.values()].filter((o) => o.model !== m.id);
      const held = (xs: Server[]) => xs.reduce((n, o) => n + o.need, 0);
      if (need + held(others) <= budget) return;
      const busy = (o: Server) => o.state === "loading" || o.inFlight > 0 || Date.now() - o.lastUsed < swapGraceMs();
      // Make room from the idle ones, largest first, only as much as is needed.
      for (const o of others.filter((x) => !busy(x)).sort((a, b) => b.need - a.need)) {
        if (need + held([...this.servers.values()].filter((x) => x.model !== m.id)) <= budget) break;
        this.stop(o.model, "swap");
      }
      const left = [...this.servers.values()].filter((o) => o.model !== m.id);
      if (need + held(left) <= budget || left.length === 0) return;
      if (!announced) {
        announced = true;
        this.onStatus({ model: m.id, state: "waiting", waitingFor: left.map((o) => o.model) });
      }
      await Bun.sleep(400);
    }
  }

  private async start(m: InstalledModel): Promise<Server> {
    const mlx = formatOf(m) === "mlx";
    const bin = mlx ? undefined : findLlamaServer();
    if (!mlx && !bin) throw new Error("the local model runtime (llama-server) is missing — reinstall niti, or `brew install llama.cpp` when running from source");
    // MLX: its engine arrives on first use. Every agent waiting on this model waits on the install.
    const mlxCmd = mlx
      ? await ensureMlxEngine((p) => {
          if (p.stage === "python" || p.stage === "packages") this.onStatus({ model: m.id, engine: "mlx", state: "installing", stage: p.stage, received: p.received, total: p.total });
        })
      : undefined;
    const agents = Math.max(1, this.wanted.get(m.id)?.size ?? 1);
    // The MLX server batches agents onto one model itself: two decode together only when two
    // contexts fit comfortably, otherwise they take turns (a big model on a 16 GB Mac ran out of
    // memory mid-batch and the engine's generation thread died).
    const slots = mlx ? (agents > 1 && fitModel({ params: m.params ?? 0, fileBytes: m.bytes, quant: m.quant, contextLength: m.contextLength, slots: 2 }, device()).tier === "runs-well" ? 2 : 1) : agents;
    const dev = device();
    const fit = fitModel({ params: m.params ?? 0, fileBytes: m.bytes, quant: m.quant, contextLength: m.contextLength, slots }, dev);
    const ctx = Math.max(MIN_CONTEXT, fit.ctx);
    const port = await freePort();
    mkdirSync(modelsDir(), { recursive: true });
    const apiKey = crypto.randomUUID();
    const cmd = mlx ? [...mlxCmd!, ...mlxServerArgs(m, { port, concurrency: slots, cacheBytes: Math.max(256 * 1024 ** 2, Math.min(4 * 1024 ** 3, dev.gpuBudget - m.bytes - 1.5 * 1024 ** 3)) })] : [...bin!, ...serverArgs(m, { port, slots, ctx, apiKey, log: join(modelsDir(), "llama-server.log") })];
    const s: Server = { model: m.id, port, slots, ctx, apiKey, state: "loading", inFlight: 0, lastUsed: Date.now(), slotOf: new Map(), ready: Promise.resolve(), need: fit.need };
    this.servers.set(m.id, s);
    this.onStatus({ model: m.id, engine: mlx ? "mlx" : "llama.cpp", state: "loading", ctx, slots });
    // The MLX wrapper reads its key from the environment, never the command line (which ps shows).
    s.proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe", env: mlx ? { ...process.env, NITI_MLX_KEY: apiKey, PYTHONNOUSERSITE: "1" } : undefined });
    recordPids([...this.servers.values()].map((x) => x.proc?.pid).filter((p): p is number => !!p));
    const stderr = collect(s.proc.stderr as ReadableStream<Uint8Array>, mlx ? join(modelsDir(), "mlx-server.log") : undefined);
    s.ready = (async () => {
      const deadline = Date.now() + Number(process.env.NITI_LOCAL_LOAD_MS ?? 300_000);
      for (;;) {
        if (s.proc!.exitCode !== null || s.proc!.killed) throw new Error(`${mlx ? "the MLX engine" : "llama-server"} exited while loading ${m.id}: ${lastLines(stderr.text())}`);
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
          if (res.ok) break;
        } catch {
          // still starting
        }
        if (Date.now() > deadline) throw new Error(`${m.id} took too long to load`);
        await Bun.sleep(250);
      }
      if (mlx) learnContext("local", m.id, s.ctx);
      else await this.learn(s, m);
      s.state = "ready";
      this.onStatus({ model: m.id, engine: mlx ? "mlx" : "llama.cpp", state: "ready", ctx: s.ctx, slots });
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
      const res = await fetch(`http://127.0.0.1:${s.port}/props`, { signal: AbortSignal.timeout(3000), headers: { authorization: `Bearer ${s.apiKey}` } });
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
        if (s.state === "ready" && s.inFlight === 0 && Date.now() - s.lastUsed > IDLE_MS) this.stop(s.model, "idle");
      }
    }, Math.min(60_000, IDLE_MS));
    this.timer.unref?.();
  }

  stop(model: string, reason?: "swap" | "idle"): void {
    const s = this.servers.get(model);
    if (!s) return;
    s.proc?.kill();
    this.servers.delete(model);
    recordPids([...this.servers.values()].map((x) => x.proc?.pid).filter((p): p is number => !!p));
    this.onStatus({ model, state: "stopped", ...(reason ? { reason } : {}) });
  }

  stopAll(): void {
    for (const m of [...this.servers.keys()]) this.stop(m);
  }
}

// A core killed outright (SIGKILL, a crash) never runs its exit hook, and the llama-server it
// started would hold gigabytes of memory until reboot. The running servers' pids are kept beside the
// models; the next runtime stops any that are still llama-server processes (checked by name, so a
// recycled pid belonging to something else is never touched).
const pidFile = () => join(modelsDir(), "runtime.pids");

function recordPids(pids: number[]): void {
  try {
    mkdirSync(modelsDir(), { recursive: true });
    writeFileSync(pidFile(), JSON.stringify({ owner: process.pid, pids }));
  } catch {
    // best effort
  }
}

export function reapOrphans(): number {
  let reaped = 0;
  try {
    const { owner, pids } = JSON.parse(readFileSync(pidFile(), "utf8")) as { owner: number; pids: number[] };
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // Another core that is still running owns these: leave them.
    if (owner !== process.pid && alive(owner)) return 0;
    for (const pid of pids) {
      if (!alive(pid)) continue;
      const comm = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]).stdout.toString();
      if (!/llama-server|niti_mlx_server|fakellama|fakemlx/.test(comm)) continue;
      process.kill(pid, "SIGTERM");
      reaped++;
    }
    recordPids([]);
  } catch {
    // no record, or unreadable: nothing to reap
  }
  return reaped;
}

// The server's stderr: the last 8 KB kept for an error message, and (`log`) everything appended to a
// file — the MLX engine reports a dying generation thread only there.
function collect(stream: ReadableStream<Uint8Array> | undefined, log?: string): { text: () => string } {
  let buf = "";
  if (stream) {
    void (async () => {
      const dec = new TextDecoder();
      try {
        for await (const chunk of stream) {
          const text = dec.decode(chunk);
          buf = (buf + text).slice(-8000);
          if (log) appendFileSync(log, text);
        }
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
