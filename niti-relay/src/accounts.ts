import { deviceId, randomId, type DeviceInfo, type DeviceKind, type PushCategory, PUSH_CATEGORIES } from "../../src/remote/protocol.ts";

// Accounts and their devices: email + a 6-digit code to sign in, then a device's own signing key is
// its credential from there on (no bearer tokens to steal). Written against a tiny SQL interface so
// the same code runs on D1 in production and bun:sqlite in tests.

export interface Sql {
  run(q: string, ...args: unknown[]): Promise<void>;
  first<T>(q: string, ...args: unknown[]): Promise<T | undefined>;
  all<T>(q: string, ...args: unknown[]): Promise<T[]>;
}

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, account TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, sign_pub TEXT NOT NULL, created INTEGER NOT NULL, push_token TEXT, push_categories TEXT)`,
  `CREATE INDEX IF NOT EXISTS devices_account ON devices(account)`,
  `CREATE TABLE IF NOT EXISTS allows (mac TEXT NOT NULL, phone TEXT NOT NULL, PRIMARY KEY (mac, phone))`,
  `CREATE TABLE IF NOT EXISTS codes (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL, sent INTEGER NOT NULL, window_start INTEGER NOT NULL)`,
];

const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
// Codes per email per day. With MAX_ATTEMPTS each, that caps guessing at 50 a day: about a 2% chance
// a year of ever landing one, and even then the new device still has to be allowed on a Mac.
const MAX_SENDS_PER_DAY = 10;
const SEND_WINDOW_MS = 24 * 3_600_000;
const MAX_DEVICES = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Mail = (email: string, code: string) => Promise<void>;

interface DeviceRow {
  id: string;
  account: string;
  kind: DeviceKind;
  name: string;
  sign_pub: string;
  push_token: string | null;
  push_categories: string | null;
}

const toInfo = (r: DeviceRow): DeviceInfo => ({ id: r.id, name: r.name, kind: r.kind, signPub: r.sign_pub });

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Accounts {
  constructor(
    private sql: Sql,
    private mail: Mail,
    private now: () => number = Date.now,
  ) {}

  async migrate(): Promise<void> {
    for (const q of SCHEMA) await this.sql.run(q);
  }

  // Send a sign-in code. Says nothing about whether the email has an account.
  async start(rawEmail: string): Promise<{ ok: boolean; error?: string }> {
    const email = String(rawEmail ?? "").trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) return { ok: false, error: "that doesn't look like an email address" };
    const now = this.now();
    const prev = await this.sql.first<{ sent: number; window_start: number }>(`SELECT sent, window_start FROM codes WHERE email = ?`, email);
    const fresh = !prev || now - prev.window_start > SEND_WINDOW_MS;
    const sent = fresh ? 1 : prev.sent + 1;
    if (sent > MAX_SENDS_PER_DAY) return { ok: false, error: "too many codes requested today — try again tomorrow" };
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");
    await this.sql.run(
      `INSERT INTO codes (email, code_hash, expires, attempts, sent, window_start) VALUES (?, ?, ?, 0, ?, ?)
       ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires = excluded.expires, attempts = 0, sent = excluded.sent, window_start = excluded.window_start`,
      email,
      await sha256(`${email}:${code}`),
      now + CODE_TTL_MS,
      sent,
      fresh ? now : prev!.window_start,
    );
    await this.mail(email, code);
    return { ok: true };
  }

  // Check the code and register this device's key under the account (made on first sign-in).
  async verify(
    rawEmail: string,
    code: string,
    device: { name: string; kind: DeviceKind; signPub: string },
  ): Promise<{ ok: true; account: string; device: DeviceInfo } | { ok: false; error: string }> {
    const email = String(rawEmail ?? "").trim().toLowerCase();
    if (device?.kind !== "mac" && device?.kind !== "phone") return { ok: false, error: "unknown device kind" };
    if (typeof device.signPub !== "string" || device.signPub.length !== 43) return { ok: false, error: "bad device key" };
    const row = await this.sql.first<{ code_hash: string; expires: number; attempts: number }>(`SELECT code_hash, expires, attempts FROM codes WHERE email = ?`, email);
    if (!row || row.expires < this.now()) return { ok: false, error: "that code has expired — ask for a new one" };
    if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: "too many wrong codes — ask for a new one" };
    if ((await sha256(`${email}:${String(code).trim()}`)) !== row.code_hash) {
      await this.sql.run(`UPDATE codes SET attempts = attempts + 1 WHERE email = ?`, email);
      return { ok: false, error: "wrong code" };
    }
    await this.sql.run(`UPDATE codes SET expires = 0 WHERE email = ?`, email); // single use; keep the send window
    let account = (await this.sql.first<{ id: string }>(`SELECT id FROM accounts WHERE email = ?`, email))?.id;
    if (!account) {
      account = randomId();
      await this.sql.run(`INSERT INTO accounts (id, email, created) VALUES (?, ?, ?)`, account, email, this.now());
    }
    const id = deviceId(device.signPub);
    const existing = await this.sql.first<{ account: string }>(`SELECT account FROM devices WHERE id = ?`, id);
    if (existing && existing.account !== account) return { ok: false, error: "this device is signed in to another account — sign out there first" };
    const count = (await this.sql.first<{ n: number }>(`SELECT COUNT(*) AS n FROM devices WHERE account = ?`, account))?.n ?? 0;
    if (!existing && count >= MAX_DEVICES) return { ok: false, error: `an account can have at most ${MAX_DEVICES} devices — sign one out first` };
    const name = String(device.name ?? "").trim().slice(0, 60) || (device.kind === "mac" ? "Mac" : "Phone");
    if (existing) await this.sql.run(`UPDATE devices SET name = ? WHERE id = ?`, name, id);
    else await this.sql.run(`INSERT INTO devices (id, account, kind, name, sign_pub, created) VALUES (?, ?, ?, ?, ?, ?)`, id, account, device.kind, name, device.signPub, this.now());
    return { ok: true, account, device: { id, name, kind: device.kind, signPub: device.signPub } };
  }

  async device(id: string): Promise<(DeviceInfo & { account: string }) | undefined> {
    const r = await this.sql.first<DeviceRow>(`SELECT * FROM devices WHERE id = ?`, id);
    return r ? { ...toInfo(r), account: r.account } : undefined;
  }

  async devices(account: string): Promise<DeviceInfo[]> {
    return (await this.sql.all<DeviceRow>(`SELECT * FROM devices WHERE account = ? ORDER BY created`, account)).map(toInfo);
  }

  // A Mac's allowed phones, replaced whole. Only phones on the same account count.
  async setAllowed(account: string, mac: string, phones: string[]): Promise<void> {
    const mine = new Set((await this.devices(account)).filter((d) => d.kind === "phone").map((d) => d.id));
    await this.sql.run(`DELETE FROM allows WHERE mac = ?`, mac);
    for (const p of new Set(phones)) if (mine.has(p)) await this.sql.run(`INSERT INTO allows (mac, phone) VALUES (?, ?)`, mac, p);
  }

  async allowed(mac: string, phone: string): Promise<boolean> {
    return !!(await this.sql.first(`SELECT 1 AS x FROM allows WHERE mac = ? AND phone = ?`, mac, phone));
  }

  async allowedPhones(mac: string): Promise<string[]> {
    return (await this.sql.all<{ phone: string }>(`SELECT phone FROM allows WHERE mac = ?`, mac)).map((r) => r.phone);
  }

  async setPush(phone: string, token: string, categories: PushCategory[]): Promise<void> {
    const cats = categories.filter((c) => PUSH_CATEGORIES.includes(c));
    await this.sql.run(`UPDATE devices SET push_token = ?, push_categories = ? WHERE id = ? AND kind = 'phone'`, String(token).slice(0, 200), cats.join(","), phone);
  }

  async pushTargets(phones: string[], category: PushCategory): Promise<string[]> {
    const out: string[] = [];
    for (const id of phones) {
      const r = await this.sql.first<DeviceRow>(`SELECT * FROM devices WHERE id = ?`, id);
      if (r?.push_token && (r.push_categories ?? "").split(",").includes(category)) out.push(r.push_token);
    }
    return out;
  }

  // Sign a device out of the account: it can't connect again until it signs in afresh (as a new
  // device, which every Mac must allow again).
  async revoke(account: string, id: string): Promise<boolean> {
    const d = await this.device(id);
    if (!d || d.account !== account) return false;
    await this.sql.run(`DELETE FROM devices WHERE id = ?`, id);
    await this.sql.run(`DELETE FROM allows WHERE mac = ? OR phone = ?`, id, id);
    return true;
  }
}
