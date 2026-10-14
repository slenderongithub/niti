// The app's own client (lib/api.ts) and reducer (lib/reducer.ts), driven against a real niti-core
// and the fake model: every route and flow the app uses, checked through the same code the UI runs.
//   bun scripts/live.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Api } from "../src/renderer/src/lib/api";
import { applyEvents, fromSession, steerTarget, type SessionState } from "../src/renderer/src/lib/reducer";
import type { ServerEvent } from "../src/renderer/src/lib/types";
import { buildAgent } from "../src/renderer/src/features/setup/team";
import { fixture, REPO } from "./fixture";

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, ok ? "" : detail]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${detail}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fx = await fixture();
const P = fx.project;

async function startCore() {
  const core = Bun.spawn(["bun", "run", join(REPO, "src/cli.ts"), "serve"], {
    cwd: P,
    env: { ...process.env, ...fx.env, NITI_TRUST: "1" },
    stdout: "pipe",
    stderr: Bun.file(join(fx.state, "core.log")),
  });
  const reader = core.stdout.getReader();
  let first = "";
  while (!first.includes("\n")) first += new TextDecoder().decode((await reader.read()).value);
  const hs = JSON.parse(first.split("\n")[0]!).nitiServer as { url: string; token: string };
  return { core, api: new Api(hs.url, hs.token) };
}

let { core, api } = await startCore();
let state: SessionState = fromSession(await api.session());
let autoAnswer: ((s: SessionState) => Promise<void>) | null = null;

// The event stream into the reducer, exactly as the app folds it (sse.ts minus EventSource).
let abort = new AbortController();
function stream(from = 0) {
  abort = new AbortController();
  void (async () => {
    try {
      const res = await fetch(api.eventsUrl(from), { signal: abort.signal });
      const rd = res.body!.getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await rd.read();
        if (done) return;
        buf += new TextDecoder().decode(value);
        let i;
        const batch: ServerEvent[] = [];
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (line) batch.push(JSON.parse(line.slice(6)) as ServerEvent);
        }
        if (batch.length) {
          state = applyEvents(state, batch);
          if (autoAnswer && state.approvals.length) await autoAnswer(state);
        }
      }
    } catch {
      /* aborted */
    }
  })();
}
stream();

async function until(pred: (s: SessionState) => boolean, ms = 30_000, what = "condition"): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred(state)) return true;
    await sleep(100);
  }
  console.log(`  (timed out waiting for ${what})`);
  return false;
}

try {
  // --- session, commands, catalog ---------------------------------------------------------------
  check("session: two agents, lead first", state.order.join(",") === "backend,frontend" && state.leadId === "backend", state.order.join(","));
  const cmds = (await api.commands()).commands.map((c) => c.name);
  check("commands: core registry listed", ["rewind", "cost", "debate", "clear", "help"].every((c) => cmds.includes(c)), cmds.join(","));
  const prov = (await api.providers()).providers;
  check("providers: catalog has categories", prov.byok.length > 0 && Array.isArray(prov.local), JSON.stringify(Object.keys(prov)));
  const models = await api.models(prov.byok[0]!.id);
  check("models: a provider lists models", models.models.length > 0, prov.byok[0]!.id);

  // --- auth ----------------------------------------------------------------------------------
  await api.saveCredential({ provider: "openai", type: "api", key: "sk-live-test" });
  const creds = (await api.credentials()).credentials;
  check("auth: a saved key is listed, never echoed", creds.some((c) => c.provider === "openai" && c.type === "api") && !JSON.stringify(creds).includes("sk-live-test"));
  await api.removeCredential("openai");
  check("auth: removing a key", !(await api.credentials()).credentials.some((c) => c.provider === "openai"));

  // --- settings, auto ------------------------------------------------------------------------
  const st = await api.setSettings({ thinkingMode: true, notifyOnDone: false });
  check("settings: booleans persist", st.thinkingMode === true && st.notifyOnDone === false, JSON.stringify(st));
  await api.setSettings({ thinkingMode: false, notifyOnDone: true });
  check("auto: on and off", (await api.setAuto(true)).auto === true && (await api.setAuto(false)).auto === false);
  check("yaml: settings written to agents.yaml", readFileSync(join(P, ".niti/agents.yaml"), "utf8").includes("thinkingMode"));

  // --- plan mode, then run that plan with approvals ---------------------------------------------
  await api.prompt("build a tiny reddit replica", "plan");
  await until((s) => s.tasks.length === 2 && !s.active, 20_000, "plan");
  check("plan: two tasks, nothing ran", state.tasks.length === 2 && state.tasks.every((t) => t.status === "pending") && !existsSync(join(P, "index.html")));

  let answered = 0;
  autoAnswer = async (s) => {
    const req = s.approvals[0]!;
    answered++;
    if (req.tool === "write_file" && String(req.input.path) === "index.html") {
      check("approval: write carries a diff for review", typeof req.input.diff === "string" && String(req.input.diff).includes("+<h1>"));
      await api.approve(true, undefined, { content: "<h1>edited by the app</h1>\n" }); // allow, with an edit
    } else await api.approve(true, "agent");
  };
  await api.prompt("build a tiny reddit replica", "build");
  await until((s) => s.summary !== null && !s.active, 40_000, "run");
  autoAnswer = null;
  check("run: finished with a summary", state.summary?.ok === true, JSON.stringify(state.summary));
  check("run: every task done", state.tasks.every((t) => t.status === "done"), state.tasks.map((t) => t.status).join(","));
  check("approval: both writes asked", answered >= 2, String(answered));
  check("approval: the edited content is what landed", readFileSync(join(P, "index.html"), "utf8") === "<h1>edited by the app</h1>\n");
  const diffs = state.order.flatMap((id) => state.agents[id]!.items).filter((i) => i.kind === "diff");
  check("transcript: writes became diffs", diffs.length >= 2, String(diffs.length));
  check("files: touched marks created files", state.touched["index.html"] === "A" && state.touched["style.css"] === "A", JSON.stringify(state.touched));
  check("usage: totals and cost arrived", state.totals.inputTokens > 0 && state.agents.backend!.usage.calls > 0);
  check("feed/runs: run recorded", state.runs.length === 1);

  // --- read-only routes the pages use ----------------------------------------------------------
  const files = await api.files();
  check("files: project list includes new files", files.files.includes("index.html") && files.files.includes("src/a.ts"), files.files.join(","));
  check("file: content", (await api.file("src/b.ts")).content.includes("export const b"));
  const g = await api.graph();
  check("graph: import edge src/a.ts → src/b.ts", g.edges.some((e) => e.from === "src/a.ts" && e.to === "src/b.ts"), JSON.stringify(g.edges));
  const stats = await api.stats();
  check("stats: per-model history", stats.perModel.length >= 1 && stats.inTokens > 0, JSON.stringify(stats.perModel));
  const cps = (await api.checkpoints()).checkpoints;
  check("checkpoints: one per write", cps.length >= 2, String(cps.length));
  check("sessions: stored", (await api.sessions()).sessions.length >= 1);
  check("worktree: inactive by default", (await api.worktree()).active === false);

  // --- commands with results the app shows ----------------------------------------------------
  const cost = await api.runCommand("cost");
  check("command: /cost answers", cost.ok && cost.message.length > 0, cost.message);
  const rw = await api.runCommand("rewind", "1");
  check("command: /rewind 1", rw.ok, rw.message);
  await until((s) => s.fileEpoch > 0, 3000);
  check("rewind: the last write was undone", !existsSync(join(P, "style.css")) || readFileSync(join(P, "style.css"), "utf8") === "", rw.message);

  // --- steering mid-run, reassign, cancel ------------------------------------------------------
  autoAnswer = async () => void (await api.approve(true));
  await api.prompt("build it again SLOW", "build");
  await until((s) => s.active && s.order.some((id) => s.agents[id]!.status === "working"), 15_000, "a working agent");
  const pending = state.tasks.find((t) => t.status === "pending");
  if (pending) {
    const r = await api.reassign(pending.id, "backend").then(
      () => true,
      () => false,
    );
    check("reassign: a pending task moves", r);
  }
  const to = steerTarget(state);
  const steer = await api.messageAgent(to!, "STEER-MARKER keep it small").then(
    () => "ok",
    (e: Error) => e.message,
  );
  check("steer: a mid-run message is delivered to the working agent", steer === "ok", `${to}: ${steer}`);
  await api.cancel();
  await until((s) => !s.active, 20_000, "cancel");
  check("cancel: the run stops", !state.active);
  autoAnswer = null;

  // --- deny ---------------------------------------------------------------------------------
  autoAnswer = async () => void (await api.approve(false));
  const runsBefore = state.runs.length; // a run cancelled while the lead is still planning leaves no summary
  await api.prompt('CALL:{"name":"write_file","args":{"path":"nope.txt","content":"x"}}END', "build");
  await until((s) => !s.active && s.runs.length > runsBefore, 20_000, "deny run");
  autoAnswer = null;
  check("deny: the file was never written", !existsSync(join(P, "nope.txt")));
  const notApproved = state.order.flatMap((id) => state.agents[id]!.items).some((i) => (i.kind === "tool" && i.status === "fail") || (i.kind === "note" && i.text.includes("not approved")));
  check("deny: the transcript says so", notApproved);

  // --- model switch, team save + restart (what setup does) ---------------------------------------
  const sw = await api.switchModel("frontend", "custom", "fake-2", `http://127.0.0.1:${fx.llmPort}/v1`).then(
    () => "ok",
    (e: Error) => e.message,
  );
  check("model: switch an idle agent", sw === "ok", sw);
  check("model: session reflects it", (await api.session()).agents.find((a) => a.id === "frontend")?.model === "fake-2");

  const used = new Set<string>();
  const team = [
    { ...buildAgent({ provider: "custom", model: "fake", role: "Architect", desc: "Plans.", lead: true }, used), baseURL: `http://127.0.0.1:${fx.llmPort}/v1` },
    { ...buildAgent({ provider: "custom", model: "fake", role: "Builder", desc: "Builds.", lead: false }, used), baseURL: `http://127.0.0.1:${fx.llmPort}/v1` },
    { ...buildAgent({ provider: "custom", model: "fake", role: "Tester", desc: "Tests.", lead: false }, used), baseURL: `http://127.0.0.1:${fx.llmPort}/v1` },
  ];
  const saved = await api.saveAgents(team).then(
    () => "ok",
    (e: Error) => e.message,
  );
  check("team: save a new roster", saved === "ok", saved);
  abort.abort();
  core.kill();
  await core.exited;
  ({ core, api } = await startCore());
  state = fromSession(await api.session());
  stream();
  check("team: a restarted core runs the new roster", state.order.join(",") === "architect,builder,tester" && state.leadId === "architect", state.order.join(","));
  check("team: yaml keeps the rest of the file", readFileSync(join(P, ".niti/agents.yaml"), "utf8").includes("verify: false"));

  await api.prompt("hello there", "build");
  await until((s) => s.order.some((id) => s.agents[id]!.items.some((i) => i.kind === "text")) || s.system.length > 0, 15_000, "a reply");
  check("chat: the new team answers", state.order.some((id) => state.agents[id]!.items.some((i) => i.kind === "text")), JSON.stringify(state.system));

  // /goal: rounds until the judge says done (fakellm: "not yet" once, then "done"), seen through the reducer.
  await api.setAuto(true);
  const goal = await api.runCommand("goal", "build a page --rounds 4");
  check("goal: starts", goal.ok, goal.message);
  check("goal: a prompt is refused while it runs", await api.prompt("something else", "build").then(() => false, () => true));
  await until((s) => s.goalStatus?.state === "done", 60_000, "the goal to finish");
  check("goal: done in two rounds", state.goalStatus?.state === "done" && state.goalStatus.round === 2, JSON.stringify(state.goalStatus));
  await api.setAuto(false);

  const cl = await api.runCommand("clear");
  await until((s) => s.status === "session cleared", 5000, "clear");
  check("command: /clear resets the session view", cl.ok && state.status === "session cleared" && state.order.every((id) => state.agents[id]!.items.length === 0));
} catch (err) {
  check("no exceptions", false, err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  abort.abort();
  core.kill();
  fx.stop();
}

const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed  (project ${P}, core log ${join(fx.state, "core.log")})`);
process.exit(failed.length ? 1 : 0);
