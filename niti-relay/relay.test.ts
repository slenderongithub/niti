import { test, expect, afterEach } from "bun:test";
import { startRelay } from "./bun.ts";
import { authMessage, deviceId, newDeviceKeys, PROTOCOL, registerMessage, sign, type ClientFrame, type DeviceKeys, type ServerFrame } from "../src/remote/protocol.ts";
import type { PushMessage } from "./src/room.ts";

let clock = 1_000_000;
const pushes: PushMessage[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  pushes.length = 0;
});

async function relay() {
  const r = await startRelay({ push: async (m) => void pushes.push(...m), now: () => clock });
  stops.push(r.stop);
  return r;
}

const post = async (url: string, body: unknown) => {
  const res = await fetch(url, { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};

const reg = (url: string, email: string, kind: "mac" | "phone", name: string, keys: DeviceKeys) =>
  post(`${url}/v1/register`, { email, device: { name, kind, signPub: keys.signPub, sig: sign(keys.signSecret, registerMessage(email, kind, keys.signPub)) } });

async function signIn(url: string, email: string, kind: "mac" | "phone", name: string, keys = newDeviceKeys()) {
  const r = await reg(url, email, kind, name, keys);
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
    if (f.t === "challenge") return ws.send(JSON.stringify({ t: "auth", v: PROTOCOL, sig: sign(d.keys.signSecret, authMessage(f.nonce, d.id)), session }));
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

test("registering: needs the device's own signature; the same key is the same device; a full account makes room from devices nobody allowed", async () => {
  const r = await relay();
  const keys = newDeviceKeys();
  expect((await reg(r.url, "nope", "mac", "Mac", keys)).status).toBe(400);
  // Knowing a public key isn't enough to register (or move) that device.
  const forged = await post(`${r.url}/v1/register`, { email: "x@x.dev", device: { name: "M", kind: "mac", signPub: keys.signPub, sig: sign(newDeviceKeys().signSecret, registerMessage("x@x.dev", "mac", keys.signPub)) } });
  expect(forged.body.error).toBe("bad device signature");
  const a = await reg(r.url, "A@x.dev", "mac", "Mac", keys);
  expect(a.body.device.id).toBe(deviceId(keys.signPub));
  expect((await reg(r.url, "a@x.dev", "mac", "Mac 2", keys)).body.account).toBe(a.body.account); // same email, same key: same device
  // An account at its cap drops the oldest device no Mac has allowed, never an allowed one.
  const phone = await signIn(r.url, "a@x.dev", "phone", "iPhone");
  await r.accounts.setAllowed(a.body.account, deviceId(keys.signPub), [phone.id]);
  for (let i = 0; i < 25; i++) expect((await reg(r.url, "a@x.dev", "phone", `junk ${i}`, newDeviceKeys())).body.ok).toBe(true);
  const ids = (await r.accounts.devices(a.body.account)).map((d) => d.id);
  expect(ids).toHaveLength(20);
  expect(ids).toContain(deviceId(keys.signPub));
  expect(ids).toContain(phone.id);
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
  expect(pr.sessions).toEqual([expect.objectContaining({ mac: mac.id, session: "proj1", online: true, allowed: false })]);
  expect((await m.next("phones", (f) => f.online.includes(phone.id))).online).toEqual([phone.id]);

  p.send({ t: "to", mac: mac.id, session: "proj1", data: "hello?" });
  expect((await p.next("error")).code).toBe("not_allowed");
  m.send({ t: "to", device: phone.id, data: "sneaky" }); // a Mac can't talk to a phone it hasn't allowed either
  // …except to pair: the small cleartext exchange over the code typed on the phone.
  p.send({ t: "to", mac: mac.id, session: "proj1", data: '{"p":"pake","y":"a","pub":"b"}' });
  expect(await m.next("from")).toEqual({ t: "from", device: phone.id, data: '{"p":"pake","y":"a","pub":"b"}' });
  m.send({ t: "to", device: phone.id, data: '{"p":"pake","y":"c","pub":"d","t":"e"}' });
  expect((await p.next("from")).data).toBe('{"p":"pake","y":"c","pub":"d","t":"e"}');
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

  // Taken back: the phone sees it isn't allowed, and once the Mac is offline it doesn't see it at all.
  m.send({ t: "allow", phones: [] });
  expect((await p.next("sessions", (f) => f.sessions[0]?.allowed === false)).sessions[0]!.status).toBeUndefined();
  m.ws.close();
  await p.next("sessions", (f) => f.sessions.length === 0);
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
