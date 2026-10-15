import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writePrivateJson } from "../auth/auth-store.ts";
import { deviceId, newDeviceKeys, newStatusKey, type DeviceKeys } from "./protocol.ts";

// This Mac's remote-control identity: one per machine, shared by every niti core on it (the TUI's
// and the desktop app's alike), so signing in from either signs the Mac in. A 0600 file next to
// auth.json; NITI_REMOTE_FILE points tests elsewhere so a test core never dials a real relay.

// The relay every niti uses unless told otherwise (`/remote on <email> --relay`, or NITI_RELAY_URL):
// niti-relay/ on Cloudflare's free plan.
export const DEFAULT_RELAY = process.env.NITI_RELAY_URL ?? "https://niti-relay.niti-relay.workers.dev";

export interface Phone {
  id: string;
  name: string;
  signPub: string; // pinned when it was allowed: what every later handshake is checked against
  allowedAt: number;
}

export interface RemoteIdentity {
  relay: string;
  email: string;
  name: string; // this Mac, as the phone lists it
  keys: DeviceKeys;
  statusKey: string; // seals the status the relay keeps for an offline Mac; handed to each allowed phone
  phones: Phone[];
}

export function remoteFile(): string {
  return process.env.NITI_REMOTE_FILE || join(homedir(), ".config", "niti", "remote.json");
}

export function loadIdentity(path = remoteFile()): RemoteIdentity | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const id = JSON.parse(readFileSync(path, "utf8")) as RemoteIdentity;
    return id.keys?.signSecret && id.relay ? { ...id, phones: id.phones ?? [] } : undefined;
  } catch {
    console.error(`niti: ignoring unreadable ${path}`);
    return undefined;
  }
}

export function saveIdentity(id: RemoteIdentity | undefined, path = remoteFile()): void {
  writePrivateJson(path, id ?? {});
}

export function mtime(path = remoteFile()): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// Keys are made once per Mac and kept across sign-ins, so signing in again is the same device.
export function keysFor(path = remoteFile()): DeviceKeys {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RemoteIdentity>;
    if (raw.keys?.signSecret) return raw.keys;
  } catch {
    /* none yet */
  }
  return newDeviceKeys();
}

export const macId = (id: RemoteIdentity) => deviceId(id.keys.signPub);
export const newIdentity = (relay: string, email: string, keys: DeviceKeys): RemoteIdentity => ({ relay, email, name: macName(), keys, statusKey: newStatusKey(), phones: [] });

// "Ada's MacBook Pro", the name the Mac goes by in Finder, else its hostname.
export function macName(): string {
  if (process.platform === "darwin") {
    const r = spawnSync("scutil", ["--get", "ComputerName"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return hostname().replace(/\.local$/, "");
}

// A project's session id: stable across restarts of the core, so a phone's list doesn't grow a new
// entry every launch. A hash, so the relay doesn't learn the path.
export const sessionFor = (macIdValue: string, root: string) => createHash("sha256").update(`${macIdValue}:${root}`).digest("base64url").slice(0, 16);
