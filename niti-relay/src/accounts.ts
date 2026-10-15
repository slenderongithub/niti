import { deviceId, randomId, registerMessage, verify, type DeviceInfo, type DeviceKind, type PushCategory, PUSH_CATEGORIES } from "../../src/remote/protocol.ts";

// Accounts and their devices. An account is just a name, the person's email (never emailed, never
// checked): it groups their Macs and phones into one room. A device registers its signing key under
// it, and that key is its credential from then on (no bearer tokens to steal). Registering grants
// nothing: a phone reaches a Mac only once that Mac has allowed it, which takes the code shown on the
// Mac (protocol.ts, Pake). Written against a tiny SQL interface so the same code runs on D1 in
// production and bun:sqlite in tests.

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
];

// Devices per account. Anyone who knows an email can register under it, so when it is full the
// oldest device no Mac has allowed (and that allowed no phone) makes room: strangers can't lock the
// owner out by filling it.
const MAX_DEVICES = 20;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

export class Accounts {
  constructor(
    private sql: Sql,
    private now: () => number = Date.now,
  ) {}

  async migrate(): Promise<void> {
    for (const q of SCHEMA) await this.sql.run(q);
  }

  // Register this device's key under the account (made on first use), signed with that key. The same
  // key again is the same device.
  async register(
    rawEmail: string,
    device: { name: string; kind: DeviceKind; signPub: string; sig: string },
  ): Promise<{ ok: true; account: string; device: DeviceInfo } | { ok: false; error: string }> {
    const email = String(rawEmail ?? "").trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) return { ok: false, error: "that doesn't look like an email address" };
    if (device?.kind !== "mac" && device?.kind !== "phone") return { ok: false, error: "unknown device kind" };
    if (typeof device.signPub !== "string" || device.signPub.length !== 43) return { ok: false, error: "bad device key" };
    if (!verify(device.signPub, registerMessage(email, device.kind, device.signPub), String(device.sig ?? ""))) return { ok: false, error: "bad device signature" };
    let account = (await this.sql.first<{ id: string }>(`SELECT id FROM accounts WHERE email = ?`, email))?.id;
    if (!account) {
      account = randomId();
      await this.sql.run(`INSERT INTO accounts (id, email, created) VALUES (?, ?, ?)`, account, email, this.now());
    }
    const id = deviceId(device.signPub);
    const existing = await this.sql.first<{ account: string }>(`SELECT account FROM devices WHERE id = ?`, id);
    if (existing && existing.account !== account) {
      // The same device under another email: it moves, and what it was allowed under the old one goes.
      await this.sql.run(`DELETE FROM allows WHERE mac = ? OR phone = ?`, id, id);
      await this.sql.run(`DELETE FROM devices WHERE id = ?`, id);
    }
    const count = (await this.sql.first<{ n: number }>(`SELECT COUNT(*) AS n FROM devices WHERE account = ?`, account))?.n ?? 0;
    if (!existing || existing.account !== account) {
      if (count >= MAX_DEVICES) {
        const spare = await this.sql.first<{ id: string }>(
          `SELECT id FROM devices WHERE account = ? AND id NOT IN (SELECT mac FROM allows UNION SELECT phone FROM allows) ORDER BY created LIMIT 1`,
          account,
        );
        if (!spare) return { ok: false, error: `an account can have at most ${MAX_DEVICES} devices — sign one out first` };
        await this.sql.run(`DELETE FROM devices WHERE id = ?`, spare.id);
      }
    }
    const name = String(device.name ?? "").trim().slice(0, 60) || (device.kind === "mac" ? "Mac" : "Phone");
    if (existing?.account === account) await this.sql.run(`UPDATE devices SET name = ? WHERE id = ?`, name, id);
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
