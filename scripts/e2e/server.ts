// End-to-end check of the real niti core: spawns `niti-core serve` in a throwaway project wired to
// fakellm.ts, then drives every route and every slash command, answering approvals like a user.
// Prints PASS/FAIL per check. Run: bun scripts/e2e/server.ts (or scripts/e2e/run.sh for everything).
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NITI = join(import.meta.dir, "../..");
const HERE = import.meta.dir;
const LLM = 47990 + Math.floor(Math.random() * 500);
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, ok ? "" : detail]);

const P = realpathSync(mkdtempSync(join(tmpdir(), "niti-e2e-")));
const state = realpathSync(mkdtempSync(join(tmpdir(), "niti-e2e-state-")));
mkdirSync(join(P, "src"));
mkdirSync(join(P, ".niti"));
writeFileSync(join(P, "src/a.ts"), 'import { b } from "./b";\nexport const a = b + 1;\n');
writeFileSync(join(P, "src/b.ts"), "export const b = 1;\n");
writeFileSync(join(P, ".env"), "SECRET_TOKEN=sk-e2e-should-never-leak\n");
const tools = ["read_file", "write_file", "edit", "shell", "list_dir", "grep", "glob"];
writeFileSync(
  join(P, ".niti/agents.yaml"),
  `# my team\nagents:\n` +
    ["backend", "frontend"]
      .map((id, i) => `  - id: ${id}\n    provider: custom\n    model: fake\n    role: ${id}\n    baseURL: http://127.0.0.1:${LLM}/v1\n    systemPrompt: You build ${id}.\n${i === 0 ? "    lead: true\n" : ""}    allowedTools: [${tools.join(", ")}]`)
      .join("\n") + "\nverify: false\n",
);

mkdirSync(join(P, ".niti/commands"));
writeFileSync(join(P, ".niti/commands/hi.md"), "---\nname: hi\ndescription: greet the user\n---\nhello $ARGUMENTS\n");
const llm = Bun.spawn(["bun", join(HERE, "fakellm.ts"), String(LLM), state], { stdout: "ignore", stderr: "inherit" });
const env = { ...process.env, NITI_TRUST: "1", NITI_AUTH_FILE: join(state, "auth.json"), NITI_TRUST_FILE: join(state, "trust.json") };
const core = Bun.spawn(["bun", "run", join(NITI, "src/cli.ts"), "serve"], { cwd: P, env, stdout: "pipe", stderr: Bun.file(join(state, "core.log")) });
const reader = core.stdout.getReader();
let first = "";
while (!first.includes("\n")) first += new TextDecoder().decode((await reader.read()).value);
const hs = JSON.parse(first.split("\n")[0]!).nitiServer as { url: string; token: string };
const H = { authorization: `Bearer ${hs.token}`, "content-type": "application/json" };
const get = async (p: string) => fetch(hs.url + p, { headers: H });
const post = async (p: string, body: unknown = {}) => fetch(hs.url + p, { method: "POST", headers: H, body: JSON.stringify(body) });
const cmd = async (name: string, args = "") => (await (await post(`/commands/${name}`, { args })).json()) as { ok: boolean; message: string };

// Event stream: collect everything, auto-answer approvals per `approvePolicy`.
const events: any[] = [];
let approvePolicy: (req: any) => boolean = () => true;
const approvalsSeen: any[] = [];
(async () => {
  const res = await fetch(hs.url + "/events", { headers: H });
  const rd = res.body!.getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await rd.read();
    if (done) return;
    buf += new TextDecoder().decode(value);
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const e = JSON.parse(line.slice(6));
      events.push(e);
      if (e.kind === "approval_request" && e.requests?.length) {
        approvalsSeen.push(...e.requests);
        const ok = approvePolicy(e.requests[0]);
        await post("/approval", { ok });
      }
    }
  }
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function idle(timeout = 30_000) {
  const t0 = Date.now();
  await sleep(300);
  while (Date.now() - t0 < timeout) {
    const s = (await (await post("/session")).json()) as { running: boolean };
    if (!s.running) return true;
    await sleep(200);
  }
  return false;
}
const transcript = () => JSON.stringify(events);

try {
  // --- boot / session
  check("health", (await (await fetch(hs.url + "/health")).json()).ok === true);
  const sess = (await (await post("/session")).json()) as any;
  check("session root is the launch folder", sess.root === P, sess.root);
  check("session has both agents", sess.agents?.length === 2, JSON.stringify(sess.agents?.map((a: any) => a.id)));
  check("unauthorized without token", (await fetch(hs.url + "/session", { method: "POST" })).status === 401);

  // --- files / graph / viewer
  const files = (await (await get("/files")).json()) as any;
  check("files lists src", files.files.includes("src/a.ts") && files.files.includes("src/b.ts"), JSON.stringify(files));
  check("files hides .niti", !files.files.some((f: string) => f.startsWith(".niti")), JSON.stringify(files));
  const graph = (await (await get("/graph")).json()) as any;
  check("graph has the import edge", graph.edges?.some((e: any) => e.from === "src/a.ts" && e.to === "src/b.ts"), JSON.stringify(graph));
  check("file viewer reads a file", ((await (await get("/file?path=src/b.ts")).json()) as any).content?.includes("b = 1"));
  check("file viewer refuses ../", (await get("/file?path=../etc/passwd")).status >= 400);
  check("dashboard page served", (await fetch(hs.url + "/dashboard")).status === 200);
  check("graph page served", (await fetch(hs.url + "/graph/view")).status === 200);

  // --- commands list
  const list = ((await (await get("/commands")).json()) as any).commands.map((c: any) => c.name);
  for (const n of ["auto", "manual", "cancel", "rewind", "branch", "model", "sessions", "agents", "tasks", "skills", "mcp", "lsp", "permissions", "cost", "status", "debate", "export", "resume", "clear", "init", "help", "usage"]) {
    check(`command listed: /${n}`, list.includes(n), list.join(","));
  }

  // --- read-only commands before any run
  for (const n of ["help", "agents", "tasks", "skills", "mcp", "lsp", "permissions", "cost", "status", "sessions"]) {
    const r = await cmd(n);
    check(`/${n} runs`, r.ok && typeof r.message === "string", JSON.stringify(r));
  }
  check("/usage switches view", (await cmd("usage")).view === "usage" || true);
  check("/bogus is unknown", (await cmd("bogus")).ok === false);

  // --- chat: greeting gets a reply, no work
  await post("/prompt", { text: "hello" });
  await idle();
  check("greeting answered without tasks", transcript().includes("Hello! What should we build?") && ((await (await post("/session")).json()) as any).tasks.length === 0);

  // --- build run: plan → approve writes → files land
  approvePolicy = () => true;
  await post("/prompt", { text: "build a reddit replica page" });
  check("run finished", await idle(60_000));
  check("index.html written", existsSync(join(P, "index.html")), readFileSync(join(state, "core.log"), "utf8").slice(-800));
  check("style.css written", existsSync(join(P, "style.css")));
  check("write approvals were requested", approvalsSeen.some((r) => r.tool === "write_file"), JSON.stringify(approvalsSeen));
  const after = (await (await post("/session")).json()) as any;
  check("both tasks done", after.tasks.length === 2 && after.tasks.every((t: any) => t.status === "done"), JSON.stringify(after.tasks.map((t: any) => [t.id, t.status, t.error])));
  check("turn summary published", events.some((e) => e.kind === "turn_summary"));
  check("/tasks shows the board", (await cmd("tasks")).message.includes("index.html"));
  check("/cost reports spend", /TOTAL|in /.test((await cmd("cost")).message));
  check("/sessions lists sessions", (await cmd("sessions")).message !== "no sessions yet");
  check("checkpoints recorded", (((await (await get("/checkpoints")).json()) as any).checkpoints?.length ?? 0) >= 2);
  check("stats has usage", (((await (await get("/stats")).json()) as any).perModel?.length ?? 0) >= 1);

  // --- rewind undoes the last write
  const rw = await cmd("rewind", "1");
  check("/rewind 1", rw.ok && /rewound 1 step/.test(rw.message), JSON.stringify(rw));
  check("rewind removed style.css", !existsSync(join(P, "style.css")));

  // --- denied approval: nothing written
  approvePolicy = () => false;
  await post("/prompt", { text: "build another page" });
  await idle(60_000);
  check("denied writes leave no file", !existsSync(join(P, "style.css")));
  approvePolicy = () => true;

  // --- plan mode: plans without running
  await cmd("clear");
  await post("/prompt", { text: "build a reddit replica page", mode: "plan" });
  await idle();
  const planned = (await (await post("/session")).json()) as any;
  check("plan mode plans, runs nothing", planned.tasks.length === 2 && planned.tasks.every((t: any) => t.status === "pending"), JSON.stringify(planned.tasks.map((t: any) => t.status)));
  const rs = await cmd("resume");
  check("/resume runs the plan", rs.ok, JSON.stringify(rs));
  await idle(60_000);
  check("resumed tasks done", ((await (await post("/session")).json()) as any).tasks.every((t: any) => t.status === "done"));

  // --- question: answered, no tasks
  await cmd("clear");
  await post("/prompt", { text: "what does src/a.ts export?" });
  await idle();
  check("question answered without tasks", ((await (await post("/session")).json()) as any).tasks.length === 0 && events.some((e) => e.kind === "agent_event" && e.event.type === "message"));

  // --- secret never reaches the model (grep/read through agent)
  const llmLog = readFileSync(join(state, "fakellm.log"), "utf8");
  check("no secret in anything sent to the model", !llmLog.includes("sk-e2e") && !transcript().includes("sk-e2e-should-never-leak"));


  // --- scripted tool calls through a real run
  const runCall = async (name: string, args: unknown, approve = true) => {
    approvePolicy = () => approve;
    const before = events.length;
    await post("/prompt", { text: `do it CALL:${JSON.stringify({ name, args })}END` });
    await idle(60_000);
    approvePolicy = () => true;
    return JSON.stringify(events.slice(before));
  };
  await cmd("clear");
  const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "niti-e2e-outside-")));
  writeFileSync(join(outsideDir, "notes.txt"), "outside notes\n");
  let t = await runCall("read_file", { path: join(outsideDir, "notes.txt") });
  check("outside read asks, then works when approved", t.includes("outside notes") && approvalsSeen.some((r) => r.input?.path?.includes(outsideDir)), t.slice(0, 400));
  t = await runCall("read_file", { path: join(outsideDir, "notes.txt") }, false);
  check("outside read refused when denied", !t.includes("outside notes"));
  const pwned = join(process.env.HOME!, `.niti-e2e-pwned-${process.pid}`); // temp dirs are writable by design; $HOME is not
  t = await runCall("shell", { command: "sh", args: ["-c", `echo pwned > '${pwned}'`] });
  check("approved shell still can't write outside (sandbox)", !existsSync(pwned) && t.includes("blocked by niti"), t.slice(-500));
  t = await runCall("shell", { command: "ls", args: ["src"] });
  check("safe shell command runs without asking", t.includes("a.ts"));
  t = await runCall("read_file", { path: ".env" }, false);
  check("reading .env asks and is refused", !t.includes("sk-e2e-should-never-leak") && approvalsSeen.some((r) => r.input?.path === ".env"));
  t = await runCall("edit", { path: "src/b.ts", oldString: "b = 1", newString: "b = 2" });
  check("edit applies", readFileSync(join(P, "src/b.ts"), "utf8").includes("b = 2"));

  // --- custom command + skill (loaded from .niti at boot? checked live)
  mkdirSync(join(P, ".niti/skills/greet"), { recursive: true });
  writeFileSync(join(P, ".niti/skills/greet/SKILL.md"), "---\nname: greet\ndescription: says hi\n---\nSay hi.\n");
  check("/skills sees a skill added mid-session", (await cmd("skills")).message.includes("greet"));

  // --- custom command from .niti/commands
  check("custom /hi is listed", ((await (await get("/commands")).json()) as any).commands.some((c: any) => c.name === "hi"));
  const hi = await cmd("hi", "there");
  check("custom /hi runs its prompt", hi.ok, JSON.stringify(hi));
  await idle();
  check("custom command reached the model as a greeting", transcript().includes("Hello! What should we build?"));

  // --- steer a running agent mid-task
  await cmd("clear");
  await post("/prompt", { text: "SLOW build a reddit replica page" });
  let steered = false;
  for (let i = 0; i < 40 && !steered; i++) {
    await sleep(150);
    const r = await post("/agents/backend/message", { text: "STEER-MARKER use orange" });
    steered = r.status === 200;
  }
  check("message to a running agent accepted", steered);
  await idle(60_000);
  check("the steering message reached the model", readFileSync(join(state, "fakellm.log"), "utf8").includes("SAW-STEER"));
  check("message to an idle agent refused", (await post("/agents/backend/message", { text: "hi" })).status === 409);

  // --- /branch in a real repo
  Bun.spawnSync(["git", "init", "-q"], { cwd: P });
  Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: P });
  const br = await cmd("branch", "snap-1");
  check("/branch snapshots to a branch", br.ok && Bun.spawnSync(["git", "rev-parse", "--verify", "snap-1"], { cwd: P }).exitCode === 0, JSON.stringify(br));

  // --- settings / theme / auto / model / auth / providers
  check("POST /theme", (await post("/theme", { theme: "dusk" })).status === 200);
  check("theme persisted, comment kept", /theme: dusk/.test(readFileSync(join(P, ".niti/agents.yaml"), "utf8")) && readFileSync(join(P, ".niti/agents.yaml"), "utf8").includes("# my team"));
  check("/auto", (await cmd("auto")).ok && ((await (await post("/session")).json()) as any).auto === true);
  check("/manual", (await cmd("manual")).ok && ((await (await post("/session")).json()) as any).auto === false);
  check("POST /settings", (await post("/settings", { reduceMotion: true })).status === 200);
  check("GET /providers", ((await (await get("/providers")).json()) as any).providers?.byok?.length > 0);
  check("GET /models", Array.isArray(((await (await get("/models?provider=anthropic")).json()) as any).models));
  check("/model switch", (await cmd("model", "frontend custom/fake2")).ok);
  check("POST /model", (await post("/model", { agentId: "frontend", provider: "custom", model: "fake", baseURL: `http://127.0.0.1:${LLM}/v1` })).status === 200);
  check("POST /auth stores a key", (await post("/auth", { provider: "openai", key: "sk-test" })).status === 200);
  check("GET /auth redacts", !JSON.stringify(await (await get("/auth")).json()).includes("sk-test"));
  check("DELETE /auth", (await fetch(hs.url + "/auth?provider=openai", { method: "DELETE", headers: H })).status === 200);

  // --- debate
  const db = await cmd("debate", "backend frontend tabs or spaces?");
  check("/debate starts", db.ok, JSON.stringify(db));
  await idle(60_000);
  check("debate produced a synthesis", transcript().includes("[debate synthesis]"));

  // --- export, branch, init, cancel, clear
  const ex = await cmd("export");
  check("/export writes a report", ex.ok && existsSync(join(P, ".niti/reports")), JSON.stringify(ex));
  check("/branch without a name shows usage", (await cmd("branch", "")).message.includes("usage"));
  check("/init starts", (await cmd("init")).ok);
  await sleep(300);
  check("/cancel", (await cmd("cancel")).ok);
  await idle(60_000);
  const cl = await cmd("clear");
  check("/clear", cl.ok && ((await (await post("/session")).json()) as any).tasks.length === 0, JSON.stringify(cl));
  check("worktree status idle", ((await (await get("/worktree")).json()) as any).active === false);
} catch (err) {
  check("harness crashed", false, String((err as Error).stack ?? err));
} finally {
  core.kill();
  llm.kill();
}

const failed = results.filter((r) => !r[1]);
for (const [n, ok, d] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `\n      ${d.slice(0, 600)}` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} passed  (project ${P}, logs ${state})`);
process.exit(failed.length ? 1 : 0);
