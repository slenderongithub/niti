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

test("rewindN reverts the last n writes at once, oldest of the n restored last", () => {
  const s = store();
  const dir = mkdtempSync(join(tmpdir(), "amux-rewind-"));
  const id = s.createSession({ agentId: "a", kind: "task", provider: "p", model: "m" });
  const file = join(dir, "f.txt");
  writeFileSync(file, "v1");
  s.checkpoint(id, file, "v1");
  writeFileSync(file, "v2");
  s.checkpoint(id, file, "v2");
  writeFileSync(file, "v3");

  const results = s.rewindN(2, id);
  expect(results).toEqual([
    { path: file, action: "restored" },
    { path: file, action: "restored" },
  ]);
  expect(readFileSync(file, "utf8")).toBe("v1"); // both writes undone, back to the original
  expect(s.undoLast(id)).toBeUndefined(); // nothing left
});

test("rewindN stops early (not partially applied past what exists) when fewer than n checkpoints remain", () => {
  const s = store();
  const dir = mkdtempSync(join(tmpdir(), "amux-rewind-"));
  const id = s.createSession({ agentId: "a", kind: "task", provider: "p", model: "m" });
  const file = join(dir, "only-one.txt");
  writeFileSync(file, "v1");
  s.checkpoint(id, file, "v1");
  writeFileSync(file, "v2");

  expect(s.rewindN(5, id)).toEqual([{ path: file, action: "restored" }]);
  expect(readFileSync(file, "utf8")).toBe("v1");
});

test("listCheckpoints previews pending writes, most recent first, without consuming them", () => {
  const s = store();
  const dir = mkdtempSync(join(tmpdir(), "amux-list-"));
  const id = s.createSession({ agentId: "a", kind: "task", provider: "p", model: "m" });
  const a = join(dir, "a.txt");
  const b = join(dir, "b.txt");
  s.checkpoint(id, a, "a1");
  s.checkpoint(id, b, "b1");

  const preview = s.listCheckpoints(id);
  expect(preview.map((c) => c.path)).toEqual([b, a]);
  expect(s.listCheckpoints(id)).toHaveLength(2); // read-only: nothing consumed
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

test("stats aggregates tokens by day and by model, and counts sessions", () => {
  const s = store();
  const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o });
  const a = s.createSession({ agentId: "architect", kind: "task", provider: "google", model: "gemini" });
  s.appendMessage(a, "assistant", [{ type: "text", content: "x" }], usage(100, 50));
  s.appendMessage(a, "assistant", [{ type: "text", content: "y" }], usage(200, 100));
  const b = s.createSession({ agentId: "backend", kind: "task", provider: "zhipuai", model: "glm" });
  s.appendMessage(b, "assistant", [{ type: "text", content: "z" }], usage(500, 500));

  const st = s.stats();
  expect(st.sessions).toBe(2);
  // Two models, ranked by total tokens desc → glm (1000) before gemini (450).
  expect(st.perModel.map((m) => `${m.provider}/${m.model}`)).toEqual(["zhipuai/glm", "google/gemini"]);
  const gemini = st.perModel.find((m) => m.model === "gemini");
  expect(gemini).toMatchObject({ inTokens: 300, outTokens: 150, msgs: 2 });
  // All messages land on the same (local) day here, so one perDay bucket holds every token.
  const total = st.perDay.reduce((n, d) => n + d.tokens, 0);
  expect(total).toBe(1450);
});
