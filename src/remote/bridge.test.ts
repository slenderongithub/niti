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
  const pushes: PushMessage[] = [];
  const relay = await startRelay({ push: async (m) => void pushes.push(...m) });
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
  return { relay, pushes, engine, server, bridge, phone, root };
}

// What /remote on <email> shows: the code to type on the phone.
const codeIn = (message: string) => message.match(/code\s+(\d{3}) (\d{3})/)!.slice(1).join("");
const other = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

function stranger(w: Awaited<ReturnType<typeof world>>) {
  let saved: PhoneIdentity | undefined;
  const p = new RemoteClient({ relay: w.relay.url, name: "Stranger", store: { load: async () => saved, save: async (id) => void (saved = id) } });
  cleanup.push(() => p.stop());
  return p;
}

test("pair by typing the Mac's code on the phone, then drive the Mac from it", async () => {
  const w = await world();
  // The Mac signs in: the email is only a name, and it shows a code.
  const on = await w.bridge.signIn("Ada@x.dev", w.relay.url);
  expect(on.ok).toBe(true);
  expect(on.message).toContain("ada@x.dev");
  const code = codeIn(on.message);
  await until(() => w.bridge.state().link === "up", "the Mac's link");

  // A wrong code gets nowhere, and the phone can't open the Mac.
  expect(await w.phone.pair("ada@x.dev", other(code))).toEqual({ ok: false, error: "that code doesn't match the one on your Mac" });
  const s0 = w.phone.snap.sessions[0]!;
  expect(s0.allowed).toBe(false);
  await expect(w.phone.open(s0.mac, s0.session, 500)).rejects.toThrow("isn't paired");

  // The right one pairs it: the Mac allows it, the phone pins the Mac.
  expect(await w.phone.pair("ada@x.dev", code)).toEqual({ ok: true });
  await until(() => w.phone.paired.length === 1, "the phone to be allowed");
  expect(w.bridge.state().phones.map((p) => p.name)).toEqual(["iPhone"]);
  expect(Object.keys(w.phone.id!.macs)).toEqual([s0.mac]);

  // A code is good for one phone.
  expect((await stranger(w).pair("ada@x.dev", code, 1000)).ok).toBe(false);

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
  // Local models are managed at the Mac: no downloads, deletes or catalogue from a phone.
  expect((await s.request("POST", "/local/download", { repo: "a/b", quant: "Q4_K_M" })).status).toBe(403);
  expect((await s.request("GET", "/local/models")).status).toBe(403);
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

  // The Mac loses the channel (its link reconnected): the phone hears so, drops it, and reopens.
  (w.bridge as unknown as { channels: Map<string, unknown> }).channels.clear();
  let dead = false;
  s.onDead = () => (dead = true);
  expect((await s.request("POST", "/session")).status).toBe(0);
  expect([dead, s.ready]).toEqual([true, false]);
  const reopened = await w.phone.open(s0.mac, s0.session);
  expect((await reopened.request("POST", "/session")).status).toBe(200);

  // Signing the phone out on the Mac cuts it off.
  expect(w.bridge.revoke("iPhone")).toContain("signed out");
  await until(() => w.phone.snap.link === "off", "the phone to be cut off");
  expect(w.phone.id).toBeUndefined();
});

test("guessing is capped, a stranger who knows the email gets nowhere, and a phone that isn't connected is pushed approvals", async () => {
  const w = await world();
  const code = codeIn((await w.bridge.signIn("bo@x.dev", w.relay.url)).message);
  await until(() => w.bridge.state().link === "up", "the Mac's link");
  // Five wrong tries and the code stops working, even the right one.
  const phone2 = stranger(w);
  for (let i = 0; i < 5; i++) expect((await phone2.pair("bo@x.dev", other(code))).ok).toBe(false);
  expect((await phone2.pair("bo@x.dev", code, 1000)).ok).toBe(false);
  expect(w.bridge.state().phones).toEqual([]);
  // Registered under the email, it still can't reach the Mac.
  const ss = phone2.snap.sessions[0]!;
  await expect(phone2.open(ss.mac, ss.session, 500)).rejects.toThrow();

  // A new code pairs the real phone.
  const fresh = codeIn(w.bridge.pairCode());
  expect(await w.phone.pair("bo@x.dev", fresh)).toEqual({ ok: true });
  await until(() => w.phone.paired.length === 1, "allowed");
  const s0 = w.phone.paired[0]!;
  const s = await w.phone.open(s0.mac, s0.session);
  w.phone.setPush("ExponentPushToken[bo]", ["approval", "goal"]);
  expect((await s.request("POST", "/commands/remote", { args: "pair" })).status).toBe(403); // a phone can't let another in

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

test("a second niti on the same project takes the phone link, and the first stays off instead of fighting for it", async () => {
  const w = await world();
  expect((await w.bridge.signIn("ada@x.dev", w.relay.url)).ok).toBe(true);
  await until(() => w.bridge.state().link === "up", "the first link");
  const second = new RemoteBridge(w.engine, w.server, { enabled: true, file: join(w.root, "remote.json") });
  cleanup.push(() => second.stop());
  second.start();
  await until(() => second.state().link === "up", "the second link");
  await until(() => w.bridge.state().link === "off", "the first to step aside");
  await Bun.sleep(1500); // past the first reconnect backoff: still off, still second's
  expect([w.bridge.state().link, second.state().link]).toEqual(["off", "up"]);
});
