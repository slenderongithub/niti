import { describe, expect, test } from "bun:test";
import { applyEvents, emptyState, fromSession, groupItems, steerTarget, taskCounts, type Item, type SessionState } from "./reducer";
import type { AgentEvent, ServerEvent, SessionInfo } from "./types";

const info = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  agents: [
    { id: "lead", provider: "custom", model: "fake", role: "Lead", systemPrompt: "", lead: true },
    { id: "dev", provider: "custom", model: "fake", role: "Dev", systemPrompt: "" },
  ],
  tasks: [],
  lastSeq: 0,
  running: false,
  root: "/p",
  lsp: [],
  mcp: [],
  contextLimits: { lead: 1000, dev: 2000 },
  settings: { autoCompact: true, thinkingMode: false },
  prefs: { lightMode: false, reduceMotion: false, showTurnDuration: false, openAgentsView: false, projectInstructions: true, notifyOnDone: true },
  auto: false,
  ...over,
});

let seq = 0;
const ev = (body: Record<string, unknown>): ServerEvent => ({ seq: ++seq, time: 1000 + seq, ...body }) as ServerEvent;
const ae = (e: Partial<AgentEvent> & { type: AgentEvent["type"] }): ServerEvent => ev({ kind: "agent_event", event: { agentId: "dev", payload: "", time: 1000 + seq, ...e } });
const items = (s: SessionState, id = "dev"): Item[] => s.agents[id]!.items;

describe("transcript", () => {
  test("a tool call starts running, streams output, and ends with its outcome", () => {
    let s = fromSession(info());
    s = applyEvents(s, [ae({ type: "tool_call", phase: "start", callId: "c1", tool: "read_file", payload: 'read_file {"path":"src/a.ts"}' })]);
    expect(s.agents.dev!.status).toBe("working");
    expect(items(s)[0]).toMatchObject({ kind: "tool", verb: "Read", target: "src/a.ts", status: "running" });
    expect(s.touched["src/a.ts"]).toBe("R");
    s = applyEvents(s, [ae({ type: "tool_call", phase: "end", callId: "c1", tool: "read_file", ok: true, durationMs: 40, outcome: "12 lines", payload: "read_file → x" })]);
    expect(items(s)[0]).toMatchObject({ kind: "tool", status: "ok", durationMs: 40, outcome: "12 lines" });
  });

  test("a write becomes a diff in place of its running call, and marks the file created", () => {
    let s = fromSession(info());
    s = applyEvents(s, [
      ae({ type: "tool_call", phase: "start", callId: "w", tool: "write_file", payload: 'write_file {"path":"index.html"}' }),
      ae({ type: "file_edit", phase: "end", callId: "w", tool: "write_file", path: "index.html", added: 1, removed: 0, hunks: [{ lines: [{ k: "+", t: "<h1>", o: 0, n: 1 }] }], payload: "write_file → ok" }),
    ]);
    expect(items(s)).toHaveLength(1);
    expect(items(s)[0]).toMatchObject({ kind: "diff", path: "index.html", created: true, added: 1 });
    expect(s.touched["index.html"]).toBe("A");
    expect(s.changedLines["index.html"]).toEqual([1]);
    expect(s.fileEpoch).toBe(1);
  });

  test("a shell call ends as a shell block with exit code and body", () => {
    let s = fromSession(info());
    s = applyEvents(s, [
      ae({ type: "tool_call", phase: "start", callId: "sh", tool: "shell", payload: 'shell {"command":"npm","args":["test"]}' }),
      ae({ type: "tool_output", callId: "sh", tool: "shell", payload: "running\n3 passed" }),
    ]);
    expect(items(s)[0]).toMatchObject({ kind: "tool", live: ["running", "3 passed"] });
    s = applyEvents(s, [ae({ type: "tool_call", phase: "end", callId: "sh", tool: "shell", ok: false, exitCode: 1, durationMs: 900, outcome: "1 failed", body: ["a", "b"], lines: 2, payload: "shell → x" })]);
    expect(items(s)[0]).toMatchObject({ kind: "shell", command: "npm test", ok: false, exitCode: 1, outcome: "1 failed", body: ["a", "b"] });
  });

  test("streamed deltas assemble, and the final message replaces them instead of repeating", () => {
    let s = fromSession(info());
    s = applyEvents(s, [ae({ type: "delta", payload: "Hel" }), ae({ type: "delta", payload: "lo" })]);
    expect(items(s)).toEqual([expect.objectContaining({ kind: "text", text: "Hello", streaming: true })]);
    s = applyEvents(s, [ae({ type: "message", payload: "Hello there" })]);
    expect(items(s)).toEqual([expect.objectContaining({ kind: "text", text: "Hello there", streaming: false })]);
  });

  test("an error fails the running call and the agent; a key error is flagged", () => {
    let s = fromSession(info());
    s = applyEvents(s, [
      ae({ type: "tool_call", phase: "start", callId: "e", tool: "edit", payload: 'edit {"path":"a.ts"}' }),
      ae({ type: "error", phase: "end", callId: "e", tool: "edit", ok: false, payload: "edit: error: oldString not found" }),
    ]);
    expect(items(s)[0]).toMatchObject({ kind: "tool", status: "fail" });
    expect(s.agents.dev!.status).toBe("failed");
    s = applyEvents(s, [ae({ type: "error", payload: "401 Unauthorized: invalid x-api-key" })]);
    expect(items(s).at(-1)).toMatchObject({ kind: "note", tone: "error", keyError: true });
  });

  test("the checklist stays pinned until every step is done", () => {
    let s = fromSession(info());
    s = applyEvents(s, [ae({ type: "todo", todos: [{ text: "a", status: "done" }, { text: "b", status: "doing" }] })]);
    expect(s.agents.dev!.todos).toHaveLength(2);
    s = applyEvents(s, [ae({ type: "todo", todos: [{ text: "a", status: "done" }, { text: "b", status: "done" }] })]);
    expect(s.agents.dev!.todos).toBeNull();
    expect(items(s).at(-1)).toMatchObject({ kind: "plan-done", steps: 2 });
  });

  test("a run ending settles anything left spinning", () => {
    let s = fromSession(info());
    s = applyEvents(s, [ev({ kind: "session", state: "started", goal: "g" }), ae({ type: "tool_call", phase: "start", callId: "x", tool: "grep", payload: 'grep {"pattern":"foo"}' })]);
    expect(s.active).toBe(true);
    s = applyEvents(s, [ev({ kind: "session", state: "ended" })]);
    expect(s.active).toBe(false);
    expect(items(s)[0]).toMatchObject({ status: "ok" });
    expect(s.agents.dev!.status).toBe("idle");
  });

  test("system and orchestrator events land in the system strip, not an agent", () => {
    let s = fromSession(info());
    s = applyEvents(s, [ev({ kind: "agent_event", event: { agentId: "orchestrator", type: "error", payload: "run failed: boom", time: 1 } })]);
    expect(s.system).toHaveLength(1);
    expect(items(s)).toHaveLength(0);
  });
});

describe("board, usage, approvals", () => {
  test("plan → started → done drives the board and progress", () => {
    let s = fromSession(info());
    s = applyEvents(s, [
      ev({ kind: "orchestration", event: { type: "plan", goal: "g", tasks: [{ id: "t1", description: "a", role: "dev", dependsOn: [] }, { id: "t2", description: "b", role: "lead", dependsOn: ["t1"] }], time: 1 } }),
      ev({ kind: "orchestration", event: { type: "task_started", taskId: "t1", role: "dev", time: 2 } }),
    ]);
    expect(s.tasks.map((t) => t.status)).toEqual(["in_progress", "pending"]);
    expect(s.agents.dev!.status).toBe("working");
    s = applyEvents(s, [ev({ kind: "orchestration", event: { type: "task_done", taskId: "t1", role: "dev", ok: true, completed: 1, total: 2, time: 3 } })]);
    expect(taskCounts(s.tasks)).toMatchObject({ done: 1, pending: 1 });
    expect(s.progress).toBe(50);
  });

  test("usage updates totals and each agent; approvals replace the queue", () => {
    let s = fromSession(info());
    s = applyEvents(s, [
      ev({ kind: "usage", agents: [{ agentId: "dev", usage: { inputTokens: 10, outputTokens: 5, calls: 1, lastInput: 10 } }], totals: { inputTokens: 10, outputTokens: 5, calls: 1 }, rateLimits: [], cost: 0.01, costKnown: true }),
      ev({ kind: "approval_request", requests: [{ agentId: "dev", tool: "shell", input: { command: "ls" } }] }),
    ]);
    expect(s.agents.dev!.usage.lastInput).toBe(10);
    expect(s.totals.inputTokens).toBe(10);
    expect(s.approvals).toHaveLength(1);
    s = applyEvents(s, [ev({ kind: "approval_request", requests: [] })]);
    expect(s.approvals).toHaveLength(0);
  });

  test("session_reset keeps the roster but drops the session", () => {
    let s = fromSession(info());
    s = applyEvents(s, [ae({ type: "message", payload: "hi" }), ev({ kind: "session_reset" })]);
    expect(s.order).toEqual(["lead", "dev"]);
    expect(items(s)).toHaveLength(0);
    expect(s.status).toBe("session cleared");
  });

  test("structural sharing: an event for one agent leaves the other untouched", () => {
    const s0 = fromSession(info());
    const s1 = applyEvents(s0, [ae({ type: "delta", payload: "x" })]);
    expect(s1.agents.lead).toBe(s0.agents.lead);
    expect(s1.agents.dev).not.toBe(s0.agents.dev);
    expect(applyEvents(s1, [])).toBe(s1);
  });
});

describe("helpers", () => {
  test("finished reads group; failures and edits stay single", () => {
    const tool = (id: number, verb: string, status: "ok" | "fail" = "ok"): Item => ({ id, kind: "tool", tool: "x", verb, target: `f${id}`, status, startedAt: 0, durationMs: 10 });
    const g = groupItems([tool(1, "Read"), tool(2, "Read"), tool(3, "Read"), tool(4, "Edit"), tool(5, "Read", "fail")]);
    expect(g.map((x) => x.kind)).toEqual(["group", "tool", "tool"]);
    expect(g[0]).toMatchObject({ verb: "Read", durationMs: 30 });
  });

  test("steerTarget: focused if working, else first working, else lead", () => {
    let s = fromSession(info());
    expect(steerTarget(s)).toBe("lead");
    s = applyEvents(s, [ae({ type: "delta", payload: "." })]);
    expect(steerTarget(s)).toBe("dev");
    expect(steerTarget(s, "lead")).toBe("dev");
  });

  test("a reconnect's resync and connection notices reach the status line", () => {
    let s = emptyState();
    s = applyEvents(s, [ev({ kind: "connection", state: "lost" })]);
    expect(s.connection).toBe("lost");
    s = applyEvents(s, [ev({ kind: "connection", state: "restored" }), ev({ kind: "resync", missed: 12 })]);
    expect(s.connection).toBe("online");
    expect(s.missed).toBe(12);
  });
});

test("/awake: the snapshot seeds it, events move it, and /clear leaves it alone", () => {
  let s = fromSession(info({ awake: "lid" }));
  expect(s.awake).toBe("lid");
  s = applyEvents(s, [ev({ kind: "session_reset" })]);
  expect(s.awake).toBe("lid");
  s = applyEvents(s, [ev({ kind: "awake", state: "off" })]);
  expect(s.awake).toBe("off");
  expect(fromSession(info()).awake).toBe("off"); // an older core sends no field
});

test("/goal: the snapshot seeds it, events move it, /clear keeps it, and a round ending says so", () => {
  const g = { objective: "ship", state: "running", reason: "", round: 1, maxRounds: 20, used: { tokens: 0, cost: 0 }, budget: {}, verdicts: [], notes: [], error: false } as const;
  let s = fromSession(info({ goal: g }));
  expect(s.goalStatus?.round).toBe(1);
  s = applyEvents(s, [ev({ kind: "session", state: "started", goal: "goal 1/20: ship" }), ev({ kind: "session", state: "ended" })]);
  expect(s.status).toContain("goal round 1 done");
  s = applyEvents(s, [ev({ kind: "session_reset" })]);
  expect(s.goalStatus?.state).toBe("running");
  s = applyEvents(s, [ev({ kind: "goal", status: { ...g, state: "done", reason: "tests pass" } })]);
  expect(s.goalStatus?.state).toBe("done");
  s = applyEvents(s, [ev({ kind: "goal", status: null })]);
  expect(s.goalStatus).toBeNull();
  expect(fromSession(info()).goalStatus).toBeNull(); // an older core sends no field
});
