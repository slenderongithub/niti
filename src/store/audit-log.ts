import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

// Tamper-evident trail of tool calls + approval decisions. Each row's hash chains to the previous
// row's (stdlib sha256, no new dependency), so editing, deleting, or reordering a row breaks the
// chain from that point forward — `verify()` detects it. This is SQLite on local disk, not a
// write-once medium: the goal is making tampering evident for forensics, not preventing it outright.
export type AuditKind = "tool_call" | "approval";

export interface AuditEntry {
  agentId?: string;
  kind: AuditKind;
  detail: unknown; // JSON-serializable
}

export interface AuditRow extends AuditEntry {
  id: number;
  time: number;
  prevHash: string;
  hash: string;
}

const GENESIS_HASH = "0".repeat(64);

function payloadFor(time: number, agentId: string | undefined, kind: AuditKind, detail: unknown): string {
  return JSON.stringify({ time, agentId: agentId ?? null, kind, detail });
}

export class AuditLog {
  constructor(private db: Database) {}

  private lastHash(): string {
    const row = this.db.query("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").get() as { hash: string } | null;
    return row?.hash ?? GENESIS_HASH;
  }

  append(entry: AuditEntry): void {
    const time = Date.now();
    const prevHash = this.lastHash();
    const hash = createHash("sha256")
      .update(prevHash + payloadFor(time, entry.agentId, entry.kind, entry.detail))
      .digest("hex");
    this.db
      .query("INSERT INTO audit_log (created_at, agent_id, kind, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)")
      .run(time, entry.agentId ?? null, entry.kind, JSON.stringify(entry.detail), prevHash, hash);
  }

  list(): AuditRow[] {
    const rows = this.db.query("SELECT * FROM audit_log ORDER BY id").all() as {
      id: number;
      created_at: number;
      agent_id: string | null;
      kind: string;
      detail: string;
      prev_hash: string;
      hash: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      time: r.created_at,
      agentId: r.agent_id ?? undefined,
      kind: r.kind as AuditKind,
      detail: JSON.parse(r.detail),
      prevHash: r.prev_hash,
      hash: r.hash,
    }));
  }

  // Re-walks every row, recomputing each hash from its own recorded fields plus the previous row's
  // hash. `true` if the chain is intact end to end; otherwise the id of the first row whose stored
  // hash doesn't match what it should be.
  verify(): true | { brokenAt: number } {
    let prevHash = GENESIS_HASH;
    for (const row of this.list()) {
      const expected = createHash("sha256").update(prevHash + payloadFor(row.time, row.agentId, row.kind, row.detail)).digest("hex");
      if (expected !== row.hash) return { brokenAt: row.id };
      prevHash = row.hash;
    }
    return true;
  }
}
