import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { SessionStore, toParts, fromParts } from "./session-store.ts";
import { resumeConversation } from "../session.ts";
import type { Turn } from "../providers/provider.ts";

const store = () => new SessionStore(openDb(":memory:"));

const CONVO: Turn[] = [
  { role: "user", text: "build a parser" },
  { role: "assistant", text: "on it", toolCalls: [{ id: "c1", name: "write_file", input: { path: "p.ts", content: "x" } }], raw: [{ type: "thinking", thinking: "hmm" }] },
  { role: "tool", results: [{ id: "c1", name: "write_file", output: "wrote p.ts" }] },
  { role: "assistant", text: "done", toolCalls: [] },
];

test("toParts/fromParts round-trip every turn shape, including opaque provider raw blocks", () => {
  for (const turn of CONVO) {
    expect(fromParts(turn.role, toParts(turn))).toEqual(turn);
  }
});

test("session → messages → parts round-trips a whole conversation through SQLite", () => {
  const s = store();
  const id = s.createSession({ agentId: "architect", kind: "task", provider: "anthropic", model: "m", taskId: "t1" });
  for (const t of CONVO) s.appendMessage(id, t.role, toParts(t));

  expect(s.loadTurns(id)).toEqual(CONVO); // JSON round-trip preserved tool calls and raw blocks
  const [row] = s.listSessions({ taskId: "t1" });
  expect(row?.agentId).toBe("architect");
  expect(row?.status).toBe("active");
});

test("listSessions filters, and archived sessions drop out unless asked for", () => {
  const s = store();
  const a = s.createSession({ agentId: "a", kind: "task", provider: "p", model: "m", taskId: "t1" });
  const b = s.createSession({ agentId: "b", kind: "fork", provider: "p", model: "m", taskId: "t1", parentSessionId: a });
  s.createSession({ agentId: "a", kind: "task", provider: "p", model: "m", taskId: "t2" });

  expect(s.listSessions({ taskId: "t1" }).map((r) => r.id)).toEqual([a, b]);
  expect(s.listSessions({ parentSessionId: a }).map((r) => r.id)).toEqual([b]);
  expect(s.listSessions({ agentId: "a" })).toHaveLength(2);

  s.archiveSession(b);
  expect(s.listSessions({ taskId: "t1" }).map((r) => r.id)).toEqual([a]);
  expect(s.listSessions({ taskId: "t1", includeArchived: true })).toHaveLength(2);
});

test("setStatus marks how a session ended", () => {
  const s = store();
  const id = s.createSession({ agentId: "a", kind: "task", provider: "p", model: "m" });
  s.setStatus(id, "exhausted");
  expect(s.getSession(id)?.status).toBe("exhausted");
});

test("checkpoint → undo restores an overwritten file and deletes a created one", () => {
  const s = store();
  const dir = mkdtempSync(join(tmpdir(), "amux-undo-"));
  const id = s.createSession({ agentId: "a", kind: "task", provider: "p", model: "m" });
  const existing = join(dir, "kept.txt");
  const created = join(dir, "new.txt");
  writeFileSync(existing, "original");

  s.checkpoint(id, existing, "original"); // overwrite: remember what was there
  writeFileSync(existing, "agent version");
  s.checkpoint(id, created, null); // creation: nothing was there
  writeFileSync(created, "brand new");

  expect(s.undoLast(id)).toEqual({ path: created, action: "deleted" }); // LIFO: newest write first
  expect(existsSync(created)).toBe(false);
  expect(s.undoLast(id)).toEqual({ path: existing, action: "restored" });
  expect(readFileSync(existing, "utf8")).toBe("original");
  expect(s.undoLast(id)).toBeUndefined(); // nothing left to undo
});

test("undoLast with no session id reverts the most recent write by any agent", () => {
  const s = store();
  const dir = mkdtempSync(join(tmpdir(), "amux-undo-"));
  const a = s.createSession({ agentId: "a", kind: "task", provider: "p", model: "m" });
  const b = s.createSession({ agentId: "b", kind: "task", provider: "p", model: "m" });
  const file = join(dir, "shared.txt");
  writeFileSync(file, "v1");
  s.checkpoint(a, file, "v1");
  writeFileSync(file, "v2");
  s.checkpoint(b, file, "v2");
  writeFileSync(file, "v3");

  expect(s.undoLast()?.action).toBe("restored");
  expect(readFileSync(file, "utf8")).toBe("v2");
});

test("resumeConversation flattens every session for a task, oldest first", () => {
  const s = store();
  const first = s.createSession({ agentId: "a", kind: "task", provider: "p", model: "m", taskId: "t1" });
  s.appendMessage(first, "user", toParts({ role: "user", text: "first run" }));
  const second = s.createSession({ agentId: "a", kind: "task", provider: "p", model: "m", taskId: "t1" });
  s.appendMessage(second, "user", toParts({ role: "user", text: "second run" }));
  s.createSession({ agentId: "a", kind: "task", provider: "p", model: "m", taskId: "other" });

  expect(resumeConversation(s, "t1")).toEqual([
    { role: "user", text: "first run" },
    { role: "user", text: "second run" },
  ]);
  expect(resumeConversation(s, "nope")).toEqual([]);
});
