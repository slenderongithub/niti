// End-to-end check of remote control: a real `niti-core serve` in a throwaway project on the fake
// model, the relay (the Bun build of niti-relay), and a headless phone using niti-mobile's own client
// library. The Mac turns remote on with an email and shows a code, the phone pairs by typing it, then
// starts a /goal, sends a note, interrupts an agent, answers an approval, and watches the goal
// finish — and is refused everything a phone must not do.
// Run: bun scripts/e2e/remote.ts (or scripts/e2e/run.sh for everything).
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "../../niti-relay/bun.ts";
import { RemoteClient, type PhoneIdentity } from "../../niti-mobile/src/lib/remote.ts";
import type { PushMessage } from "../../niti-relay/src/room.ts";

const NITI = join(import.meta.dir, "../..");
const LLM = 48500 + Math.floor(Math.random() * 500);
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, ok ? "" : detail]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean | Promise<boolean>, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(100);
  }
  return false;
}

const P = realpathSync(mkdtempSync(join(tmpdir(), "niti-remote-e2e-")));
const state = realpathSync(mkdtempSync(join(tmpdir(), "niti-remote-e2e-state-")));
mkdirSync(join(P, ".niti"));
const tools = ["read_file", "write_file", "edit", "shell", "list_dir", "grep", "glob"];
writeFileSync(
  join(P, ".niti/agents.yaml"),
  `agents:\n` +
    ["backend", "frontend"]
      .map((id, i) => `  - id: ${id}\n    provider: custom\n    model: fake\n    role: ${id}\n    baseURL: http://127.0.0.1:${LLM}/v1\n    systemPrompt: You build ${id}.\n${i === 0 ? "    lead: true\n" : ""}    allowedTools: [${tools.join(", ")}]`)
      .join("\n") + "\nverify: false\n",
);

const pushes: PushMessage[] = [];
const relay = await startRelay({ push: async (m) => void pushes.push(...m) });
const llm = Bun.spawn(["bun", join(import.meta.dir, "fakellm.ts"), String(LLM), state], { stdout: "ignore", stderr: "inherit" });
const env = { ...process.env, NITI_TRUST: "1", NITI_AUTH_FILE: join(state, "auth.json"), NITI_TRUST_FILE: join(state, "trust.json"), NITI_REMOTE_FILE: join(state, "remote.json"), NITI_OFFLINE: "1", NITI_MODELS_FILE: join(state, "models.json") };
const core = Bun.spawn(["bun", "run", join(NITI, "src/cli.ts"), "serve"], { cwd: P, env, stdout: "pipe", stderr: Bun.file(join(state, "core.log")) });
const reader = core.stdout.getReader();
let first = "";
while (!first.includes("\n")) first += new TextDecoder().decode((await reader.read()).value);
const hs = JSON.parse(first.split("\n")[0]!).nitiServer as { url: string; token: string };
const H = { authorization: `Bearer ${hs.token}`, "content-type": "application/json" };
const post = async (p: string, body: unknown = {}) => (await fetch(hs.url + p, { method: "POST", headers: H, body: JSON.stringify(body) })).json() as Promise<any>;
const cmd = (name: string, args = "") => post(`/commands/${name}`, { args }) as Promise<{ ok: boolean; message: string }>;

// The Mac's own view, the way the TUI sees it: every event off /events.
const macEvents: any[] = [];
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
      if (line) macEvents.push(JSON.parse(line.slice(6)));
    }
  }
})().catch(() => {});

let saved: PhoneIdentity | undefined;
const phone = new RemoteClient({ relay: relay.url, name: "Test iPhone", store: { load: async () => saved, save: async (id) => void (saved = id) } });

try {
  // --- the Mac signs in, from the TUI's command line
  const status0 = await cmd("remote");
  check("/remote: off until signed in", status0.message.includes("remote control is off"), status0.message);
  const on = await cmd("remote", `on ada@example.dev --relay ${relay.url}`);
  const code = on.message.match(/code\s+(\d{3}) (\d{3})/)?.slice(1).join("") ?? "";
  check("/remote on <email> shows a code to type on the phone", on.ok && code.length === 6, on.message);
  check("the Mac's relay link comes up", await until(async () => (await post("/session")).remote?.link === "up"));

  // --- the phone pairs by typing it
  const wrong = await phone.pair("ada@example.dev", String((Number(code) + 1) % 1_000_000).padStart(6, "0"));
  check("a wrong code is refused", !wrong.ok && /doesn't match/.test(wrong.error ?? ""), JSON.stringify(wrong));
  const paired = await phone.pair("ada@example.dev", code);
  check("the right code pairs the phone", paired.ok, JSON.stringify(paired));
  check("allowed", await until(() => phone.paired.some((s) => s.online)));
  check("the Mac lists the phone", (await post("/session")).remote?.phones?.[0]?.name === "Test iPhone");
  const sess = phone.paired[0]!;
  const s = await phone.open(sess.mac, sess.session);
  check("the encrypted session opens with a welcome", s.welcome?.project === P.split("/").pop(), JSON.stringify(s.welcome));
  const events: any[] = [];
  s.subscribe(0, (evs) => events.push(...evs));

  // --- what a phone may not do
  check("phone: no credentials", (await s.request("GET", "/auth")).status === 403);
  check("phone: no auto-approve", (await s.request("POST", "/commands/auto")).status === 403);
  check("phone: no /remote", (await s.request("POST", "/commands/remote", { args: "logout" })).status === 403);
  check("phone: no team edits", (await s.request("POST", "/agents", { agents: [] })).status === 403);

  // --- /awake from the phone never pops the Mac's admin dialog
  if (process.platform === "darwin") {
    const aw = await s.request<any>("POST", "/commands/awake");
    check("phone: /awake without the admin dialog (lid-open only)", aw.body.ok && /lid-open|admin prompt declined/.test(aw.body.message), JSON.stringify(aw.body));
  }

  // --- a goal from the phone: approvals answered from the phone, a note, an interrupt
  await post("/auto", { auto: false });
  const g = await s.request<any>("POST", "/commands/goal", { args: "make a page --rounds 4" });
  check("phone starts a /goal", g.body.ok, JSON.stringify(g.body));
  const note = await s.request<any>("POST", "/commands/goal", { args: "note STEER-MARKER keep it small" });
  check("phone sends a note to the goal", note.body.ok, JSON.stringify(note.body));
  let answered = 0;
  let interrupted = false;
  const done = await until(async () => {
    const pending = events.findLast((e) => e.kind === "approval_request")?.requests ?? [];
    for (const r of pending) {
      if (!interrupted && r.agentId) {
        interrupted = (await s.request("POST", `/agents/${r.agentId}/interrupt`, { text: "STEER-MARKER carry on" })).status === 200;
        continue; // the interrupt refuses that request; the agent asks again
      }
      if ((await s.request("POST", "/approval", { ok: true, id: r.id })).status === 200) answered++;
    }
    return events.some((e) => e.kind === "goal" && e.status?.state === "done");
  }, 90_000);
  check("phone answers approvals", answered > 0, String(answered));
  check("phone interrupts an agent", interrupted);
  check("the goal reaches done, watched from the phone", done, JSON.stringify(events.filter((e) => e.kind === "goal").at(-1)?.status));
  check("the Mac's transcript shows what the phone did", events.some((e) => e.kind === "agent_event" && String(e.event.payload).startsWith("📱 Test iPhone")));

  // --- the phone goes away; the Mac pushes it what it needs to know
  phone.stop();
  await until(async () => (await post("/session")).remote?.phones?.every((p: any) => !p.online));
  check("relay status reflects the phone leaving", (await post("/session")).remote?.phones?.[0]?.online === false);

  // --- signing the phone out from the Mac
  const rv = await cmd("remote", "revoke Test iPhone");
  check("/remote revoke", rv.ok && rv.message.includes("signed out"), rv.message);
  await cmd("awake", "off");
} catch (err) {
  check("harness crashed", false, String((err as Error).stack ?? err));
} finally {
  phone.stop();
  core.kill();
  llm.kill();
  relay.stop();
}

const failed = results.filter((r) => !r[1]);
for (const [n, ok, d] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `\n      ${d.slice(0, 600)}` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} passed  (project ${P}, logs ${state})`);
process.exit(failed.length ? 1 : 0);
