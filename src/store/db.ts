import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_DB = ".amux/amux.db";

// Schema for the persistence substrate: sessions → messages → parts, plus per-write checkpoints.
// A session is a child concept a task *has* (task_id), not a replacement for Task/TaskNode — the
// DAG scheduler owns topology, this owns conversation history.
//
// ponytail: idempotent CREATE TABLE IF NOT EXISTS instead of a versioned migration table — adding
// a table or column stays a no-op replay. Upgrade to numbered migrations the first time a column
// has to change type or be dropped.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL,
  task_id           TEXT,
  parent_session_id TEXT REFERENCES sessions(id),
  kind              TEXT NOT NULL,           -- 'task' | 'fork' | 'ask' | 'respond'
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  status            TEXT NOT NULL,           -- 'active' | 'done' | 'failed' | 'exhausted'
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  time_archived     INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_task ON sessions(task_id);
CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_session_id);

CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  role             TEXT NOT NULL,            -- 'user' | 'assistant' | 'tool'
  seq              INTEGER NOT NULL,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_tokens     INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);

-- Decomposing a message into parts is what lets Turn.raw (opaque provider blocks like Anthropic
-- thinking) round-trip without redesigning providers/provider.ts.
CREATE TABLE IF NOT EXISTS parts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL REFERENCES messages(id),
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,                  -- 'text' | 'tool_call' | 'tool_result' | 'raw' | 'file_ref'
  content    TEXT NOT NULL,                  -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS parts_message ON parts(message_id, seq);

-- One row per file mutation: the content BEFORE the write (NULL = the file didn't exist).
CREATE TABLE IF NOT EXISTS checkpoints (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  path       TEXT NOT NULL,
  content    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS checkpoints_session ON checkpoints(session_id, id);

-- The persisted trail of amux's cross-provider agent-to-agent channel (messaging/message-bus.ts):
-- the differentiator, no longer purely ephemeral. msg_id is the bus's own id ("m3"), unique only
-- within one process run, so the primary key is a rowid instead.
CREATE TABLE IF NOT EXISTS bus_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id     TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id),   -- the session that sent/asked, when there is one
  from_agent TEXT NOT NULL,
  to_agent   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  refs       TEXT,                           -- JSON string[]
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bus_messages_session ON bus_messages(session_id);
`;

// Open (creating if needed) and migrate. ":memory:" is honoured for tests.
export function openDb(path: string = DEFAULT_DB): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;"); // concurrent agents write from one process; WAL keeps reads unblocked
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}
