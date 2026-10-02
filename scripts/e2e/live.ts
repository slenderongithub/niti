// A live smoke test against a real model — costs a few cents. Spawns `niti-core serve` in a throwaway
// project with two agents on a real provider (the key from your niti auth store), then: greet, build
// something small with every approval answered yes, ask a question, check spend and export.
//   bun scripts/e2e/live.ts [provider/model]       default google/gemini-flash-lite-latest
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NITI = join(import.meta.dir, "../..");
const [provider, model] = (process.argv[2] ?? "google/gemini-flash-lite-latest").split("/") as [string, string];
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, ok ? "" : detail]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${detail.slice(0, 500)}`}`);
};

const P = realpathSync(mkdtempSync(join(tmpdir(), "niti-live-")));
mkdirSync(join(P, ".niti"));
writeFileSync(
  join(P, ".niti/agents.yaml"),
  "agents:\n" +
    [["builder", "Builder — writes the HTML", true], ["stylist", "Stylist — writes the CSS", false]]
      .map(([id, role, lead]) => `  - id: ${id}\n    provider: ${provider}\n    model: ${model}\n    role: ${role}\n    systemPrompt: You are the ${role}. Do your task directly, then stop.\n${lead ? "    lead: true\n" : ""}    allowedTools: [read_file, write_file, edit, list_dir, glob, grep, shell]`)
      .join("\n") + "\nverify: false\n",
);

const core = Bun.spawn(["bun", "run", join(NITI, "src/cli.ts"), "serve"], { cwd: P, env: { ...process.env, NITI_TRUST: "1" }, stdout: "pipe", stderr: Bun.file(join(P, "core-stderr.log")) });
const reader = core.stdout.getReader();
let first = "";
while (!first.includes("\n")) first += new TextDecoder().decode((await reader.read()).value);
const hs = JSON.parse(first.split("\n")[0]!).nitiServer as { url: string; token: string };
const H = { authorization: `Bearer ${hs.token}`, "content-type": "application/json" };
const post = (p: string, body: unknown = {}) => fetch(hs.url + p, { method: "POST", headers: H, body: JSON.stringify(body) });
const cmd = async (name: string, args = "") => (await (await post(`/commands/${name}`, { args })).json()) as { ok: boolean; message: string };
const session = async () => (await (await post("/session")).json()) as any;

const events: any[] = [];
(async () => {
  const rd = (await fetch(hs.url + "/events", { headers: H })).body!.getReader();
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
})();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function idle(timeout: number) {
  const t0 = Date.now();
  await sleep(500);
  while (Date.now() - t0 < timeout) {
    if (!(await session()).running) return true;
    await sleep(1000);
  }
  return false;
}
const errors = () => events.filter((e) => e.kind === "agent_event" && e.event.type === "error").map((e) => e.event.payload);
const said = (since: number) => events.slice(since).filter((e) => e.kind === "agent_event" && e.event.type === "message").map((e) => e.event.payload).join("\n");

try {
  let mark = events.length;
  await post("/prompt", { text: "hi!" });
  await idle(60_000);
  check("greeting gets a reply and no work", said(mark).length > 0 && (await session()).tasks.length === 0, JSON.stringify(errors()));

  mark = events.length;
  await post("/prompt", { text: "Build a tiny Reddit-style page: index.html with a header 'niti reddit' and three example posts, and style.css that gives it an orange header. Plain HTML/CSS only." });
  check("build run finishes", await idle(300_000));
  const s = await session();
  check("index.html written", existsSync(join(P, "index.html")), JSON.stringify(errors()));
  check("style.css written", existsSync(join(P, "style.css")), JSON.stringify(s.tasks?.map((t: any) => [t.id, t.status, t.error])));
  check("page mentions 'niti reddit'", existsSync(join(P, "index.html")) && /niti reddit/i.test(readFileSync(join(P, "index.html"), "utf8")));
  check("every task done", s.tasks.length > 0 && s.tasks.every((t: any) => t.status === "done"), JSON.stringify(s.tasks?.map((t: any) => [t.id, t.status, t.error])));
  check("run summary card", events.slice(mark).some((e) => e.kind === "turn_summary"));

  await cmd("clear");
  mark = events.length;
  await post("/prompt", { text: "What color is the header in style.css?" });
  await idle(120_000);
  const answer = said(mark);
  check("question answered from the code, no tasks", /orange|#f|rgb/i.test(answer) && (await session()).tasks.length === 0, answer.slice(0, 300));

  const cost = await cmd("cost");
  check("/cost shows priced spend", /TOTAL \$\d/.test(cost.message), cost.message);
  const ex = await cmd("export");
  check("/export writes a report", ex.ok && existsSync(join(P, ".niti/reports")) && readdirSync(join(P, ".niti/reports")).length > 0, ex.message);
  // A failed tool call (an edit whose oldString missed) is fed back to the model to correct — that is
  // the loop working. Anything else in the error stream is not.
  const unexpected = errors().filter((e: string) => !/^(read_file|write_file|edit|list_dir|glob|grep|shell): /.test(e));
  check("no errors outside recoverable tool calls", unexpected.length === 0, JSON.stringify(unexpected));
} catch (err) {
  check("harness crashed", false, String((err as Error).stack ?? err));
} finally {
  core.kill();
}
const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} passed  (project ${P})`);
process.exit(failed ? 1 : 0);
