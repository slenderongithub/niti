import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../engine.ts";
import { startServer } from "../server/server.ts";
import { RemoteBridge } from "./bridge.ts";
import { startRelay } from "../../niti-relay/bun.ts";
import { RemoteClient, type PhoneIdentity } from "../../niti-mobile/src/lib/remote.ts";
import type { PushMessage } from "../../niti-relay/src/room.ts";
import type { Provider, ProviderReply } from "../providers/provider.ts";
import type { AgentConfig } from "../agent/agent.ts";

// Remote control end to end, in one process: a real core (engine + HTTP server + bridge), the relay
// running on Bun, and the phone's own client library — everything but the network and the UI.

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c();
});

const until = async (pred: () => boolean, what: string, ms = 4000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

async function world() {
  const codes = new Map<string, string>();
  const pushes: PushMessage[] = [];
  const relay = await startRelay({ mail: async (e, c) => void codes.set(e, c), push: async (m) => void pushes.push(...m) });
  cleanup.push(relay.stop);

  // A worker that writes a file (so there is an approval to answer) and then finishes.
  const fake: Provider = {
    async send(sys, turns): Promise<ProviderReply> {
      const last = turns.at(-1);
      if (sys.includes("LEAD")) {
        if (last && "text" in last && last.text.includes("orchestrator of a team")) return { text: '[{"description":"write it","role":"worker"}]', toolCalls: [] };
        return { text: "integrated", toolCalls: [] };
      }
      if (!turns.some((t) => t.role === "tool")) return { text: "", toolCalls: [{ id: "w", name: "write_file", input: { path: "hello.txt", content: "hi" } }] };
      return { text: "done", toolCalls: [] };
    },
  };
  const configs: AgentConfig[] = [
    { id: "lead", provider: "anthropic", model: "x", role: "Lead", systemPrompt: "LEAD", lead: true, allowedTools: [] },
    { id: "worker", provider: "anthropic", model: "x", role: "Worker", systemPrompt: "WORKER", allowedTools: ["write_file"] },
  ];
  const root = mkdtempSync(join(tmpdir(), "niti-remote-"));
  const engine = new Engine({ configs, makeProvider: () => fake, root, interactive: true, repoMap: false, verify: false, sandbox: false });
  const server = startServer(engine);
  cleanup.push(() => server.stop());
  const bridge = new RemoteBridge(engine, server, { enabled: true, file: join(root, "remote.json") });
  engine.remote = bridge;
  bridge.start();
  cleanup.push(() => bridge.stop());

  let saved: PhoneIdentity | undefined;
  const phone = new RemoteClient({ relay: relay.url, name: "iPhone", store: { load: async () => saved, save: async (id) => void (saved = id) } });
  cleanup.push(() => phone.stop());
  return { relay, codes, pushes, engine, server, bridge, phone, root };
}

test("sign in on both sides, allow the phone once with matching codes, then drive the Mac from it", async () => {
  const w = await world();
  // The Mac signs in.
  expect(await w.bridge.loginStart("ada@x.dev", w.relay.url)).toContain("code is on its way");
  expect((await w.bridge.loginVerify(w.codes.get("ada@x.dev")!)).ok).toBe(true);
  await until(() => w.bridge.state().link === "up", "the Mac's link");

  // The phone signs in with the same email; the Mac asks, once, showing the code the phone shows.
  expect((await w.phone.loginStart("ada@x.dev")).ok).toBe(true);
  expect((await w.phone.loginVerify(w.codes.get("ada@x.dev")!)).ok).toBe(true);
  w.phone.connect();
  await until(() => w.phone.snap.link === "up", "the phone's link");
  await until(() => w.engine.pendingApprovals().some((r) => r.agentId === "remote"), "the allow request on the Mac");
  const ask = w.engine.pendingApprovals().find((r) => r.agentId === "remote")!;
  const mac = w.phone.snap.devices.find((d) => d.kind === "mac")!;
  expect(ask.input.code).toBe(w.phone.codeFor(mac.id)!);
  expect(ask.dangerous).toBe(true); // never covered by an "always allow"

  // Before it is allowed, the phone gets nowhere.
  const s0 = w.phone.snap.sessions[0]!;
  expect(s0.allowed).toBe(false);
  await expect(w.phone.open(s0.mac, s0.session, 500)).rejects.toThrow();

  // The app restarts mid-way: it pairs again, and the Mac's request is replaced by one with the new code.
  w.phone.stop();
  w.phone.connect();
  await until(() => w.engine.pendingApprovals().some((r) => r.agentId === "remote" && r.id !== ask.id), "the replaced allow request");
  expect(w.engine.pendingApprovals().filter((r) => r.agentId === "remote")).toHaveLength(1);
  const again = w.engine.pendingApprovals().find((r) => r.agentId === "remote")!;
  expect(again.input.code).toBe(w.phone.codeFor(mac.id)!);
  expect(w.phone.snap.sessions[0]?.denied).toBe(false); // replaced, not refused

  w.engine.approvals.answer(true, undefined, undefined, again.id);
  await until(() => w.phone.snap.sessions[0]?.allowed === true, "the phone to be allowed");
  expect(w.bridge.state().phones.map((p) => p.name)).toEqual(["iPhone"]);

  const s = await w.phone.open(s0.mac, s0.session);
  expect(s.welcome?.bootId).toBe(w.engine.bootId);

  // The API, through the allowlist.
  const info = await s.request<{ agents: unknown[]; bootId: string }>("POST", "/session");
  expect(info.status).toBe(200);
  expect(info.body.agents).toHaveLength(2);
  expect((await s.request("GET", "/auth")).status).toBe(403);
  expect((await s.request("POST", "/commands/auto")).status).toBe(403);
  expect((await s.request("POST", "/commands/remote", { args: "logout" })).status).toBe(403);
  expect((await s.request("POST", "/complete", { provider: "x", model: "y", prompt: "z" })).status).toBe(403);
  expect((await s.request("POST", "/commands/status")).status).toBe(200);
  expect((await s.request("POST", "/commands/%zz")).status).toBe(403); // malformed, and not on the list

  // The event stream, and an approval answered from the phone.
  const events: any[] = [];
  s.subscribe(0, (evs) => events.push(...evs));
  expect((await s.request("POST", "/prompt", { text: "write hello" })).status).toBe(200);
  await until(() => events.some((e) => e.kind === "approval_request" && e.requests.length > 0), "an approval on the phone");
  const req = events.findLast((e) => e.kind === "approval_request" && e.requests.length > 0).requests[0];
  // A phone can't rewrite the path of what it approves — only the content.
  expect((await s.request("POST", "/approval", { ok: true, id: req.id, edited: { path: "../escape.txt", content: "from the phone" } })).status).toBe(200);
  await until(() => events.some((e) => e.kind === "session" && e.state === "ended"), "the run to end");
  expect(existsSync(join(w.root, "hello.txt"))).toBe(true);
  expect(existsSync(join(w.root, "..", "escape.txt"))).toBe(false);
  // What the phone did shows on the Mac.
  expect(events.some((e) => e.kind === "agent_event" && String(e.event.payload).startsWith("📱 iPhone: approved"))).toBe(true);

  // Signing the phone out on the Mac cuts it off.
  expect(w.bridge.revoke("iPhone")).toContain("signed out");
  await until(() => w.phone.snap.link === "off", "the phone to be cut off");
  expect(w.phone.id).toBeUndefined();
});

test("a phone can't let another device in, and a phone that isn't connected is pushed approvals", async () => {
  const w = await world();
  await w.bridge.loginStart("bo@x.dev", w.relay.url);
  await w.bridge.loginVerify(w.codes.get("bo@x.dev")!);
  await w.phone.loginStart("bo@x.dev");
  await w.phone.loginVerify(w.codes.get("bo@x.dev")!);
  w.phone.connect();
  await until(() => w.engine.pendingApprovals().some((r) => r.agentId === "remote"), "the allow request");
  w.engine.approvals.answer(true, undefined, undefined, w.engine.pendingApprovals()[0]!.id);
  await until(() => w.phone.snap.sessions[0]?.allowed === true, "allowed");
  const s0 = w.phone.snap.sessions[0]!;
  const s = await w.phone.open(s0.mac, s0.session);
  w.phone.setPush("ExponentPushToken[bo]", ["approval", "goal"]);

  // A second phone signs in: the first can't answer the Mac's allow request for it.
  let other: PhoneIdentity | undefined;
  const phone2 = new RemoteClient({ relay: w.relay.url, name: "Stranger", store: { load: async () => other, save: async (id) => void (other = id) } });
  cleanup.push(() => phone2.stop());
  await phone2.loginStart("bo@x.dev");
  await phone2.loginVerify(w.codes.get("bo@x.dev")!);
  phone2.connect();
  await until(() => w.engine.pendingApprovals().some((r) => r.agentId === "remote"), "the second allow request");
  const ask = w.engine.pendingApprovals().find((r) => r.agentId === "remote")!;
  expect((await s.request("POST", "/approval", { ok: true, id: ask.id })).status).toBe(403);
  w.engine.approvals.answer(false, undefined, undefined, ask.id);
  await until(() => phone2.snap.sessions[0]?.denied === true, "the denial to reach the second phone");

  // The first phone goes away; an approval on the Mac is pushed to it.
  phone2.stop();
  w.phone.stop();
  await until(() => w.bridge.state().phones.every((p) => !p.online), "the phones to be offline");
  void w.engine.submit("write hello");
  await until(() => w.pushes.length > 0, "a push");
  expect(w.pushes[0]).toMatchObject({ to: "ExponentPushToken[bo]", title: expect.stringContaining("Approval needed"), body: "worker wants to write a file" });
  expect(w.pushes[0]!.data.route).toBe(`/session/${s0.mac}/${s0.session}?sheet=approval`); // the phone opens straight onto it
  w.engine.cancel();
});
