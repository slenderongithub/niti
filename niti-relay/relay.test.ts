import { test, expect, afterEach } from "bun:test";
import { startRelay } from "./bun.ts";
import { authMessage, deviceId, newDeviceKeys, sign, type ClientFrame, type DeviceKeys, type ServerFrame } from "../src/remote/protocol.ts";
import type { PushMessage } from "./src/room.ts";

let clock = 1_000_000;
const codes = new Map<string, string>();
const pushes: PushMessage[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  pushes.length = 0;
});

async function relay() {
  const r = await startRelay({ mail: async (e, c) => void codes.set(e, c), push: async (m) => void pushes.push(...m), now: () => clock });
  stops.push(r.stop);
  return r;
}

const post = async (url: string, body: unknown) => {
  const res = await fetch(url, { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};

async function signIn(url: string, email: string, kind: "mac" | "phone", name: string, keys = newDeviceKeys()) {
  expect((await post(`${url}/v1/login/start`, { email })).status).toBe(200);
  const r = await post(`${url}/v1/login/verify`, { email, code: codes.get(email), device: { name, kind, signPub: keys.signPub } });
  expect(r.body.ok).toBe(true);
  return { keys, id: deviceId(keys.signPub), account: r.body.account as string };
}

// A raw relay client: authenticates, records every frame, waits for the one it wants.
async function connect(url: string, d: { keys: DeviceKeys; id: string }, session?: string) {
  const ws = new WebSocket(`${url.replace("http", "ws")}/v1/connect?device=${d.id}`);
  const frames: ServerFrame[] = [];
  const waiters: [(f: ServerFrame) => boolean, (f: ServerFrame) => void][] = [];
  let closed: { code: number; reason: string } | undefined;
  ws.onclose = (e) => (closed = { code: e.code, reason: e.reason });
  ws.onmessage = (e) => {
    const f = JSON.parse(String(e.data)) as ServerFrame;
    if (f.t === "challenge") return ws.send(JSON.stringify({ t: "auth", v: 1, sig: sign(d.keys.signSecret, authMessage(f.nonce, d.id)), session }));
    frames.push(f);
    for (const [i, [pred, res]] of waiters.entries()) if (pred(f)) (waiters.splice(i, 1), res(f));
  };
  const next = <T extends ServerFrame["t"]>(t: T, pred: (f: Extract<ServerFrame, { t: T }>) => boolean = () => true) =>
    new Promise<Extract<ServerFrame, { t: T }>>((res, rej) => {
      const hit = frames.find((f) => f.t === t && pred(f as never));
      if (hit) return res(hit as never);
      waiters.push([(f) => f.t === t && pred(f as never), res as never]);
      setTimeout(() => rej(new Error(`no ${t} frame`)), 2000);
    });
  const send = (f: ClientFrame) => ws.send(JSON.stringify(f));
  stops.push(() => ws.close());
  return { ws, frames, next, send, closed: () => closed };
}

test("sign-in: codes are single-use, expire, limit attempts and sends, and a key belongs to one account", async () => {
  const r = await relay();
  const keys = newDeviceKeys();
  const verify = (code: string, k = keys) => post(`${r.url}/v1/login/verify`, { email: "A@x.dev", code, device: { name: "Mac", kind: "mac", signPub: k.signPub } });
  expect((await post(`${r.url}/v1/login/start`, { email: "nope" })).status).toBe(400);
  await post(`${r.url}/v1/login/start`, { email: "a@x.dev" });
  const code = codes.get("a@x.dev")!;
  expect((await verify("000000" === code ? "111111" : "000000")).body.error).toBe("wrong code");
  const ok = await verify(code);
  expect(ok.body.ok).toBe(true);
  expect(ok.body.device.id).toBe(deviceId(keys.signPub));
  expect((await verify(code)).body.ok).toBe(false); // single use

  await post(`${r.url}/v1/login/start`, { email: "a@x.dev" });
  clock += 11 * 60_000;
  expect((await verify(codes.get("a@x.dev")!)).body.error).toContain("expired");

  await post(`${r.url}/v1/login/start`, { email: "b@x.dev" });
  for (let i = 0; i < 5; i++) await post(`${r.url}/v1/login/verify`, { email: "b@x.dev", code: "x", device: { name: "M", kind: "mac", signPub: keys.signPub } });
  expect((await post(`${r.url}/v1/login/verify`, { email: "b@x.dev", code: codes.get("b@x.dev"), device: { name: "M", kind: "mac", signPub: keys.signPub } })).body.error).toContain("too many");
  for (let i = 0; i < 10; i++) await post(`${r.url}/v1/login/start`, { email: "c@x.dev" });
  expect((await post(`${r.url}/v1/login/start`, { email: "c@x.dev" })).body.error).toContain("too many");
  // The same key can't be on two accounts.
  await post(`${r.url}/v1/login/start`, { email: "d@x.dev" });
  expect((await post(`${r.url}/v1/login/verify`, { email: "d@x.dev", code: codes.get("d@x.dev"), device: { name: "M", kind: "mac", signPub: keys.signPub } })).body.error).toContain("another account");
});

test("connecting: an unknown device or a wrong key is refused; a Mac must name its session", async () => {
  const r = await relay();
  expect((await fetch(`${r.url}/v1/connect?device=nobody`)).status).toBe(401);
  const mac = await signIn(r.url, "e@x.dev", "mac", "Mac");
  const forged = await connect(r.url, { keys: newDeviceKeys(), id: mac.id }, "s1");
  await Bun.sleep(100);
  expect(forged.closed()?.code).toBe(4003);
  const nameless = await connect(r.url, mac);
  await Bun.sleep(100);
  expect(nameless.closed()?.code).toBe(4000);
});

test("a phone reaches a Mac session only once that Mac allows it; then frames flow both ways", async () => {
  const r = await relay();
  const mac = await signIn(r.url, "f@x.dev", "mac", "Studio");
  const phone = await signIn(r.url, "f@x.dev", "phone", "iPhone");
  const m = await connect(r.url, mac, "proj1");
  const ready = await m.next("ready");
  expect(ready.devices.map((d) => d.name).sort()).toEqual(["Studio", "iPhone"]);
  const p = await connect(r.url, phone);
  const pr = await p.next("ready");
  expect(pr.sessions).toEqual([expect.objectContaining({ mac: mac.id, session: "proj1", online: true, allowed: false, denied: false })]);
  expect((await m.next("phones", (f) => f.online.includes(phone.id))).online).toEqual([phone.id]);

  p.send({ t: "to", mac: mac.id, session: "proj1", data: "hello?" });
  expect((await p.next("error")).code).toBe("not_allowed");
  m.send({ t: "to", device: phone.id, data: "sneaky" }); // a Mac can't talk to a phone it hasn't allowed either
  // …except to pair: the small cleartext exchange behind the code a person compares.
  p.send({ t: "to", mac: mac.id, session: "proj1", data: '{"p":"commit","c":"x"}' });
  expect(await m.next("from")).toEqual({ t: "from", device: phone.id, data: '{"p":"commit","c":"x"}' });
  m.send({ t: "to", device: phone.id, data: '{"p":"nonce","n":"y"}' });
  expect((await p.next("from")).data).toBe('{"p":"nonce","n":"y"}');
  m.send({ t: "allow", phones: [phone.id] });
  await p.next("sessions", (f) => f.sessions[0]?.allowed === true);
  p.send({ t: "to", mac: mac.id, session: "proj1", data: "hello" });
  expect(await m.next("from", (f) => f.data === "hello")).toEqual({ t: "from", device: phone.id, data: "hello" });
  m.send({ t: "to", device: phone.id, data: "hi back" });
  expect(await p.next("from", (f) => f.data === "hi back")).toEqual({ t: "from", mac: mac.id, session: "proj1", data: "hi back" });
  expect(p.frames.some((f) => f.t === "from" && f.data === "sneaky")).toBe(false);

  // Status: only an allowed phone sees it.
  m.send({ t: "status", blob: "sealed-status", offlineAlert: true });
  expect((await p.next("sessions", (f) => f.sessions[0]?.status === "sealed-status")).sessions[0]!.status).toBe("sealed-status");

  // A denial reaches the phone.
  m.send({ t: "allow", phones: [], denied: [phone.id] });
  expect((await p.next("sessions", (f) => f.sessions[0]?.denied === true)).sessions[0]!.allowed).toBe(false);
});

test("pushes go to allowed phones that aren't connected, by category, and an alerting Mac going offline is pushed", async () => {
  const r = await relay();
  const mac = await signIn(r.url, "g@x.dev", "mac", "Studio");
  const phone = await signIn(r.url, "g@x.dev", "phone", "iPhone");
  const other = await signIn(r.url, "g@x.dev", "phone", "iPad");
  const m = await connect(r.url, mac, "proj1");
  await m.next("ready");
  m.send({ t: "allow", phones: [phone.id, other.id] });
  const p = await connect(r.url, phone);
  await p.next("ready");
  p.send({ t: "pushToken", token: "ExponentPushToken[phone]", categories: ["approval", "offline"] });
  const o = await connect(r.url, other);
  await o.next("ready");
  o.send({ t: "pushToken", token: "ExponentPushToken[ipad]", categories: ["goal"] });
  await Bun.sleep(50);
  o.ws.close();
  p.ws.close();
  await m.next("phones", (f) => f.online.length === 0);

  m.send({ t: "push", category: "approval", title: "Approval needed", body: "backend wants to run shell" });
  await Bun.sleep(50);
  expect(pushes.map((x) => x.to)).toEqual(["ExponentPushToken[phone]"]);

  m.send({ t: "status", blob: "x", offlineAlert: true });
  await Bun.sleep(50);
  m.ws.close();
  await Bun.sleep(50);
  pushes.length = 0;
  await r.alarms(); // not yet three minutes
  expect(pushes).toHaveLength(0);
  clock += 4 * 60_000;
  await r.alarms();
  expect(pushes.map((x) => [x.to, x.title])).toEqual([["ExponentPushToken[phone]", "Studio went offline"]]);
});

test("revoking a device closes its socket and it can't connect again", async () => {
  const r = await relay();
  const mac = await signIn(r.url, "h@x.dev", "mac", "Studio");
  const phone = await signIn(r.url, "h@x.dev", "phone", "iPhone");
  const m = await connect(r.url, mac, "proj1");
  await m.next("ready");
  const p = await connect(r.url, phone);
  await p.next("ready");
  p.send({ t: "revoke", device: mac.id }); // a phone can't sign the Mac out
  expect((await p.next("error")).code).toBe("forbidden");
  m.send({ t: "revoke", device: phone.id });
  await m.next("devices", (f) => !f.devices.some((d) => d.id === phone.id));
  await Bun.sleep(50);
  expect(p.closed()?.code).toBe(4001);
  expect((await fetch(`${r.url}/v1/connect?device=${phone.id}`)).status).toBe(401);
});

test("urlOf reads the path even when Bun drops an IPv6 host's brackets", async () => {
  const { urlOf } = await import("./src/http.ts");
  const u = urlOf({ url: "http://2409:40f0::1:8787/v1/connect?device=abc" } as Request);
  expect([u.pathname, u.searchParams.get("device")]).toEqual(["/v1/connect", "abc"]);
});
