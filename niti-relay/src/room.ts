import { authMessage, isPairFrame, PROTOCOL, randomId, verify, type ClientFrame, type DeviceInfo, type PushCategory, type ServerFrame, type SessionInfo } from "../../src/remote/protocol.ts";
import type { Accounts } from "./accounts.ts";

// One account's room: its Macs (one socket per running core) and its phones. It routes opaque
// encrypted frames between a phone and a Mac session that has allowed it, tells each side who is
// online, keeps each session's last encrypted status, and sends pushes. It never sees content.
//
// Stateless between calls on purpose: a Durable Object can be evicted while its sockets stay open
// (WebSocket hibernation), so everything is read back from the sockets' own metadata and storage.

export interface SockMeta {
  device: DeviceInfo & { account: string };
  nonce: string;
  authed: boolean;
  session?: string; // a Mac socket: its core's session
}

export interface Sock {
  meta: SockMeta;
  setMeta(m: SockMeta): void;
  send(frame: ServerFrame): void;
  close(code: number, reason: string): void;
}

export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list<T>(prefix: string): Promise<Map<string, T>>;
}

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: { route?: string; category: PushCategory };
}

export interface RoomDeps {
  account: string;
  accounts: Accounts;
  sockets(): Sock[];
  kv: KV;
  push(messages: PushMessage[]): Promise<void>;
  setAlarm(at: number): Promise<void>;
  now(): number;
}

interface SessionRecord {
  mac: string;
  session: string;
  lastSeen: number;
  status?: string;
  offlineAlert: boolean;
  offlineSince?: number; // set when an alerting session drops; cleared when it is back or the alert is sent
}

const OFFLINE_ALERT_MS = 3 * 60_000;
const FORGET_MS = 30 * 24 * 3_600_000;
const MAX_FRAME = 4 * 1024 * 1024;
const FRAMES_PER_SECOND = 200;

const sessKey = (mac: string, session: string) => `sess:${mac}:${session}`;

export class Room {
  constructor(private d: RoomDeps) {}

  // A socket just opened for a device the Worker already looked up: ask it to prove its key.
  open(sock: Sock): void {
    sock.send({ t: "challenge", nonce: sock.meta.nonce, v: PROTOCOL });
  }

  async message(sock: Sock, raw: string): Promise<void> {
    if (raw.length > MAX_FRAME) return sock.close(1009, "frame too large");
    if (!this.allowRate(sock)) return sock.close(1008, "too many frames");
    let f: ClientFrame;
    try {
      f = JSON.parse(raw) as ClientFrame;
    } catch {
      return sock.send({ t: "error", code: "bad_frame", message: "not JSON" });
    }
    const m = sock.meta;
    if (!m.authed) return this.auth(sock, f);
    // A device signed out elsewhere loses its open sockets at once (revoke), but check anyway.
    const me = m.device;
    switch (f.t) {
      case "ping":
        return sock.send({ t: "pong" });
      case "to":
        return this.route(sock, f);
      case "allow":
        if (me.kind !== "mac" || !Array.isArray(f.phones)) return;
        await this.d.accounts.setAllowed(me.account, me.id, f.phones.map(String));
        await this.d.kv.put(`denied:${me.id}`, (f.denied ?? []).map(String));
        return this.tellPhones();
      case "status": {
        if (me.kind !== "mac" || !m.session) return;
        const key = sessKey(me.id, m.session);
        const rec = (await this.d.kv.get<SessionRecord>(key)) ?? { mac: me.id, session: m.session, lastSeen: this.d.now(), offlineAlert: false };
        rec.status = String(f.blob).slice(0, 64_000);
        rec.offlineAlert = !!f.offlineAlert;
        rec.lastSeen = this.d.now();
        await this.d.kv.put(key, rec);
        return this.tellPhones();
      }
      case "push":
        if (me.kind !== "mac") return;
        return this.pushFrom(me.id, f.category, String(f.title).slice(0, 120), String(f.body).slice(0, 240), f.route);
      case "pushToken":
        if (me.kind !== "phone") return;
        return this.d.accounts.setPush(me.id, f.token, Array.isArray(f.categories) ? f.categories : []);
      case "revoke": {
        // A phone signs out only itself, and a Mac itself or a phone: whoever got hold of the email
        // can't sign the account's Macs out from under it.
        const target = await this.d.accounts.device(String(f.device));
        if (target && target.id !== me.id && (me.kind === "phone" || target.kind === "mac")) return sock.send({ t: "error", code: "forbidden", message: "only a Mac can sign another device out, and only a phone" });
        if (!(await this.d.accounts.revoke(me.account, String(f.device)))) return sock.send({ t: "error", code: "not_found", message: "no such device on this account" });
        for (const s of this.d.sockets()) if (s.meta.device.id === f.device) s.close(4001, "signed out");
        return this.devicesChanged();
      }
    }
  }

  private async auth(sock: Sock, f: ClientFrame): Promise<void> {
    const m = sock.meta;
    if (f.t !== "auth") return sock.close(4000, "authenticate first");
    if (f.v !== PROTOCOL) return sock.close(4002, `protocol ${f.v} isn't supported here (this relay speaks ${PROTOCOL}) — update niti`);
    if (!verify(m.device.signPub, authMessage(m.nonce, m.device.id), f.sig)) return sock.close(4003, "bad signature");
    // Still signed in? A revoke between the Worker's lookup and now must not let it through.
    if (!(await this.d.accounts.device(m.device.id))) return sock.close(4001, "signed out");
    const session = m.device.kind === "mac" ? String(f.session ?? "").slice(0, 64) : undefined;
    if (m.device.kind === "mac" && !session) return sock.close(4000, "a Mac must name its session");
    // One socket per Mac session, and one per phone: a reconnect replaces the old one.
    for (const s of this.d.sockets()) {
      if (s !== sock && s.meta.authed && s.meta.device.id === m.device.id && s.meta.session === session) s.close(4004, "replaced by a newer connection");
    }
    sock.setMeta({ ...m, authed: true, session });
    if (session) {
      const key = sessKey(m.device.id, session);
      const rec = (await this.d.kv.get<SessionRecord>(key)) ?? { mac: m.device.id, session, lastSeen: 0, offlineAlert: false };
      rec.lastSeen = this.d.now();
      rec.offlineSince = undefined;
      await this.d.kv.put(key, rec);
    }
    sock.send({
      t: "ready",
      you: { id: m.device.id, name: m.device.name, kind: m.device.kind, signPub: m.device.signPub },
      devices: await this.d.accounts.devices(this.d.account),
      sessions: m.device.kind === "phone" ? await this.sessionsFor(m.device.id) : [],
      phonesOnline: this.onlinePhones(),
    });
    if (session) await this.tellPhones();
    else this.tellMacs();
  }

  private async route(sock: Sock, f: Extract<ClientFrame, { t: "to" }>): Promise<void> {
    const me = sock.meta.device;
    const data = String(f.data ?? "");
    // Before a Mac allows a phone, only the pairing exchange (small, cleartext) passes between them.
    const pairing = isPairFrame(data);
    if (me.kind === "phone") {
      if (!f.mac || !f.session) return;
      if (!pairing && !(await this.d.accounts.allowed(f.mac, me.id))) return sock.send({ t: "error", code: "not_allowed", message: "this Mac hasn't allowed this phone yet" });
      const target = this.d.sockets().find((s) => s.meta.authed && s.meta.device.kind === "mac" && s.meta.device.id === f.mac && s.meta.session === f.session);
      if (!target) return sock.send({ t: "error", code: "offline", message: "that session is offline" });
      return target.send({ t: "from", device: me.id, data });
    }
    if (!f.device || !sock.meta.session) return;
    if (!pairing && !(await this.d.accounts.allowed(me.id, f.device))) return;
    for (const s of this.d.sockets()) {
      if (s.meta.authed && s.meta.device.kind === "phone" && s.meta.device.id === f.device) s.send({ t: "from", mac: me.id, session: sock.meta.session, data });
    }
  }

  async close(sock: Sock): Promise<void> {
    const m = sock.meta;
    if (!m.authed) return;
    // A closing socket can still be listed (Cloudflare reports it until the close completes), so it
    // stops counting as online here, before anyone is told who is.
    sock.setMeta({ ...m, authed: false });
    if (m.session) {
      const key = sessKey(m.device.id, m.session);
      const rec = await this.d.kv.get<SessionRecord>(key);
      if (rec) {
        rec.lastSeen = this.d.now();
        if (rec.offlineAlert) {
          rec.offlineSince = this.d.now();
          await this.d.setAlarm(this.d.now() + OFFLINE_ALERT_MS);
        }
        await this.d.kv.put(key, rec);
      }
      await this.tellPhones(sock);
    } else {
      this.tellMacs(sock);
    }
  }

  // A Mac session with a goal running dropped and hasn't come back: tell its phones.
  async alarm(): Promise<void> {
    const now = this.d.now();
    let next = Infinity;
    for (const rec of (await this.d.kv.list<SessionRecord>("sess:")).values()) {
      if (rec.offlineSince === undefined) continue;
      if (this.isOnline(rec.mac, rec.session)) continue;
      const due = rec.offlineSince + OFFLINE_ALERT_MS;
      if (due > now) {
        next = Math.min(next, due);
        continue;
      }
      rec.offlineSince = undefined;
      await this.d.kv.put(sessKey(rec.mac, rec.session), rec);
      const mac = (await this.d.accounts.devices(this.d.account)).find((d) => d.id === rec.mac);
      await this.pushFrom(rec.mac, "offline", `${mac?.name ?? "Your Mac"} went offline`, "A goal was running when it lost its connection.", undefined, true);
    }
    if (next < Infinity) await this.d.setAlarm(next);
  }

  // A device signed in or out: everyone's list changes, and phones' sessions may too.
  async devicesChanged(): Promise<void> {
    const devices = await this.d.accounts.devices(this.d.account);
    for (const s of this.d.sockets()) if (s.meta.authed) s.send({ t: "devices", devices });
    await this.tellPhones();
  }

  private async pushFrom(mac: string, category: PushCategory, title: string, body: string, route?: string, evenIfConnected = false): Promise<void> {
    const connected = new Set(this.onlinePhones());
    const phones = (await this.d.accounts.allowedPhones(mac)).filter((p) => evenIfConnected || !connected.has(p));
    const tokens = await this.d.accounts.pushTargets(phones, category);
    if (tokens.length) await this.d.push(tokens.map((to) => ({ to, title, body, data: { route, category } })));
  }

  private async sessionsFor(phone: string): Promise<SessionInfo[]> {
    const out: SessionInfo[] = [];
    const now = this.d.now();
    for (const [key, rec] of await this.d.kv.list<SessionRecord>("sess:")) {
      const online = this.isOnline(rec.mac, rec.session);
      if (!online && now - rec.lastSeen > FORGET_MS) {
        await this.d.kv.delete(key);
        continue;
      }
      const allowed = await this.d.accounts.allowed(rec.mac, phone);
      const denied = !allowed && ((await this.d.kv.get<string[]>(`denied:${rec.mac}`)) ?? []).includes(phone);
      out.push({ mac: rec.mac, session: rec.session, online, lastSeen: rec.lastSeen, allowed, denied, status: allowed ? rec.status : undefined });
    }
    return out;
  }

  private async tellPhones(except?: Sock): Promise<void> {
    for (const s of this.d.sockets()) {
      if (s === except || !s.meta.authed || s.meta.device.kind !== "phone") continue;
      s.send({ t: "sessions", sessions: await this.sessionsFor(s.meta.device.id) });
    }
  }

  private tellMacs(except?: Sock): void {
    const online = this.onlinePhones(except);
    for (const s of this.d.sockets()) if (s !== except && s.meta.authed && s.meta.device.kind === "mac") s.send({ t: "phones", online });
  }

  private onlinePhones(except?: Sock): string[] {
    return [...new Set(this.d.sockets().filter((s) => s !== except && s.meta.authed && s.meta.device.kind === "phone").map((s) => s.meta.device.id))];
  }

  private isOnline(mac: string, session: string): boolean {
    return this.d.sockets().some((s) => s.meta.authed && s.meta.device.id === mac && s.meta.session === session);
  }

  // A plain per-socket token bucket. In memory only: a hibernated object starts it fresh, which
  // costs nothing but a little leniency.
  private buckets = new WeakMap<Sock, { tokens: number; at: number }>();
  private allowRate(sock: Sock): boolean {
    const now = this.d.now();
    const b = this.buckets.get(sock) ?? { tokens: FRAMES_PER_SECOND, at: now };
    b.tokens = Math.min(FRAMES_PER_SECOND, b.tokens + ((now - b.at) / 1000) * FRAMES_PER_SECOND);
    b.at = now;
    this.buckets.set(sock, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

export const newSockMeta = (device: DeviceInfo & { account: string }): SockMeta => ({ device, nonce: randomId(), authed: false });
