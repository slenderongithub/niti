import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { writePrivateJson } from "../auth/auth-store.ts";
import { createHash } from "node:crypto";

// Claude-Code-style directory trust: the first time niti is about to operate in a project
// directory (read its .niti/agents.yaml, spawn its MCP servers, run agents against its code), the
// human confirms it. Trust is recorded here, GLOBALLY — never as a repo-local marker file, which
// whoever wants a directory trusted could simply commit themselves, defeating the entire point.
//
// Trusting a directory also snapshots its .niti/agents.yaml (configHash below) — all of it, because
// far more than mcpServers: decides what runs: lsp: and verify: commands, sandbox: false, auto: true,
// permissions, autoApprove, instructions. If any of it changes later (a `git pull`), the hash no
// longer matches and the gate re-fires. niti's own writes to the file re-grant (config.ts editConfig).
interface TrustEntry {
  root: string;
  configHash: string;
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

// Owner-only, like the credentials: this file gates code execution.
function write(entries: TrustEntry[]): void {
  writePrivateJson(trustFile(), { entries });
}

// Over the parsed data, so comments and formatting don't count as a change.
function configHash(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config ?? {})).digest("hex");
}

type TrustStatus = "trusted" | "new" | "changed";

// "new": this root has never been trusted. "changed": it was trusted once, but its agents.yaml is
// different now — re-confirm before running anything it configures.
export function checkTrust(root: string, config: unknown): TrustStatus {
  const entry = read().find((e) => e.root === root);
  if (!entry) return "new";
  return entry.configHash === configHash(config) ? "trusted" : "changed";
}

export function grantTrust(root: string, config: unknown): void {
  const entries = read().filter((e) => e.root !== root);
  entries.push({ root, configHash: configHash(config), grantedAt: Date.now() });
  write(entries);
}
