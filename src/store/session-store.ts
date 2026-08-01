import { rmSync, writeFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { Turn, ToolCall, ToolResult, Usage } from "../providers/provider.ts";
import type { AgentMessage } from "../messaging/message-bus.ts";

export type SessionKind = "task" | "fork" | "ask" | "respond";
export type SessionStatus = "active" | "done" | "failed" | "exhausted";
export type PartType = "text" | "tool_call" | "tool_result" | "raw" | "file_ref";

export interface Part {
  type: PartType;
  content: unknown; // stored as JSON
}

export interface SessionInput {
  agentId: string;
  kind: SessionKind;
  provider: string;
  model: string;
  taskId?: string;
  parentSessionId?: string;
}

export interface SessionRow {
  id: string;
  agentId: string;
  taskId?: string;
  parentSessionId?: string;
  kind: SessionKind;
  provider: string;
  model: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

// Turn → Parts and back. Pure and symmetric: fromParts(role, toParts(turn)) === turn. Keeping the
// pair pure is what makes the round-trip testable without a database.
export function toParts(turn: Turn): Part[] {
  switch (turn.role) {
    case "user":
      return [{ type: "text", content: turn.text }];
    case "assistant": {
      const parts: Part[] = [];
      if (turn.text) parts.push({ type: "text", content: turn.text });
      for (const c of turn.toolCalls) parts.push({ type: "tool_call", content: c });
      if (turn.raw !== undefined) parts.push({ type: "raw", content: turn.raw });
      return parts;
    }
    case "tool":
      return turn.results.map((r) => ({ type: "tool_result", content: r }));
  }
}

export function fromParts(role: string, parts: Part[]): Turn | undefined {
  const text = parts.filter((p) => p.type === "text").map((p) => String(p.content)).join("");
  if (role === "user") return { role: "user", text };
  if (role === "assistant") {
    const raw = parts.find((p) => p.type === "raw");
    const toolCalls = parts.filter((p) => p.type === "tool_call").map((p) => p.content as ToolCall);
    return raw ? { role: "assistant", text, toolCalls, raw: raw.content } : { role: "assistant", text, toolCalls };
  }
  if (role === "tool") {
    return { role: "tool", results: parts.filter((p) => p.type === "tool_result").map((p) => p.content as ToolResult) };
  }
  return undefined; // unknown role (schema drift) — dropped rather than crashing a resume
}

interface SessionDbRow {
  id: string;
  agent_id: string;
  task_id: string | null;
  parent_session_id: string | null;
  kind: string;
  provider: string;
  model: string;
  status: string;
  created_at: number;
  updated_at: number;
  time_archived: number | null;
}

function toRow(r: SessionDbRow): SessionRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    taskId: r.task_id ?? undefined,
    parentSessionId: r.parent_session_id ?? undefined,
    kind: r.kind as SessionKind,
    provider: r.provider,
    model: r.model,
    status: r.status as SessionStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.time_archived ?? undefined,
  };
}

// Conversation persistence over the schema in db.ts. The in-memory `turns: Turn[]` array still
// drives the agent loop; every append here is a side-effect mirror of it, never a behaviour change.
export class SessionStore {
  constructor(private db: Database) {}

  createSession(i: SessionInput): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO sessions (id, agent_id, task_id, parent_session_id, kind, provider, model, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, i.agentId, i.taskId ?? null, i.parentSessionId ?? null, i.kind, i.provider, i.model, now, now);
    return id;
  }

  appendMessage(sessionId: string, role: Turn["role"], parts: Part[], usage?: Usage): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    const next = this.db.query("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM messages WHERE session_id = ?").get(sessionId) as { n: number };
    const write = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO messages (id, session_id, role, seq, input_tokens, output_tokens, reasoning_tokens, cache_tokens, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
        )
        .run(id, sessionId, role, next.n, usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, now);
      const ins = this.db.query("INSERT INTO parts (message_id, seq, type, content, created_at) VALUES (?, ?, ?, ?, ?)");
      parts.forEach((p, i) => ins.run(id, i, p.type, JSON.stringify(p.content ?? null), now));
      this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
    });
    write();
    return id;
  }

  loadTurns(sessionId: string): Turn[] {
    const msgs = this.db.query("SELECT id, role FROM messages WHERE session_id = ? ORDER BY seq").all(sessionId) as { id: string; role: string }[];
    const partsOf = this.db.query("SELECT type, content FROM parts WHERE message_id = ? ORDER BY seq");
    const turns: Turn[] = [];
    for (const m of msgs) {
      const rows = partsOf.all(m.id) as { type: string; content: string }[];
      const turn = fromParts(
        m.role,
        rows.map((r) => ({ type: r.type as PartType, content: JSON.parse(r.content) })),
      );
      if (turn) turns.push(turn);
    }
    return turns;
  }

  listSessions(filter: { taskId?: string; agentId?: string; parentSessionId?: string; kind?: SessionKind; includeArchived?: boolean } = {}): SessionRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (sql: string, v?: string) => {
      if (v === undefined) return;
      where.push(sql);
      args.push(v);
    };
    add("task_id = ?", filter.taskId);
    add("agent_id = ?", filter.agentId);
    add("parent_session_id = ?", filter.parentSessionId);
    add("kind = ?", filter.kind);
    if (!filter.includeArchived) where.push("time_archived IS NULL");
    const sql = `SELECT * FROM sessions${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at`;
    return (this.db.query(sql).all(...(args as string[])) as SessionDbRow[]).map(toRow);
  }

  // All-time usage aggregates for the /stats page: tokens per calendar day (for the heatmap and the
  // tokens-per-day chart), tokens per model (for the breakdown and the favorite-model pick), and the
  // session-level counters (how many sessions, the longest one). Pure SQL over the same rows the
  // agent loop already writes — no separate ledger to keep in step. Days are bucketed in local time
  // so "most active day" lines up with the user's calendar, not UTC.
  stats(): {
    perDay: { date: string; tokens: number; msgs: number }[];
    perModel: { provider: string; model: string; inTokens: number; outTokens: number; msgs: number }[];
    sessions: number;
    longestSessionMs: number;
  } {
    const perDay = this.db
      .query(
        `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS date,
                SUM(input_tokens + output_tokens) AS tokens,
                COUNT(*) AS msgs
         FROM messages GROUP BY date ORDER BY date`,
      )
      .all() as { date: string; tokens: number; msgs: number }[];
    const perModel = this.db
      .query(
        `SELECT s.provider AS provider, s.model AS model,
                SUM(m.input_tokens) AS inTokens, SUM(m.output_tokens) AS outTokens, COUNT(*) AS msgs
         FROM messages m JOIN sessions s ON s.id = m.session_id
         GROUP BY s.provider, s.model ORDER BY (inTokens + outTokens) DESC`,
      )
      .all() as { provider: string; model: string; inTokens: number; outTokens: number; msgs: number }[];
    const agg = this.db
      .query(`SELECT COUNT(*) AS sessions, COALESCE(MAX(updated_at - created_at), 0) AS longest FROM sessions`)
      .get() as { sessions: number; longest: number };
    return { perDay, perModel, sessions: agg.sessions, longestSessionMs: agg.longest };
  }

  getSession(id: string): SessionRow | undefined {
    const r = this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionDbRow | null;
    return r ? toRow(r) : undefined;
  }

  setStatus(id: string, status: SessionStatus): void {
    this.db.query("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
  }

  archiveSession(id: string): void {
    this.db.query("UPDATE sessions SET time_archived = ?, updated_at = ? WHERE id = ?").run(Date.now(), Date.now(), id);
  }

  // --- agent-to-agent messages --------------------------------------------
  // The cross-provider channel's durable trail. Every message the MessageBus publishes lands here,
  // tagged with the session that sent it, so "architect asked frontend X, frontend's session Y
  // answered" can be rendered as one thread instead of vanishing when respond() returns.
  recordMessage(m: AgentMessage): void {
    this.db
      .query("INSERT INTO bus_messages (msg_id, session_id, from_agent, to_agent, kind, subject, body, refs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(m.id, m.sessionId ?? null, m.from, m.to, m.kind, m.subject, m.body, m.refs ? JSON.stringify(m.refs) : null, m.time);
  }

  listMessages(sessionId?: string): AgentMessage[] {
    const rows = (
      sessionId
        ? this.db.query("SELECT * FROM bus_messages WHERE session_id = ? ORDER BY id").all(sessionId)
        : this.db.query("SELECT * FROM bus_messages ORDER BY id").all()
    ) as { msg_id: string; session_id: string | null; from_agent: string; to_agent: string; kind: string; subject: string; body: string; refs: string | null; created_at: number }[];
    return rows.map((r) => ({
      id: r.msg_id,
      sessionId: r.session_id ?? undefined,
      from: r.from_agent,
      to: r.to_agent,
      kind: r.kind as AgentMessage["kind"],
      subject: r.subject,
      body: r.body,
      refs: r.refs ? (JSON.parse(r.refs) as string[]) : undefined,
      time: r.created_at,
    }));
  }

  // --- checkpoints / undo -------------------------------------------------
  // Record what a file looked like before an agent wrote to it. `content` is null when the file
  // didn't exist yet, which is what tells undo to delete rather than restore. Paths are absolute
  // (already through safePath) so undo doesn't need to know the project root.
  // ponytail: full prior contents, never pruned — one row per write, so a long session's .amux/amux.db
  // grows with total bytes written. Add age/count-based pruning if that ever matters.
  checkpoint(sessionId: string, path: string, content: string | null): void {
    this.db.query("INSERT INTO checkpoints (session_id, path, content, created_at) VALUES (?, ?, ?, ?)").run(sessionId, path, content, Date.now());
  }

  // Revert the most recent recorded write (LIFO) — one undo = one prior write, not "undo the whole
  // task". Restores content, or deletes the file if it didn't exist before. Doing the filesystem
  // work here keeps every caller (CLI, server, TUI) from re-implementing it.
  undoLast(sessionId?: string): { path: string; action: "restored" | "deleted" } | undefined {
    const row = (
      sessionId
        ? this.db.query("SELECT id, path, content FROM checkpoints WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(sessionId)
        : this.db.query("SELECT id, path, content FROM checkpoints ORDER BY id DESC LIMIT 1").get()
    ) as { id: number; path: string; content: string | null } | null;
    if (!row) return undefined;
    this.db.query("DELETE FROM checkpoints WHERE id = ?").run(row.id);
    if (row.content === null) {
      rmSync(row.path, { force: true });
      return { path: row.path, action: "deleted" };
    }
    writeFileSync(row.path, row.content);
    return { path: row.path, action: "restored" };
  }
}
