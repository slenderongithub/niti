import { authMessage, Channel, deviceId, newDeviceKeys, openStatus, pairingCode, PROTOCOL, sign, type ChannelMessage, type DeviceInfo, type DeviceKeys, type Hello, type PushCategory, type ServerFrame, type SessionInfo } from "../../../src/remote/protocol";

// The phone's side of remote control: sign in to the relay, see the account's Macs and their
// projects, and open an end-to-end encrypted session with one to drive its niti. Plain TypeScript
// with no React Native imports, so the end-to-end check drives the same code under Bun.

export interface PhoneIdentity {
  relay: string;
  email: string;
  name: string;
  keys: DeviceKeys;
  statusKeys: Record<string, string>; // per Mac, from its welcome: opens the status it leaves on the relay
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
  private pendingEmail?: string;
  private conns = new Map<string, Session>(); // `${mac}:${session}`
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
    this.id = await this.o.store.load();
    return !!this.id;
  }

  async loginStart(email: string): Promise<{ ok: boolean; error?: string }> {
    this.pendingEmail = email.trim();
    return post(this.relay, "/v1/login/start", { email: this.pendingEmail });
  }

  async loginVerify(code: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.pendingEmail) return { ok: false, error: "enter your email first" };
    const keys = this.id?.keys ?? newDeviceKeys(); // the same phone keeps its key across sign-ins
    const r = await post(this.relay, "/v1/login/verify", { email: this.pendingEmail, code: code.trim(), device: { name: this.o.name, kind: "phone", signPub: keys.signPub } });
    if (!r.ok) return r;
    this.id = { relay: this.relay, email: this.pendingEmail, name: this.o.name, keys, statusKeys: this.id?.statusKeys ?? {} };
    await this.o.store.save(this.id);
    return { ok: true };
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

  // The 6 digits this phone shows for a Mac — the Mac shows the same ones when asked to allow it.
  codeFor(mac: string): string | undefined {
    const d = this.snap.devices.find((x) => x.id === mac);
    return d && this.id ? pairingCode(d.signPub, this.id.keys.signPub) : undefined;
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
        if (f.mac && f.session) this.conns.get(`${f.mac}:${f.session}`)?.receive(f.data);
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
    const d = this.snap.devices.find((x) => x.id === mac);
    // The id is the key's hash: a relay can't hand over some other key under this Mac's name.
    if (!d || d.kind !== "mac" || deviceId(d.signPub) !== mac || !this.id) throw new Error("unknown Mac");
    const ch = new Channel(`${mac}:${session}:${this.myId}`, "a", this.id.keys.signSecret, d.signPub);
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
    this.dead = true;
    this.openWaiter?.reject(new Error("disconnected"));
    for (const w of this.waiting.values()) w({ status: 0, body: { error: "disconnected" } });
    this.waiting.clear();
  }
}
