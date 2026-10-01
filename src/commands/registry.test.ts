import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRegistry, BUILTIN_COMMANDS, loadCommands } from "./registry.ts";
import { Engine } from "../engine.ts";
import { openDb } from "../store/db.ts";
import { SessionStore } from "../store/session-store.ts";
import type { Provider } from "../providers/provider.ts";

const stub: Provider = { async send() { return { text: "ok", toolCalls: [] }; } };

function engine(store?: SessionStore): Engine {
  return new Engine({
    configs: [{ id: "a", provider: "anthropic", model: "m", role: "r", systemPrompt: "s" }],
    makeProvider: () => stub,
    store,
  });
}

test("view commands are a pure client-side switch", async () => {
  const r = new CommandRegistry(BUILTIN_COMMANDS);
  expect(await r.run(engine(), "usage")).toEqual({ ok: true, message: "", view: "usage" });
});

test("/rewind defaults to one step and reports nothing to rewind when the queue is empty", async () => {
  const store = new SessionStore(openDb(":memory:"));
  const r = new CommandRegistry(BUILTIN_COMMANDS);
  expect(await r.run(engine(store), "rewind")).toEqual({ ok: true, message: "nothing to rewind" });
});

test("/rewind n pops n checkpoints in one call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "niti-rewind-cmd-"));
  const file = join(dir, "f.txt");
  writeFileSync(file, "v2");
  const store = new SessionStore(openDb(":memory:"));
  const sid = store.createSession({ agentId: "a", kind: "task", provider: "p", model: "m" });
  // The engine first: it only rewinds writes made after it started, so a checkpoint created in an
  // earlier millisecond than the engine was "from an earlier launch" and the test failed under load.
  const e = engine(store);
  store.checkpoint(sid, file, "v1");
  const r = new CommandRegistry(BUILTIN_COMMANDS);
  const res = await r.run(e, "rewind", "1");
  expect(res.ok).toBe(true);
  expect(res.message).toContain("rewound 1 step");
});

test("/rewind only reaches this session's writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "niti-rewind-scope-"));
  const file = join(dir, "f.txt");
  writeFileSync(file, "v2");
  const db = openDb(":memory:");
  const store = new SessionStore(db);
  const sid = store.createSession({ agentId: "a", kind: "task", provider: "p", model: "m" });
  store.checkpoint(sid, file, "v1");
  const e = engine(store);
  // A checkpoint from before this engine started belongs to an earlier launch.
  db.query("UPDATE checkpoints SET created_at = 1").run();
  expect(e.rewind(1)).toBe("nothing to rewind");
  expect(readFileSync(file, "utf8")).toBe("v2");
});

test("/rewind keeps going past a checkpoint whose directory is gone", () => {
  const dir = mkdtempSync(join(tmpdir(), "niti-rewind-gone-"));
  const file = join(dir, "f.txt");
  writeFileSync(file, "v2");
  const store = new SessionStore(openDb(":memory:"));
  const sid = store.createSession({ agentId: "a", kind: "task", provider: "p", model: "m" });
  store.checkpoint(sid, file, "v1");
  store.checkpoint(sid, join(dir, "gone", "x.txt"), "old"); // e.g. a discarded worktree
  const msg = engine(store).rewind(2);
  expect(msg).toContain("skipped");
  expect(readFileSync(file, "utf8")).toBe("v1");
});

test("/branch requires a name and a git repo", async () => {
  const r = new CommandRegistry(BUILTIN_COMMANDS);
  expect(await r.run(engine(), "branch", "")).toEqual({ ok: false, message: "usage: /branch <name>" });

  const nonGitRoot = mkdtempSync(join(tmpdir(), "niti-branch-nongit-"));
  const notGit = await r.run(new Engine({ configs: [], makeProvider: () => stub, root: nonGitRoot }), "branch", "my-snapshot");
  expect(notGit).toEqual({ ok: false, message: "not a git repository" });
});

test("/debate requires two known agents and a question", async () => {
  const r = new CommandRegistry(BUILTIN_COMMANDS);
  expect(await r.run(engine(), "debate", "")).toEqual({ ok: false, message: "usage: /debate <agentA> <agentB> <question>" });
  expect(await r.run(engine(), "debate", "a ghost is this a good idea?")).toEqual({ ok: false, message: "no such agent: ghost" });
});

function twoAgentEngine(replies: string[], onSend?: (n: number) => void) {
  let n = 0;
  const stub: Provider = {
    async send() {
      onSend?.(n);
      return { text: replies[n++] ?? "done", toolCalls: [] };
    },
  };
  return new Engine({
    configs: [
      { id: "a", provider: "anthropic", model: "m", role: "r", systemPrompt: "s" },
      { id: "b", provider: "openai", model: "m", role: "r", systemPrompt: "s" },
    ],
    makeProvider: () => stub,
  });
}

const sevenReplies = ["point 1", "point 2", "point 3", "point 4", "point 5", "point 6", "final synthesis"];

test("/debate starts in the background instead of holding the request open for seven model calls", async () => {
  const e = twoAgentEngine(sevenReplies);
  const r = new CommandRegistry(BUILTIN_COMMANDS);
  const res = await r.run(e, "debate", "a b should we use REST or gRPC?");
  expect(res).toEqual({ ok: true, message: expect.stringContaining("debate started: a vs b") });
  expect(await r.run(e, "debate", "a b again?")).toEqual({ ok: false, message: expect.stringContaining("running") });
  while (e.running) await new Promise((r) => setTimeout(r, 5));
});

test("engine.debate alternates two agents, streams each turn, and finishes both agents", async () => {
  const e = twoAgentEngine(sevenReplies);
  const seen: string[] = [];
  e.bus.subscribe((ev) => seen.push(`${ev.agentId}:${ev.type}`));
  const out = await e.debate("a", "b", "REST or gRPC?");
  expect(out).toContain("## Debate: a vs b");
  expect(out).toContain("point 1");
  expect(out).toContain("point 6");
  expect(out).toContain("## Synthesis");
  expect(out).toContain("final synthesis");
  expect(seen.filter((s) => s.endsWith(":message"))).toHaveLength(7);
  expect(seen.slice(-2)).toEqual(["a:done", "b:done"]); // otherwise the TUI leaves both stuck on "working"
  expect(e.running).toBe(false);
});

test("a provider failure ends a debate early but keeps what was said", async () => {
  const e = twoAgentEngine(sevenReplies, (n) => {
    if (n === 3) throw new Error("rate limited");
  });
  const out = await e.debate("a", "b", "q");
  expect(out).toContain("point 3");
  expect(out).not.toContain("point 4");
  expect(out).toContain("Stopped early: rate limited");
  expect(e.running).toBe(false);
});

test("/cancel stops a debate between turns, and a cancelled run does not poison the next ask", async () => {
  const e = twoAgentEngine(sevenReplies, (n) => {
    if (n === 2) e.cancel();
  });
  const out = await e.debate("a", "b", "q");
  expect(out).toContain("Stopped early: cancelled");
  expect(e.running).toBe(false);
  // The aborted controller is dropped, so a later debate starts clean instead of throwing "interrupted".
  const again = await twoAgentEngine(sevenReplies).debate("a", "b", "q");
  expect(again).toContain("## Synthesis");
  const next = await e.debate("a", "b", "q");
  expect(next).not.toContain("interrupted");
});

test("/model validates its arguments before touching the engine", async () => {
  const r = new CommandRegistry(BUILTIN_COMMANDS);
  expect(await r.run(engine(), "model", "")).toEqual({ ok: false, message: "usage: /model <agentId> <provider/model>" });
  const missing = await r.run(engine(), "model", "nobody anthropic/claude-opus-4-8");
  expect(missing.ok).toBe(false);
  expect(missing.message).toMatch(/no such agent/);
});

test("/sessions lists what the store holds", async () => {
  const store = new SessionStore(openDb(":memory:"));
  store.createSession({ agentId: "architect", kind: "task", provider: "google", model: "gemini", taskId: "t1" });
  const r = new CommandRegistry(BUILTIN_COMMANDS);
  const out = await r.run(engine(store), "sessions");
  expect(out.message).toContain("architect");
  expect(out.message).toContain("google/gemini");
  expect((await r.run(engine(store), "sessions", "t2")).message).toBe("no sessions yet"); // filtered by task
});

test("an unknown command is reported, not thrown", async () => {
  expect(await new CommandRegistry(BUILTIN_COMMANDS).run(engine(), "nope")).toEqual({ ok: false, message: "unknown command: /nope" });
});

test("a .niti/commands/*.md file becomes a command that submits its body", async () => {
  const dir = mkdtempSync(join(tmpdir(), "niti-cmds-"));
  writeFileSync(join(dir, "review.md"), "---\nname: review\ndescription: Review the diff\n---\nReview the changes in $ARGUMENTS and report problems.\n");

  const [cmd] = loadCommands(dir);
  expect(cmd?.name).toBe("review");
  expect(cmd?.description).toBe("Review the diff");

  const e = engine();
  let submitted = "";
  e.submit = async (goal: string) => { submitted = goal; };
  expect((await cmd!.run(e, "src/agent")).ok).toBe(true);
  expect(submitted).toBe("Review the changes in src/agent and report problems.");
});

test("a file without frontmatter still works, named after the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "niti-cmds-"));
  writeFileSync(join(dir, "ship.md"), "Ship it.");
  expect(loadCommands(dir).map((c) => c.name)).toEqual(["ship"]);
  expect(loadCommands("/no/such/dir")).toEqual([]);
});

test("a user command overrides a built-in of the same name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "niti-cmds-"));
  writeFileSync(join(dir, "rewind.md"), "---\ndescription: mine\n---\nbody\n");
  const r = new CommandRegistry([...BUILTIN_COMMANDS, ...loadCommands(dir)]);
  expect(r.list().find((c) => c.name === "rewind")?.description).toBe("mine");
  expect(r.list().filter((c) => c.name === "rewind")).toHaveLength(1);
});

test("list() is what a client renders for autocomplete", () => {
  const names = new CommandRegistry(BUILTIN_COMMANDS).list().map((c) => c.name);
  // Order matters: it's the order the TUI's "/" menu offers them in, and /help is appended last.
  expect(names).toEqual([
    "usage", "auto", "manual", "cancel", "rewind", "branch", "model", "sessions",
    "agents", "tasks", "skills", "mcp", "lsp", "permissions", "cost", "status", "debate", "export", "resume", "clear", "init",
    "help",
  ]);
  expect(new Set(names).size).toBe(names.length); // every name unique — one keystroke, one command
});

test("/help lists every command, including ones loaded from .niti/commands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "niti-cmd-"));
  writeFileSync(join(dir, "ship.md"), "---\nname: ship\ndescription: Ship it\n---\nDo the thing");
  const r = new CommandRegistry([...BUILTIN_COMMANDS, ...loadCommands(dir)]);

  const help = await r.run(engine(), "help");
  expect(help.ok).toBe(true);
  for (const name of ["/help", "/model", "/agents", "/tasks", "/status", "/cost", "/ship"]) {
    expect(help.message).toContain(name);
  }
});

test("the read-only commands report the engine's actual state", async () => {
  const r = new CommandRegistry(BUILTIN_COMMANDS);
  const e = engine();

  expect((await r.run(e, "agents")).message).toContain("anthropic/m");
  expect((await r.run(e, "tasks")).message).toMatch(/no tasks yet/);
  expect((await r.run(e, "mcp")).message).toMatch(/no MCP servers/);
  expect((await r.run(e, "lsp")).message).toMatch(/no language servers/);
  expect((await r.run(e, "permissions")).message).toContain("everything asks");
  expect((await r.run(e, "cost")).message).toMatch(/nothing spent yet/);
  expect((await r.run(e, "status")).message).toContain("team      1 agents");
});

test("/cost shows a cache line when a provider actually reported cache activity, and omits it otherwise", async () => {
  const r = new CommandRegistry(BUILTIN_COMMANDS);
  const e = new Engine({
    configs: [{ id: "a", provider: "anthropic", model: "claude-sonnet-5", role: "r", systemPrompt: "s" }],
    makeProvider: () => stub,
  });
  e.usage.record("a", 1000, 200, 900, 50);
  const withCache = (await r.run(e, "cost")).message;
  expect(withCache).toContain("cache 900in 50wr");

  const e2 = new Engine({
    configs: [{ id: "a", provider: "anthropic", model: "claude-sonnet-5", role: "r", systemPrompt: "s" }],
    makeProvider: () => stub,
  });
  e2.usage.record("a", 1000, 200); // no cache activity at all
  const withoutCache = (await r.run(e2, "cost")).message;
  expect(withoutCache).not.toContain("cache");
});

test("/clear empties the board, and refuses while work is running", async () => {
  const r = new CommandRegistry(BUILTIN_COMMANDS);
  const e = engine();
  e.orch.addTask("write the parser");
  e.orch.addTask("write its tests");

  expect(await r.run(e, "clear")).toEqual({ ok: true, message: "session cleared (2 tasks dropped)" });
  expect(e.orch.all).toHaveLength(0);
  expect((await r.run(e, "resume")).message).toMatch(/nothing left to resume/);
});

test("/clear is a full reset: ids, usage, notes, undo stack, stored sessions and the replay buffer", async () => {
  const store = new SessionStore(openDb(":memory:"));
  const e = engine(store);
  const r = new CommandRegistry(BUILTIN_COMMANDS);
  e.orch.addTask("one");
  e.history.push({ goal: "g", outcome: "o" });
  e.usage.record("a", 1000, 200);
  e.messageBus.remember("a", "k", "v");
  const sid = store.createSession({ agentId: "a", kind: "task", provider: "p", model: "m" });
  store.checkpoint(sid, join(tmpdir(), "niti-clear-x"), null);
  e.hub.publish({ kind: "theme", theme: "old" });

  await r.run(e, "clear");

  expect(e.history).toHaveLength(0);
  expect(e.usage.totals().calls).toBe(0);
  expect(e.messageBus.recall()).toEqual([]);
  expect(e.orch.addTask("fresh").id).toBe("t1");
  expect(store.listSessions()).toHaveLength(0); // archived, so hidden
  expect(store.listCheckpoints()).toHaveLength(0);
  // What survives in the replay buffer is the reset marker and the zeroed usage that follows it.
  expect(e.hub.replay(0).map((ev) => ev.kind)).toEqual(["session_reset", "usage"]);
});
