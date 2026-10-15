import { authMessage, Channel, CHANNEL_RESET, deviceId, isPairFrame, newDeviceKeys, openStatus, Pake, pairTag, PROTOCOL, registerMessage, sign, type PairMessage, type ChannelMessage, type DeviceInfo, type DeviceKeys, type Hello, type PushCategory, type ServerFrame, type SessionInfo } from "../../../src/remote/protocol.ts";

// The phone's side of remote control: pair with a Mac by typing the code it shows, see the paired
// Macs and their projects, and open an end-to-end encrypted session with one to drive its niti. Plain TypeScript
// with no React Native imports, so the end-to-end check drives the same code under Bun.

export interface PhoneIdentity {
  relay: string;
  email: string;
  name: string;
  keys: DeviceKeys;
  statusKeys: Record<string, string>; // per Mac, from its welcome: opens the status it leaves on the relay
  macs: Record<string, string>; // the Macs this phone paired with: id → signing key. Only these are ever opened.
}

export interface IdentityStore {
  load(): Promise<PhoneIdentity | undefined>;
  save(id: PhoneIdentity | undefined): Promise<void>;
}

export interface RemoteSnapshot {
  link: "off" | "connecting" | "up";
  me?: DeviceInfo;
  devices: DeviceInfo[];
  sessions: SessionInfo[];
  error?: string;
}

type WS = { readyState: number; send(d: string): void; close(code?: number, reason?: string): void; onopen: unknown; onmessage: ((e: { data: unknown }) => void) | null; onclose: ((e: { code: number; reason: string }) => void) | null; onerror: unknown };
type WSCtor = new (url: string) => WS;

async function post(relay: string, path: string, body: unknown): Promise<{ ok: boolean; error?: string; account?: string; device?: DeviceInfo }> {
  try {
    const res = await fetch(relay.replace(/\/$/, "") + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as never;
  } catch (err) {
    return { ok: false, error: `couldn't reach ${relay}: ${err instanceof Error ? err.message : err}` };
  }
}

export class RemoteClient {
  id?: PhoneIdentity;
  snap: RemoteSnapshot = { link: "off", devices: [], sessions: [] };
  private ws?: WS;
  private stopped = true;
  private backoff = 1000;
  private retry?: ReturnType<typeof setTimeout>;
  private conns = new Map<string, Session>(); // `${mac}:${session}`
  private pakes = new Map<string, { pake: Pake; done: (r: "paired" | "wrong") => void }>(); // `${mac}:${session}` while pairing
  private listeners = new Set<(s: RemoteSnapshot) => void>();

  constructor(
    private o: { relay: string; name: string; store: IdentityStore; WebSocket?: WSCtor },
  ) {}

  onChange(fn: (s: RemoteSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snap);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<RemoteSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn(this.snap);
  }

  async restore(): Promise<boolean> {
    const id = await this.o.store.load();
    this.id = id?.macs ? id : undefined; // from before pairing by code: pair again
    return !!this.id;
  }

  // Pair with the Mac showing `code` (/remote on <email> there). The first time, this registers the
  // phone under the email, which is only a name: nothing is sent to it.
  async pair(email: string, code: string, timeoutMs = 10_000): Promise<{ ok: boolean; error?: string }> {
    const clean = email.trim().toLowerCase();
    if (!this.id || this.id.email !== clean) {
      const keys = this.id?.keys ?? newDeviceKeys(); // the same phone keeps its key
      const r = await post(this.relay, "/v1/register", { email: clean, device: { name: this.o.name, kind: "phone", signPub: keys.signPub, sig: sign(keys.signSecret, registerMessage(clean, "phone", keys.signPub)) } });
      if (!r.ok) return r;
      this.id = { relay: this.relay, email: clean, name: this.o.name, keys, statusKeys: {}, macs: {} };
      await this.o.store.save(this.id);
      this.ws?.close(1000, "new account");
      this.ws = undefined;
    }
    this.connect();
    if (!(await this.until(() => this.snap.link === "up", timeoutMs))) return { ok: false, error: "couldn't reach the relay — check your connection" };
    const targets = this.snap.sessions.filter((s) => s.online && !s.allowed);
    if (!targets.length) return { ok: false, error: `no Mac is waiting — on your Mac, run /remote on ${clean}` };
    const results: ("paired" | "wrong")[] = [];
    for (const s of targets) {
      const key = `${s.mac}:${s.session}`;
      const pake = new Pake(code.replace(/\D/g, ""), `${s.mac}:${this.myId}`);
      this.pakes.set(key, { pake, done: (r) => (this.pakes.delete(key), results.push(r)) });
      this.send({ t: "to", mac: s.mac, session: s.session, data: JSON.stringify({ p: "pake", y: pake.y, pub: this.id!.keys.signPub } satisfies PairMessage) });
    }
    // Only the Mac showing a code answers; the first right answer wins.
    await this.until(() => results.includes("paired") || results.length === targets.length, timeoutMs);
    for (const s of targets) this.pakes.delete(`${s.mac}:${s.session}`);
    if (results.includes("paired")) return { ok: true };
    if (results.includes("wrong")) return { ok: false, error: "that code doesn't match the one on your Mac" };
    return { ok: false, error: "your Mac didn't answer — is the code still showing? (/remote pair makes a new one)" };
  }

  // The Mac's answer to our share: its tag proves it used the same code, and its key is pinned.
  private onPairing(mac: string, session: string, data: string): void {
    const p = this.pakes.get(`${mac}:${session}`);
    if (!p || !this.id) return;
    let m: PairMessage;
    try {
      m = JSON.parse(data) as PairMessage;
    } catch {
      return;
    }
    if (m.p !== "pake" || typeof m.y !== "string" || typeof m.pub !== "string" || deviceId(m.pub) !== mac) return;
    const mine = this.id.keys.signPub;
    const key = p.pake.key(m.y, p.pake.y, m.y);
    if (!key || m.t !== pairTag(key, "mac", mine, m.pub)) return p.done("wrong");
    this.send({ t: "to", mac, session, data: JSON.stringify({ p: "confirm", t: pairTag(key, "phone", mine, m.pub) } satisfies PairMessage) });
    this.id.macs[mac] = m.pub;
    void this.o.store.save(this.id);
    p.done("paired");
  }

  private async until(cond: () => boolean, ms: number): Promise<boolean> {
    for (const end = Date.now() + ms; !cond(); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) return false;
    return true;
  }

  async signOut(): Promise<void> {
    if (this.id) this.send({ t: "revoke", device: deviceId(this.id.keys.signPub) });
    this.stop();
    this.id = undefined;
    await this.o.store.save(undefined);
  }

  get relay(): string {
    return this.id?.relay ?? this.o.relay;
  }

  get myId(): string | undefined {
    return this.id ? deviceId(this.id.keys.signPub) : undefined;
  }

  // The paired Macs' projects, as the relay lists them.
  get paired(): SessionInfo[] {
    return this.snap.sessions.filter((s) => s.allowed && this.id?.macs[s.mac]);
  }

  // What a Mac last left on the relay, readable once that Mac has welcomed this phone.
  statusOf<T = unknown>(s: SessionInfo): T | undefined {
    const key = this.id?.statusKeys[s.mac];
    return key && s.status ? openStatus<T>(key, s.status) : undefined;
  }

  connect(): void {
    if (!this.id || this.ws) return;
    this.stopped = false;
    clearTimeout(this.retry);
    this.set({ link: "connecting" });
    const Ctor = this.o.WebSocket ?? (globalThis.WebSocket as unknown as WSCtor);
    const ws = new Ctor(`${this.relay.replace(/^http/, "ws")}/v1/connect?device=${this.myId}`);
    this.ws = ws;
    ws.onmessage = (e) => {
      try {
        this.onFrame(JSON.parse(String(e.data)) as ServerFrame);
      } catch {
        /* a malformed frame is dropped */
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      for (const c of this.conns.values()) c.drop();
      this.conns.clear();
      if (e.code === 4001) {
        // Signed out from another device (or this one was revoked on the Mac).
        this.id = undefined;
        void this.o.store.save(undefined);
        return this.set({ link: "off", error: "this phone was signed out" });
      }
      this.set({ link: this.stopped ? "off" : "connecting", ...(e.code === 4002 ? { error: e.reason } : {}) });
      if (this.stopped) return;
      this.retry = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.ws?.close(1000, "bye");
    this.ws = undefined;
    this.set({ link: "off" });
  }

  setPush(token: string, categories: PushCategory[]): void {
    this.send({ t: "pushToken", token, categories });
  }

  private send(f: object): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(f));
  }

  private onFrame(f: ServerFrame): void {
    switch (f.t) {
      case "challenge":
        return this.send({ t: "auth", v: PROTOCOL, sig: sign(this.id!.keys.signSecret, authMessage(f.nonce, this.myId!)) });
      case "ready":
        this.backoff = 1000;
        return this.set({ link: "up", me: f.you, devices: f.devices, sessions: f.sessions, error: undefined });
      case "devices":
        return this.set({ devices: f.devices });
      case "sessions":
        for (const [key, c] of this.conns) if (!f.sessions.some((s) => `${s.mac}:${s.session}` === key && s.online && s.allowed)) (c.drop(), this.conns.delete(key));
        return this.set({ sessions: f.sessions });
      case "from":
        if (!f.mac || !f.session) return;
        if (isPairFrame(f.data)) return this.onPairing(f.mac, f.session, f.data);
        this.conns.get(`${f.mac}:${f.session}`)?.receive(f.data);
        return;
      case "error":
        return this.set({ error: f.message });
    }
  }

  // Open (or reuse) the encrypted session with one Mac project.
  async open(mac: string, session: string, timeoutMs = 10_000): Promise<Session> {
    const key = `${mac}:${session}`;
    const existing = this.conns.get(key);
    if (existing?.ready) return existing;
    existing?.drop();
    // Only a Mac this phone paired with, by the key pinned then: a relay can't slip in a Mac of its own.
    const pub = this.id?.macs[mac];
    if (!pub || !this.id) throw new Error("this phone isn't paired with that Mac");
    const ch = new Channel(`${mac}:${session}:${this.myId}`, "a", this.id.keys.signSecret, pub);
    const conn = new Session(ch, (data) => this.send({ t: "to", mac, session, data }), (statusKey) => {
      if (this.id && this.id.statusKeys[mac] !== statusKey) {
        this.id.statusKeys[mac] = statusKey;
        void this.o.store.save(this.id);
      }
    });
    this.conns.set(key, conn);
    this.send({ t: "to", mac, session, data: JSON.stringify(ch.hello()) });
    await conn.opened(timeoutMs);
    return conn;
  }
}

export interface Welcome {
  mac: string;
  project: string;
  bootId: string;
  version: string;
}

// One encrypted session with one Mac project: API calls, and its event stream.
export class Session {
  welcome?: Welcome;
  private nextId = 1;
  private waiting = new Map<number, (r: { status: number; body: unknown }) => void>();
  private onEvents?: (events: unknown[]) => void;
  private openWaiter?: { resolve: () => void; reject: (e: Error) => void };
  private dead = false;
  onDead?: () => void; // called once, whenever this session stops working (see drop)

  constructor(
    private ch: Channel,
    private out: (data: string) => void,
    private onStatusKey: (k: string) => void,
  ) {}

  get ready(): boolean {
    return !!this.welcome && !this.dead;
  }

  opened(ms: number): Promise<void> {
    if (this.welcome) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.openWaiter = { resolve, reject };
      setTimeout(() => reject(new Error("the Mac didn't answer — is niti running there, and has it allowed this phone?")), ms);
    });
  }

  receive(data: string): void {
    if (data === CHANNEL_RESET) return this.drop(); // the Mac no longer has this channel: open a new one
    if (!this.ch.open) {
      try {
        const hello = JSON.parse(data) as Hello;
        if (hello.h === "hello" && this.ch.finish(hello)) return;
      } catch {
        /* not a hello */
      }
      return;
    }
    const msg = this.ch.unseal(data) as ChannelMessage | undefined;
    if (!msg) return;
    if (msg.k === "welcome") {
      this.welcome = { mac: msg.mac, project: msg.project, bootId: msg.bootId, version: msg.version };
      this.onStatusKey(msg.statusKey);
      this.openWaiter?.resolve();
    } else if (msg.k === "res") {
      this.waiting.get(msg.id)?.({ status: msg.status, body: msg.body });
      this.waiting.delete(msg.id);
    } else if (msg.k === "events") this.onEvents?.(msg.events);
  }

  request<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<{ status: number; body: T }> {
    if (this.dead) return Promise.reject(new Error("disconnected"));
    const id = this.nextId++;
    this.out(this.ch.seal({ k: "req", id, method, path, body }));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => (this.waiting.delete(id), reject(new Error("the Mac didn't answer in time"))), timeoutMs);
      this.waiting.set(id, (r) => (clearTimeout(t), resolve(r as { status: number; body: T })));
    });
  }

  // Events after `from` (0 = everything still buffered), then live. One subscriber.
  subscribe(from: number, onEvents: (events: unknown[]) => void): void {
    this.onEvents = onEvents;
    this.out(this.ch.seal({ k: "sub", from }));
  }

  drop(): void {
    if (this.dead) return;
    this.dead = true;
    this.onDead?.();
    this.openWaiter?.reject(new Error("disconnected"));
    for (const w of this.waiting.values()) w({ status: 0, body: { error: "disconnected" } });
    this.waiting.clear();
  }
}
