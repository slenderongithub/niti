import { test, expect } from "bun:test";
import { b64, unb64, Channel, newDeviceKeys, deviceId, Pake, pairTag, newPairCode, isPairFrame, sign, verify, sealStatus, openStatus, newStatusKey, utf8, type ChannelMessage } from "./protocol.ts";

test("base64url round-trips every length", () => {
  for (let n = 0; n < 40; n++) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
    expect([...unb64(b64(bytes))]).toEqual([...bytes]);
    expect(b64(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
  }
  expect(() => unb64("a!b")).toThrow();
});

test("device ids follow the key, and signatures check out", () => {
  const mac = newDeviceKeys();
  const phone = newDeviceKeys();
  expect(deviceId(mac.signPub)).toHaveLength(22);
  expect(deviceId(mac.signPub)).not.toBe(deviceId(phone.signPub));
  const sig = sign(mac.signSecret, "hello");
  expect(verify(mac.signPub, "hello", sig)).toBe(true);
  expect(verify(mac.signPub, "hellO", sig)).toBe(false);
  expect(verify(phone.signPub, "hello", sig)).toBe(false);
});

test("pairing: the same code gives both sides the same key and tags; any other code, or other devices, don't", () => {
  const mac = newDeviceKeys();
  const phone = newDeviceKeys();
  const ctx = `${deviceId(mac.signPub)}:${deviceId(phone.signPub)}`;
  const code = newPairCode();
  expect(code).toMatch(/^\d{6}$/);
  const run = (phoneCode: string, macCode: string, macCtx = ctx) => {
    const p = new Pake(phoneCode, ctx);
    const m = new Pake(macCode, macCtx);
    expect(p.y).not.toBe(m.y);
    const kp = p.key(m.y, p.y, m.y)!;
    const km = m.key(p.y, p.y, m.y)!;
    return { same: b64(kp) === b64(km), tags: [pairTag(kp, "mac", phone.signPub, mac.signPub), pairTag(km, "mac", phone.signPub, mac.signPub)] };
  };
  const ok = run(code, code);
  expect(ok.same).toBe(true);
  expect(ok.tags[0]).toBe(ok.tags[1]!);
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
  expect(run(wrong, code).same).toBe(false);
  expect(run(code, code, `${deviceId(mac.signPub)}:${deviceId(newDeviceKeys().signPub)}`).same).toBe(false); // a code is for one phone and one Mac
  // A tag binds both signing keys: one swapped in by a relay doesn't match.
  const k = new Pake(code, ctx);
  const key = k.key(new Pake(code, ctx).y, k.y, k.y)!;
  expect(pairTag(key, "phone", phone.signPub, mac.signPub)).not.toBe(pairTag(key, "phone", newDeviceKeys().signPub, mac.signPub));
  expect(pairTag(key, "phone", phone.signPub, mac.signPub)).not.toBe(pairTag(key, "mac", phone.signPub, mac.signPub));
  // A degenerate share (all zeros) gives no key.
  expect(k.key(b64(new Uint8Array(32)), k.y, k.y)).toBeUndefined();
  const frame = JSON.stringify({ p: "pake", y: k.y, pub: phone.signPub, t: pairTag(key, "mac", phone.signPub, mac.signPub) });
  expect(isPairFrame(frame)).toBe(true);
  expect(isPairFrame(JSON.stringify({ h: "hello" }))).toBe(false);
});

function pair() {
  const mac = newDeviceKeys();
  const phone = newDeviceKeys();
  const ctx = "mac1:s1:phone1";
  const p = new Channel(ctx, "a", phone.signSecret, mac.signPub);
  const m = new Channel(ctx, "b", mac.signSecret, phone.signPub);
  return { mac, phone, ctx, p, m };
}

test("a channel opens with signed fresh keys and carries messages both ways", () => {
  const { p, m } = pair();
  const answer = m.accept(p.hello());
  expect(answer).toBeDefined();
  expect(p.finish(answer!)).toBe(true);
  const req: ChannelMessage = { k: "req", id: 1, method: "POST", path: "/session" };
  expect(m.unseal(p.seal(req))).toEqual(req);
  const res: ChannelMessage = { k: "res", id: 1, status: 200, body: { ok: true } };
  expect(p.unseal(m.seal(res))).toEqual(res);
});

test("a channel refuses forged handshakes, tampering, replays, and its own frames reflected back", () => {
  const { mac, p, m, ctx } = pair();
  // A hello signed by someone else (a relay posing as the phone).
  const impostor = new Channel(ctx, "a", newDeviceKeys().signSecret, mac.signPub);
  expect(m.accept(impostor.hello())).toBeUndefined();
  // A hello for a different pair can't be replayed into this one.
  const elsewhere = new Channel("mac1:s2:phone1", "a", newDeviceKeys().signSecret, mac.signPub);
  expect(m.accept(elsewhere.hello())).toBeUndefined();

  const answer = m.accept(p.hello())!;
  // An answer to some other hello is refused.
  const other = new Channel(ctx, "a", newDeviceKeys().signSecret, mac.signPub);
  expect(other.finish(answer)).toBe(false);
  expect(p.finish(answer)).toBe(true);

  const sealed = p.seal({ k: "sub", from: 0 });
  expect(m.unseal(sealed)).toEqual({ k: "sub", from: 0 });
  expect(m.unseal(sealed)).toBeUndefined(); // replay
  const raw = unb64(p.seal({ k: "sub", from: 1 }));
  raw[raw.length - 1]! ^= 1;
  expect(m.unseal(b64(raw))).toBeUndefined(); // tampered
  expect(p.unseal(p.seal({ k: "sub", from: 2 }))).toBeUndefined(); // reflected back at its sender
  expect(m.unseal("not base64!")).toBeUndefined();
});

test("a recording of one connection is useless on the next: every connection has its own keys", () => {
  const { mac, phone, ctx, p, m } = pair();
  p.finish(m.accept(p.hello())!);
  const recorded = p.seal({ k: "req", id: 9, method: "POST", path: "/cancel" });
  const p2 = new Channel(ctx, "a", phone.signSecret, mac.signPub);
  const m2 = new Channel(ctx, "b", mac.signSecret, phone.signPub);
  p2.finish(m2.accept(p2.hello())!);
  expect(m2.unseal(recorded)).toBeUndefined();
});

test("the status blob opens only with the status key", () => {
  const key = newStatusKey();
  const blob = sealStatus(key, { goal: "ship it", round: 3 });
  expect(openStatus<object>(key, blob)).toEqual({ goal: "ship it", round: 3 });
  expect(openStatus(newStatusKey(), blob)).toBeUndefined();
  expect(openStatus(key, b64(utf8("garbage-garbage-garbage-garbage")))).toBeUndefined();
});
