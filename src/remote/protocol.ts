import nacl from "tweetnacl";

// The remote-control wire protocol, shared by the core (src/remote/bridge.ts), the relay
// (niti-relay/) and the phone (niti-mobile/). Pure TypeScript on tweetnacl, so the same file runs
// under Bun, in a Cloudflare Worker and in React Native.
//
// Two layers:
//   relay frames — JSON over one WebSocket per device, read by the relay: who is talking to whom,
//                  presence, push, the device list. Never any content.
//   channel      — inside a relay frame's `data`: a Mac session and a phone, end-to-end encrypted
//                  with keys made fresh on every connection and signed with each side's long-term
//                  key. The relay sees opaque base64.

export const PROTOCOL = 2;

// ---- encoding --------------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

// base64url without padding. Hand-rolled because React Native has no Buffer and btoa is binary-string based.
export function b64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += B64[n & 63]!;
  }
  return out;
}

export function unb64(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => (i + k < s.length ? B64_INDEX.get(s[i + k]!) : 0));
    if (v.some((x) => x === undefined)) throw new Error("bad base64");
    const n = (v[0]! << 18) | (v[1]! << 12) | (v[2]! << 6) | v[3]!;
    out[o++] = (n >> 16) & 255;
    if (i + 2 < s.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < s.length) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

// TextEncoder/TextDecoder where the runtime has them; React Native's engine may not have the decoder,
// so there is a plain fallback (escape/unescape do the UTF-8 byte mapping).
const g = globalThis as { TextEncoder?: typeof TextEncoder; TextDecoder?: typeof TextDecoder; escape?: (s: string) => string; unescape?: (s: string) => string };
export const utf8 = (s: string): Uint8Array =>
  g.TextEncoder ? new g.TextEncoder().encode(s) : Uint8Array.from(g.unescape!(encodeURIComponent(s)), (c) => c.charCodeAt(0));
export function fromUtf8(b: Uint8Array): string {
  if (g.TextDecoder) return new g.TextDecoder().decode(b);
  let bin = "";
  for (let i = 0; i < b.length; i += 8192) bin += String.fromCharCode(...b.subarray(i, i + 8192)); // spread in chunks: a whole frame overflows the call stack
  return decodeURIComponent(g.escape!(bin));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---- identity --------------------------------------------------------------------------------

// A device's long-term key: ed25519, which signs the relay's challenge and every connection's
// handshake. The secret never leaves the device.
export interface DeviceKeys {
  signPub: string;
  signSecret: string;
}

export function newDeviceKeys(): DeviceKeys {
  const s = nacl.sign.keyPair();
  return { signPub: b64(s.publicKey), signSecret: b64(s.secretKey) };
}

// A device is named by its signing key, so an id can't be claimed without the key behind it.
export function deviceId(signPub: string): string {
  return b64(nacl.hash(unb64(signPub))).slice(0, 22);
}

export function sign(secret: string, msg: string): string {
  return b64(nacl.sign.detached(utf8(msg), unb64(secret)));
}

export function verify(pub: string, msg: string, sig: string): boolean {
  try {
    return nacl.sign.detached.verify(utf8(msg), unb64(sig), unb64(pub));
  } catch {
    return false;
  }
}

// Pairing: the Mac shows a 6-digit code and the phone types it in. The code itself never travels:
// both sides run CPace (a password-authenticated key exchange, draft-irtf-cfrg-cpace, over X25519)
// with it, so nothing that passes through the relay lets anyone test a guess offline; each guess
// needs a live try, and the Mac allows five per code. The key they land on then vouches for both
// devices' long-term keys, which each side pins from then on.
//   phone → Mac   { p: "pake", y, pub }        its CPace share and signing key
//   Mac → phone   { p: "pake", y, pub, t }     the same, and a tag only the right code produces
//   phone → Mac   { p: "confirm", t }          the phone's tag: the Mac allows it
export type PairMessage = { p: "pake"; y: string; pub: string; t?: string } | { p: "confirm"; t: string };

// Pairing frames travel in the clear through the relay, the only thing it forwards between a Mac
// and a phone the Mac hasn't allowed.
export const isPairFrame = (data: string): boolean => data.length <= 300 && data.startsWith('{"p":');

export const newPairCode = (): string => String(new DataView(nacl.randomBytes(4).buffer).getUint32(0) % 1_000_000).padStart(6, "0");

const P = 2n ** 255n - 19n;
const A = 486662n;
const mod = (x: bigint) => ((x % P) + P) % P;
function pow(b: bigint, e: bigint): bigint {
  let r = 1n;
  b = mod(b);
  for (; e > 0n; e >>= 1n, b = (b * b) % P) if (e & 1n) r = (r * b) % P;
  return r;
}
const le = (b: Uint8Array) => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);
const toLe = (n: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 255n));

// The code (and who is pairing with whom) hashed to a point on Curve25519 by Elligator 2 (RFC 9380
// 6.7.1, Z = 2), as the u-coordinate X25519 works on. ponytail: not constant-time, which only
// matters to someone timing this device during the ten minutes a code lives.
function generator(code: string, ctx: string): Uint8Array {
  const r = mod(le(nacl.hash(utf8(`niti-cpace-v1:${ctx}:${code}`)).subarray(0, 32)) & ((1n << 255n) - 1n));
  const t = mod(2n * r * r);
  const x1 = mod(-A * pow(t === P - 1n ? 1n : t + 1n, P - 2n));
  const square = (x: bigint) => x === 0n || pow(x, (P - 1n) / 2n) === 1n;
  return toLe(square(mod(x1 * (x1 * x1 + A * x1 + 1n))) ? x1 : mod(-x1 - A));
}

const zero = (b: Uint8Array) => b.every((x) => x === 0);

// One side of a pairing. `ctx` is `${macId}:${phoneId}`, so a code works only between those two.
export class Pake {
  private secret = nacl.randomBytes(32);
  readonly y: string;
  constructor(code: string, ctx: string) {
    this.y = b64(nacl.scalarMult(this.secret, generator(code, ctx)));
  }

  // The key both sides share when they used the same code; undefined for a degenerate share.
  key(peerY: string, phoneY: string, macY: string): Uint8Array | undefined {
    try {
      const k = nacl.scalarMult(this.secret, unb64(peerY));
      return zero(k) ? undefined : nacl.hash(concat(utf8("niti-cpace-sk"), k, unb64(phoneY), unb64(macY))).subarray(0, 32);
    } catch {
      return undefined;
    }
  }
}

// What each side sends to prove it holds the key, over both devices' signing keys: a Mac and a phone
// that agree on the tags agree on who the other is.
export const pairTag = (key: Uint8Array, role: "mac" | "phone", phonePub: string, macPub: string): string =>
  b64(nacl.hash(concat(key, utf8(`niti-pair-tag:${role}:${phonePub}:${macPub}`))).subarray(0, 32));

export const randomId = (bytes = 16) => b64(nacl.randomBytes(bytes));

// ---- relay frames ----------------------------------------------------------------------------

export type DeviceKind = "mac" | "phone";

export interface DeviceInfo {
  id: string;
  name: string;
  kind: DeviceKind;
  signPub: string;
}

// One live core on a Mac: a project, for as long as that core runs.
export interface SessionInfo {
  mac: string; // the Mac's device id
  session: string; // per core boot
  online: boolean;
  lastSeen: number;
  status?: string; // the latest encrypted status blob (see sealStatus)
  allowed: boolean; // this Mac has allowed the phone asking
}

export type ClientFrame =
  | { t: "auth"; v: number; sig: string; session?: string } // sig = sign(nonce + deviceId); a Mac names its core's session
  | { t: "to"; mac?: string; session?: string; device?: string; data: string } // phone → a Mac session, or Mac → a phone
  | { t: "allow"; phones: string[] } // Mac: the phones it has allowed, all of them, every time it changes
  | { t: "status"; blob: string; offlineAlert: boolean } // Mac: what a phone shows while this session is offline
  | { t: "push"; category: PushCategory; title: string; body: string; route?: string } // Mac: notify its allowed phones
  | { t: "pushToken"; token: string; categories: PushCategory[] } // phone: where and what to push
  | { t: "revoke"; device: string } // any device: sign one of the account's devices out
  | { t: "ping" };

export type ServerFrame =
  | { t: "challenge"; nonce: string; v: number }
  | { t: "ready"; you: DeviceInfo; devices: DeviceInfo[]; sessions: SessionInfo[]; phonesOnline: string[] }
  | { t: "from"; mac?: string; session?: string; device?: string; data: string }
  | { t: "devices"; devices: DeviceInfo[] } // the account's devices changed (a sign-in, a revoke)
  | { t: "sessions"; sessions: SessionInfo[] } // to phones: Mac sessions came, went or updated
  | { t: "phones"; online: string[] } // to Macs: which phones are connected right now
  | { t: "error"; code: string; message: string }
  | { t: "pong" };

export type PushCategory = "approval" | "goal" | "error" | "offline";
export const PUSH_CATEGORIES: PushCategory[] = ["approval", "goal", "error", "offline"];

export const authMessage = (nonce: string, id: string) => `niti-relay-auth-v1:${nonce}:${id}`;
// Registering a device under an account is signed with that device's key: knowing a public key isn't
// enough to move the device somewhere else.
export const registerMessage = (email: string, kind: DeviceKind, signPub: string) => `niti-relay-register-v1:${email.trim().toLowerCase()}:${kind}:${signPub}`;

// ---- the encrypted channel -------------------------------------------------------------------

// What travels inside a channel, once decrypted.
export type ChannelMessage =
  | { k: "req"; id: number; method: string; path: string; body?: unknown } // phone → Mac: one API call
  | { k: "res"; id: number; status: number; body: unknown } // Mac → phone
  | { k: "sub"; from: number } // phone → Mac: stream events after this seq
  | { k: "events"; events: unknown[] } // Mac → phone: ServerEvents, in order
  | { k: "welcome"; mac: string; project: string; bootId: string; statusKey: string; version: string }; // Mac → phone, first thing

// The handshake, in the clear but signed: each side sends a fresh x25519 key signed with its
// long-term signing key, bound to the other side's fresh key so a recorded one can't be replayed.
export interface Hello {
  h: "hello";
  v: number;
  eph: string;
  sig: string;
  peer?: string; // the other side's eph this answers (the Mac's reply)
}

const helloMessage = (eph: string, ctx: string, peer = "") => `niti-hello-v1:${ctx}:${eph}:${peer}`;

// The Mac's answer to a sealed frame for a channel it no longer has (its core restarted, or its link
// to the relay reconnected): the phone drops its side and opens a fresh channel. In the clear and
// unsigned, so at worst a relay can make a phone reconnect.
export const CHANNEL_RESET = '{"h":"reset"}';

export class Channel {
  private key?: Uint8Array;
  private sendCtr = 0;
  private recvCtr = -1;
  private eph = nacl.box.keyPair();

  // `ctx` binds the handshake to one pair: `${macId}:${session}:${phoneId}`. `me` is "a" for the
  // phone (it opens), "b" for the Mac — the nonce's direction byte, so the two directions never
  // share a nonce under the one key.
  constructor(
    private ctx: string,
    private me: "a" | "b",
    private mySignSecret: string,
    private peerSignPub: string,
  ) {}

  get open(): boolean {
    return this.key !== undefined;
  }

  // Phone: the opening hello.
  hello(): Hello {
    const eph = b64(this.eph.publicKey);
    return { h: "hello", v: PROTOCOL, eph, sig: sign(this.mySignSecret, helloMessage(eph, this.ctx)) };
  }

  // Mac: check the phone's hello, derive the key, and answer. Undefined when the signature is wrong.
  accept(peer: Hello): Hello | undefined {
    if (peer.v !== PROTOCOL || !verify(this.peerSignPub, helloMessage(peer.eph, this.ctx), peer.sig)) return undefined;
    this.derive(peer.eph);
    const eph = b64(this.eph.publicKey);
    return { h: "hello", v: PROTOCOL, eph, peer: peer.eph, sig: sign(this.mySignSecret, helloMessage(eph, this.ctx, peer.eph)) };
  }

  // Phone: check the Mac's answer. False when it isn't signed by the Mac it pinned, or answers some other hello.
  finish(peer: Hello): boolean {
    const mine = b64(this.eph.publicKey);
    if (peer.v !== PROTOCOL || peer.peer !== mine || !verify(this.peerSignPub, helloMessage(peer.eph, this.ctx, mine), peer.sig)) return false;
    this.derive(peer.eph);
    return true;
  }

  private derive(peerEph: string): void {
    this.key = nacl.box.before(unb64(peerEph), this.eph.secretKey);
    this.sendCtr = 0;
    this.recvCtr = -1;
  }

  seal(msg: ChannelMessage): string {
    if (!this.key) throw new Error("channel not open");
    const nonce = this.nonce(this.me, this.sendCtr++);
    return b64(concat(nonce, nacl.secretbox(utf8(JSON.stringify(msg)), nonce, this.key)));
  }

  // Undefined for anything forged, tampered with, replayed or out of order.
  unseal(data: string): ChannelMessage | undefined {
    if (!this.key) return undefined;
    let raw: Uint8Array;
    try {
      raw = unb64(data);
    } catch {
      return undefined;
    }
    if (raw.length < 24 + nacl.secretbox.overheadLength) return undefined;
    const nonce = raw.subarray(0, 24);
    const dir = this.me === "a" ? "b" : "a";
    if (nonce[0] !== dir.charCodeAt(0)) return undefined;
    const ctr = Number(new DataView(nonce.buffer, nonce.byteOffset + 1, 8).getBigUint64(0));
    if (ctr <= this.recvCtr) return undefined;
    const plain = nacl.secretbox.open(raw.subarray(24), nonce, this.key);
    if (!plain) return undefined;
    this.recvCtr = ctr;
    try {
      return JSON.parse(fromUtf8(plain)) as ChannelMessage;
    } catch {
      return undefined;
    }
  }

  private nonce(dir: "a" | "b", ctr: number): Uint8Array {
    const n = new Uint8Array(24);
    n[0] = dir.charCodeAt(0);
    new DataView(n.buffer).setBigUint64(1, BigInt(ctr));
    return n;
  }
}

// ---- the status blob -------------------------------------------------------------------------

// A Mac's latest goal state, stored by the relay so a phone has something to show while the Mac is
// offline. Sealed with a key the Mac hands each phone it allows (in the welcome), never the relay.
export function sealStatus(statusKey: string, status: unknown): string {
  const nonce = nacl.randomBytes(24);
  return b64(concat(nonce, nacl.secretbox(utf8(JSON.stringify(status)), nonce, unb64(statusKey))));
}

export function openStatus<T = unknown>(statusKey: string, blob: string): T | undefined {
  try {
    const raw = unb64(blob);
    const plain = nacl.secretbox.open(raw.subarray(24), raw.subarray(0, 24), unb64(statusKey));
    return plain ? (JSON.parse(fromUtf8(plain)) as T) : undefined;
  } catch {
    return undefined;
  }
}

export const newStatusKey = () => b64(nacl.randomBytes(32));
