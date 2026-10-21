// The local-models matrix: a real niti core runs the coffee-shop goal with a two-agent team on models
// from the fake zoo (fakezoo.ts) — every kind of lead against every kind of worker, on both engines —
// and each run is held to what "works" means for local models:
//   1. a plan with work for every teammate that can build, published before any task starts;
//   2. every task done and the project passing niti's acceptance checks — or, where nobody can
//      build, a reply that says so (never a silent "done");
//   3. no prose dumps, template tokens or thinking in the chat;
//   4. chat-only models never get a task;
//   5. two models that don't fit in memory together are never loaded at once.
// No network, no model, no cost. Default: each persona leads once and works once, per engine (24
// runs, plus all-chat-only). --full: every lead × every worker (450). --only=<lead>,<worker>.
//   bun scripts/e2e/local-matrix.ts [--full] [--only=fence,lazy] [--engine=gguf|mlx] [--jobs=4]
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERSONAS, type Persona } from "./fakezoo.ts";

const NITI = join(import.meta.dir, "../..");
const HERE = import.meta.dir;
const GB = 1024 ** 3;
const GOAL = "make me a stunning coffee shop landing page for Bean There, end-to-end deployment ready";
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const full = process.argv.includes("--full");
const jobs = Number(arg("jobs") ?? 4);
const engines = (arg("engine") ? [arg("engine")] : ["gguf", "mlx"]) as ("gguf" | "mlx")[];

type Scenario = { lead: Persona; worker: Persona; engine: "gguf" | "mlx" };
const pairs: [Persona, Persona][] = arg("only")
  ? [arg("only")!.split(",") as [Persona, Persona]]
  : full
    ? PERSONAS.flatMap((l) => PERSONAS.map((w) => [l, w] as [Persona, Persona]))
    : [...PERSONAS.map((p, i) => [p, PERSONAS[(i + 3) % PERSONAS.length]!] as [Persona, Persona]), ["chatty", "chatty"]];
const scenarios: Scenario[] = engines.flatMap((engine) => pairs.map(([lead, worker]) => ({ lead, worker, engine })));

const modelId = (p: Persona, engine: "gguf" | "mlx") => (engine === "gguf" ? `zoo/${p}-GGUF:Q4_K_M` : `zoo/${p}-MLX-4bit:mlx`);

// Installs a zoo model straight into a models folder: its manifest and stand-in files.
function install(models: string, p: Persona, engine: "gguf" | "mlx") {
  const id = modelId(p, engine);
  const [repo, quant] = id.split(":") as [string, string];
  const dir = join(models, repo.replace("/", "__"));
  mkdirSync(dir, { recursive: true });
  const base = { id, repo, quant, bytes: 6 * GB, params: 7e9, contextLength: 32_768, installedAt: Date.now(), tools: p !== "chatty", ...(p === "thinker" ? { thinking: true } : {}) };
  if (engine === "gguf") {
    writeFileSync(join(dir, "m.gguf"), "GGUF");
    writeFileSync(join(dir, `manifest.${quant}.json`), JSON.stringify({ ...base, files: ["m.gguf"] }));
  } else {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ model_type: "qwen2", max_position_embeddings: 32768 }));
    writeFileSync(join(dir, "tokenizer_config.json"), JSON.stringify({ chat_template: "{% if tools %}<tool_call>{{ tools }}</tool_call>{% endif %}" }));
    writeFileSync(join(dir, "model.safetensors"), "weights");
    writeFileSync(join(dir, `manifest.${quant}.json`), JSON.stringify({ ...base, format: "mlx", files: ["config.json", "tokenizer_config.json", "model.safetensors"] }));
  }
}

async function run(s: Scenario): Promise<{ s: Scenario; fails: string[]; dir: string }> {
  const P = realpathSync(mkdtempSync(join(tmpdir(), "niti-matrix-")));
  const state = realpathSync(mkdtempSync(join(tmpdir(), "niti-matrix-state-")));
  const models = join(state, "local-models");
  install(models, s.lead, s.engine);
  if (s.worker !== s.lead) install(models, s.worker, s.engine);
  mkdirSync(join(P, ".niti"));
  const tools = "[read_file, write_file, edit, shell, grep, glob]";
  writeFileSync(
    join(P, ".niti/agents.yaml"),
    `agents:\n` +
      `  - id: backend\n    provider: local\n    model: ${modelId(s.lead, s.engine)}\n    role: Backend\n    systemPrompt: You build the server side.\n    lead: true\n    allowedTools: ${tools}\n` +
      `  - id: frontend\n    provider: local\n    model: ${modelId(s.worker, s.engine)}\n    role: Frontend\n    systemPrompt: You build the pages and their look.\n    allowedTools: ${tools}\n` +
      `verify: false\n`,
  );
  const env = {
    ...process.env,
    NITI_TRUST: "1",
    NITI_OFFLINE: "1",
    NITI_AUTH_FILE: join(state, "auth.json"),
    NITI_TRUST_FILE: join(state, "trust.json"),
    NITI_REMOTE_FILE: join(state, "remote.json"),
    NITI_MODELS_FILE: join(state, "models.json"),
    NITI_VERSION_FILE: join(state, "version.json"),
    NITI_LOCAL_MODELS_DIR: models,
    NITI_DISCOVER_DIRS: join(state, "found"),
    NITI_MLX_ENGINE_DIR: join(state, "mlx-engine"),
    NITI_LLAMA_SERVER: join(HERE, "fakellama.ts"),
    NITI_MLX_SERVER: join(HERE, "fakemlx.ts"),
    NITI_HF_URL: "http://127.0.0.1:9",
    // A Mac where two 6 GB models don't fit together; models give way quickly.
    NITI_GPU_BUDGET: String(10 * GB),
    NITI_LOCAL_SWAP_GRACE_MS: "300",
  };
  const core = Bun.spawn(["bun", "run", join(NITI, "src/cli.ts"), "serve"], { cwd: P, env, stdout: "pipe", stderr: Bun.file(join(state, "core.log")) });
  const fails: string[] = [];
  const fail = (m: string) => fails.push(m);
  try {
    const reader = core.stdout.getReader();
    let first = "";
    while (!first.includes("\n")) first += new TextDecoder().decode((await reader.read()).value);
    const hs = JSON.parse(first.split("\n")[0]!).nitiServer as { url: string; token: string };
    const H = { authorization: `Bearer ${hs.token}`, "content-type": "application/json" };
    const post = (p: string, body: unknown = {}) => fetch(hs.url + p, { method: "POST", headers: H, body: JSON.stringify(body) });
    const events: any[] = [];
    void (async () => {
      const res = await fetch(hs.url + "/events", { headers: H });
      const rd = res.body!.getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await rd.read();
        if (done) return;
        buf += new TextDecoder().decode(value);
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
          buf = buf.slice(i + 2);
          if (!line) continue;
          const e = JSON.parse(line.slice(6));
          events.push(e);
          if (e.kind === "approval_request" && e.requests?.length) await post("/approval", { ok: true });
        }
      }
    })().catch(() => {}); // the stream ends when the core is stopped
    await Bun.sleep(300);
    await post("/prompt", { text: GOAL });
    const t0 = Date.now();
    await Bun.sleep(500);
    let finished = false;
    while (Date.now() - t0 < 240_000) {
      const st = (await (await post("/session")).json()) as { running: boolean };
      if (!st.running) {
        finished = true;
        break;
      }
      await Bun.sleep(300);
    }
    if (!finished) fail("the run didn't finish within 4 minutes");

    const orch = events.filter((e) => e.kind === "orchestration").map((e) => e.event);
    const agentEvents = events.filter((e) => e.kind === "agent_event").map((e) => e.event);
    const plan = orch.find((e) => e.type === "plan");
    const firstStart = orch.findIndex((e) => e.type === "task_started");
    const chatOnly = new Set([s.lead === "chatty" && "backend", s.worker === "chatty" && "frontend"].filter(Boolean) as string[]);
    const builders = ["backend", "frontend"].filter((a) => !chatOnly.has(a));

    if (!builders.length) {
      // 2. nobody can build: said so, nothing started.
      const said = agentEvents.some((e) => e.type === "message" && /can't change files|can change files|don't call tools/i.test(e.payload));
      if (!said) fail("an all-chat-only team wasn't told it can't build");
      if (plan) fail("an all-chat-only team got a plan");
    } else {
      // 1. a plan with work for every builder, before work starts.
      if (!plan) fail("no plan was published");
      else {
        if (firstStart >= 0 && orch.indexOf(plan) > firstStart) fail("the plan was published after work started");
        const owners = new Set(plan.tasks.map((t: any) => t.role));
        for (const b of builders) if (!owners.has(b)) fail(`${b} got no task (plan: ${plan.tasks.map((t: any) => `${t.role}: ${t.description.split("\n")[0].slice(0, 50)}`).join(" | ")})`);
        // 4. chat-only models get no tasks.
        for (const c of chatOnly) if (owners.has(c)) fail(`chat-only ${c} was given a task`);
      }
      // 2. everything done, and the project passes the checks.
      const done = orch.filter((e) => e.type === "task_done");
      const failed = done.filter((e) => !e.ok);
      if (failed.length) {
        const errs = agentEvents.filter((e) => e.type === "error").map((e) => `${e.agentId}: ${String(e.payload).slice(0, 160)}`);
        fail(`${failed.length} task(s) failed: ${errs.join(" || ") || "(no error event — a silent failure)"}`);
      } else if (plan && done.length < plan.tasks.length) fail(`only ${done.length} of ${plan.tasks.length} tasks finished`);
      const { acceptWork } = await import("../../src/agent/accept.ts");
      const a = await acceptWork(P, { task: `Check that the parts your teammates built fit together, and fix what doesn't.\n\n(Part of the request: ${GOAL})`, written: [] });
      const bad = a.checks.filter((c) => !c.ok);
      if (!failed.length && bad.length) fail(`finished, but the project fails: ${bad.map((c) => c.detail?.split("\n")[0] ?? c.name).join(" | ")}`);
    }
    // 3. nothing in the chat a person shouldn't see.
    for (const e of agentEvents.filter((x) => x.type === "message")) {
      const t = String(e.payload);
      if (/```|<\|im_|<\|end|<think>|<tool_call>|<function=/.test(t) || t.length > 1500) {
        fail(`${e.agentId} said in the chat: ${JSON.stringify(t.slice(0, 120))}`);
        break;
      }
    }
    // 5. never two models that don't fit loaded at once.
    if (s.lead !== s.worker) {
      let loaded = 0;
      let most = 0;
      for (const e of events.filter((x) => x.kind === "local_runtime")) {
        if (e.runtime.state === "loading") most = Math.max(most, ++loaded);
        if (e.runtime.state === "stopped" || e.runtime.state === "error") loaded = Math.max(0, loaded - 1);
      }
      if (most > 1) fail(`${most} models were loaded at once on a Mac with room for one`);
    }
  } catch (err) {
    fail(`harness: ${(err as Error).stack ?? err}`);
  } finally {
    core.kill();
    await core.exited;
    // Servers the core started, if it didn't get to stop them.
    const pids = join(models, "runtime.pids");
    if (existsSync(pids)) {
      for (const pid of readFileSync(pids, "utf8").split(/\s+/).map(Number).filter((n) => n > 0)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // gone
        }
      }
    }
  }
  return { s, fails, dir: `${P} (state ${state})` };
}

const queue = [...scenarios];
const results: Awaited<ReturnType<typeof run>>[] = [];
const label = (s: Scenario) => `${s.engine.padEnd(4)} lead=${s.lead.padEnd(10)} worker=${s.worker.padEnd(10)}`;
await Promise.all(
  Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const r = await run(s);
      results.push(r);
      console.log(`${r.fails.length ? "FAIL" : "PASS"}  ${label(s)}${r.fails.length ? `\n      ${r.fails.join("\n      ")}\n      ${r.dir}` : ""}`);
    }
  }),
);
const failed = results.filter((r) => r.fails.length);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
