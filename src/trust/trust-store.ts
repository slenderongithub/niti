import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import type { McpServerConfig } from "../mcp/mcp.ts";

// Claude-Code-style directory trust: the first time niti is about to operate in a project
// directory (read its .niti/agents.yaml, spawn its MCP servers, run agents against its code), the
// human confirms it. Trust is recorded here, GLOBALLY — never as a repo-local marker file, which
// whoever wants a directory trusted could simply commit themselves, defeating the entire point.
//
// Trusting a directory also snapshots its current mcpServers: config (mcpHash below). If that
// config changes later — a new or edited MCP server command — the hash no longer matches and the
// gate re-fires, worded to call out the change: this folds "consent before connecting to a new/
// changed MCP server" into the same one prompt/store instead of a second parallel consent system.
export interface TrustEntry {
  root: string;
  mcpHash: string;
  grantedAt: number;
}

interface StoreShape {
  entries: TrustEntry[];
}

// Global, not per-project. Overridable via env so tests never touch a real home.
function trustFile(): string {
  return process.env.NITI_TRUST_FILE || join(homedir(), ".config", "niti", "trusted.json");
}

function read(): TrustEntry[] {
  const path = trustFile();
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as StoreShape;
    return Array.isArray(data.entries) ? data.entries.filter((e) => e && typeof e.root === "string") : [];
  } catch {
    // A corrupt store shouldn't brick the CLI — treat as empty (fail closed: nothing is trusted)
    // and let the next grant heal it.
    return [];
  }
}

// 0600 file inside a 0700 dir, same enforcement as auth-store.ts — this file gates code execution,
// so it gets the same owner-only treatment as credentials.
function write(entries: TrustEntry[]): void {
  const path = trustFile();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ entries }, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort (e.g. Windows) — the mode option above already covers POSIX
  }
}

export function mcpHash(servers: McpServerConfig[]): string {
  const normalized = servers.map((s) => ({ name: s.name, command: s.command, args: s.args ?? [] }));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export type TrustStatus = "trusted" | "new" | "changed";

// "new": this root has never been trusted. "changed": it was trusted once, but its mcpServers:
// config is different now (a new/edited server) — re-confirm before spawning what changed.
export function checkTrust(root: string, servers: McpServerConfig[]): TrustStatus {
  const entry = read().find((e) => e.root === root);
  if (!entry) return "new";
  return entry.mcpHash === mcpHash(servers) ? "trusted" : "changed";
}

export function grantTrust(root: string, servers: McpServerConfig[]): void {
  const entries = read().filter((e) => e.root !== root);
  entries.push({ root, mcpHash: mcpHash(servers), grantedAt: Date.now() });
  write(entries);
}
