import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, overContextThreshold, isDangerousShellCall, leavesProjectRoot, SHELL_LOCK, MAX_FORK_DEPTH, type AgentConfig } from "./agent.ts";
import { Bus } from "../events/bus.ts";
import { ApprovalQueue } from "../approval.ts";
import { LockRegistry } from "../orchestrator/locks.ts";
import { openDb } from "../store/db.ts";
import { SessionStore } from "../store/session-store.ts";
import { UsageTracker } from "../usage.ts";
import { resumeConversation } from "../session.ts";
import type { Provider, Turn } from "../providers/provider.ts";
import type { AgentMessage, Messenger } from "../messaging/message-bus.ts";

const cfg: AgentConfig = {
  id: "a",
  provider: "anthropic",
  model: "x",
  role: "r",
  systemPrompt: "s",
  allowedTools: ["write_file"],
};

test("agent runs the full tool loop: request → sandboxed execute → feed back → finish", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-agent-"));

  // First call asks to write a file; second call (after seeing the result) finishes.
  let n = 0;
  const stub: Provider = {
    async send(_sys, _turns, _tools) {
      n++;
      if (n === 1) {
        return {
          text: "writing the file",
          toolCalls: [{ id: "1", name: "write_file", input: { path: "out.txt", content: "hi" } }],
        };
      }
      return { text: "done", toolCalls: [] };
    },
  };

  const bus = new Bus();
  const events: string[] = [];
  bus.subscribe((e) => events.push(e.type));

  const agent = new Agent(cfg, stub, bus, { root });
  const ok = await agent.run("make a file");

  expect(ok).toBe("done");
  expect(n).toBe(2); // looped: executed the tool, then finished
  expect(readFileSync(join(root, "out.txt"), "utf8")).toBe("hi"); // the sandbox actually wrote it
  expect(events).toEqual(expect.arrayContaining(["message", "tool_call", "file_edit", "done"]));
});

test("streams text deltas to the bus, then a final message", async () => {
  const bus = new Bus();
  // Stub that streams two chunks via onDelta, then returns the full text.
  const streamer: Provider = {
    async send(_sys, _turns, _tools, onDelta) {
      onDelta?.("Hel");
      onDelta?.("lo");
      return { text: "Hello", toolCalls: [] };
    },
  };
  const deltas: string[] = [];
  const types: string[] = [];
  bus.subscribe((e) => {
    types.push(e.type);
    if (e.type === "delta") deltas.push(e.payload);
  });

  const ok = await new Agent({ ...cfg, allowedTools: [] }, streamer, bus).run("hi");
  expect(ok).toBe("done");
  expect(deltas).toEqual(["Hel", "lo"]); // live chunks reached the bus
  expect(types).toContain("message"); // and the final message settled
});

test("overContextThreshold triggers past the ratio", () => {
  expect(overContextThreshold(86, 100, 0.85)).toBe(true);
  expect(overContextThreshold(80, 100, 0.85)).toBe(false);
  expect(overContextThreshold(999, 0)).toBe(false); // unknown context → never warns
});

test("emits a single context warning when usage crosses the threshold", async () => {
  const bus = new Bus();
  // anthropic context is 1_000_000; report usage well above 85%.
  const stub: Provider = {
    async send() {
      return { text: "ok", toolCalls: [], usage: { inputTokens: 950_000, outputTokens: 10 } };
    },
  };
  const warnings: string[] = [];
  bus.subscribe((e) => {
    if (e.type === "warning") warnings.push(e.payload);
  });
  await new Agent({ ...cfg, provider: "anthropic", allowedTools: [] }, stub, bus).run("hi");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("context ~95% full");
});

test("auto-compacts turns once usage crosses 95% of the context window", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-agent-"));
  const bus = new Bus();
  const warnings: string[] = [];
  bus.subscribe((e) => {
    if (e.type === "warning") warnings.push(e.payload);
  });

  let n = 0;
  const seenLengths: number[] = [];
  const stub: Provider = {
    async send(_sys, turns) {
      n++;
      seenLengths.push(turns.length);
      if (n < 5) {
        return { text: "", toolCalls: [{ id: String(n), name: "write_file", input: { path: `f${n}.txt`, content: "x" } }] };
      }
      if (n === 5) {
        return {
          text: "",
          toolCalls: [{ id: "5", name: "write_file", input: { path: "f5.txt", content: "x" } }],
          usage: { inputTokens: 960_000, outputTokens: 10 }, // >95% of anthropic's 1_000_000 context
        };
      }
      return { text: "done", toolCalls: [] };
    },
  };

  const agent = new Agent({ ...cfg, provider: "anthropic", allowedTools: ["write_file"] }, stub, bus, { root });
  const outcome = await agent.run("build something long");

  expect(outcome).toBe("done");
  expect(seenLengths[4]).toBe(9); // 1 initial + 4 prior rounds × 2 turns, uncompacted going into call 5
  expect(seenLengths[5]).toBeLessThan(9); // call 6 sees the post-compaction (shrunk) array
  expect(warnings.some((w) => w.includes("context compacted automatically"))).toBe(true);
});

test("reconfigure swaps provider and updates config", async () => {
  const bus = new Bus();
  const first: Provider = { async send() { return { text: "first", toolCalls: [] }; } };
  const second: Provider = { async send() { return { text: "second", toolCalls: [] }; } };
  const agent = new Agent({ ...cfg, provider: "anthropic", model: "m1" }, first, bus);

  agent.reconfigure("deepseek", "deepseek-chat", second);
  expect(agent.config.provider).toBe("deepseek");
  expect(agent.config.model).toBe("deepseek-chat");
  expect(await agent.ask("hi")).toBe("second"); // now uses the swapped provider
});

test("busy is true while run() has a model call in flight, and false once it settles", async () => {
  const bus = new Bus();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const provider: Provider = {
    async send() {
      await gate;
      return { text: "done", toolCalls: [] };
    },
  };
  const agent = new Agent(cfg, provider, bus);
  expect(agent.busy).toBe(false);
  const running = agent.run("task");
  await Promise.resolve(); // let run() start and enter provider.send()
  expect(agent.busy).toBe(true);
  release();
  await running;
  expect(agent.busy).toBe(false);
});

test("busy stays true if run() and respond() overlap — one finishing must not clear it for the other", async () => {
  const bus = new Bus();
  let releaseRun!: () => void;
  let releaseRespond!: () => void;
  const runGate = new Promise<void>((r) => (releaseRun = r));
  const respondGate = new Promise<void>((r) => (releaseRespond = r));
  let call = 0;
  const provider: Provider = {
    async send() {
      call++;
      if (call === 1) {
        await runGate;
        return { text: "run done", toolCalls: [] };
      }
      await respondGate;
      return { text: "respond done", toolCalls: [] };
    },
  };
  const agent = new Agent(cfg, provider, bus);
  const running = agent.run("task");
  await Promise.resolve();
  const responding = agent.respond("question?", 0);
  await Promise.resolve();
  expect(agent.busy).toBe(true);

  releaseRespond(); // respond() finishes first — busy must stay true, run() is still in flight
  await responding;
  expect(agent.busy).toBe(true);

  releaseRun();
  await running;
  expect(agent.busy).toBe(false);
});

test("a denied gated tool is not executed and 'not approved' is fed back", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-agent-"));
  let n = 0;
  const stub: Provider = {
    async send() {
      n++;
      if (n === 1) return { text: "", toolCalls: [{ id: "1", name: "write_file", input: { path: "nope.txt", content: "x" } }] };
      return { text: "ok", toolCalls: [] };
    },
  };
  const bus = new Bus();
  const deny = async () => false; // user denies
  const agent = new Agent({ ...cfg, allowedTools: ["write_file"] }, stub, bus, { root, approve: deny });
  const ok = await agent.run("write a file");

  expect(ok).toBe("done");
  expect(existsSync(join(root, "nope.txt"))).toBe(false); // denial prevented the write
});

test("an approved gated tool runs normally", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-agent-"));
  let n = 0;
  const stub: Provider = {
    async send() {
      n++;
      if (n === 1) return { text: "", toolCalls: [{ id: "1", name: "write_file", input: { path: "yes.txt", content: "hi" } }] };
      return { text: "ok", toolCalls: [] };
    },
  };
  const agent = new Agent({ ...cfg, allowedTools: ["write_file"] }, stub, new Bus(), { root, approve: async () => true });
  await agent.run("write a file");
  expect(readFileSync(join(root, "yes.txt"), "utf8")).toBe("hi");
});

test("write_file waits on a lock another agent holds, via a shared LockRegistry", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-agent-"));
  const bus = new Bus();
  const locks = new LockRegistry(bus);
  // Lock keys are resolved absolute paths, so that two agents spelling the same file differently
  // ("shared.txt" vs "./shared.txt") still contend for one lock.
  await locks.acquire(join(root, "shared.txt"), "other-agent"); // simulate another agent mid-write

  let n = 0;
  const stub: Provider = {
    async send() {
      n++;
      if (n === 1) return { text: "", toolCalls: [{ id: "1", name: "write_file", input: { path: "shared.txt", content: "mine" } }] };
      return { text: "ok", toolCalls: [] };
    },
  };
  const agent = new Agent({ ...cfg, allowedTools: ["write_file"] }, stub, bus, { root, locks });

  let done = false;
  const runP = agent.run("write shared").then(() => (done = true));

  await new Promise((r) => setTimeout(r, 30));
  expect(done).toBe(false); // still blocked behind other-agent's lock
  expect(existsSync(join(root, "shared.txt"))).toBe(false);

  locks.release(join(root, "shared.txt"), "other-agent");
  await runP;
  expect(done).toBe(true);
  expect(readFileSync(join(root, "shared.txt"), "utf8")).toBe("mine");
});

test("a differently-spelled path takes the same lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-agent-"));
  const bus = new Bus();
  const locks = new LockRegistry(bus);
  await locks.acquire(join(root, "shared.txt"), "other-agent");

  let n = 0;
  const stub: Provider = {
    async send() {
      n++;
      // './shared.txt' and 'a/../shared.txt' are the same file as 'shared.txt'; keying the lock on
      // raw model output gave each spelling its own lock, i.e. no mutual exclusion at all.
      if (n === 1) return { text: "", toolCalls: [{ id: "1", name: "write_file", input: { path: "./shared.txt", content: "mine" } }] };
      return { text: "ok", toolCalls: [] };
    },
  };
  const agent = new Agent({ ...cfg, allowedTools: ["write_file"] }, stub, bus, { root, locks });

  let done = false;
  const runP = agent.run("write shared").then(() => (done = true));
  await new Promise((r) => setTimeout(r, 30));
  expect(done).toBe(false); // blocked, despite the different spelling
  expect(existsSync(join(root, "shared.txt"))).toBe(false);

  locks.release(join(root, "shared.txt"), "other-agent");
  await runP;
  expect(readFileSync(join(root, "shared.txt"), "utf8")).toBe("mine");
});

test("shell calls serialize on one global lock, since args are opaque to us", async () => {
  const bus = new Bus();
  const locks = new LockRegistry(bus);
  await locks.acquire(SHELL_LOCK, "other-agent"); // simulate another agent mid-shell-command

  let n = 0;
  const stub: Provider = {
    async send() {
      n++;
      if (n === 1) return { text: "", toolCalls: [{ id: "1", name: "shell", input: { command: "echo", args: ["hi"] } }] };
      return { text: "ok", toolCalls: [] };
    },
  };
  const agent = new Agent({ ...cfg, allowedTools: ["shell"] }, stub, bus, { locks });

  let done = false;
  const runP = agent.run("run a command").then(() => (done = true));

  await new Promise((r) => setTimeout(r, 30));
  expect(done).toBe(false); // blocked behind other-agent's shell lock

  locks.release(SHELL_LOCK, "other-agent");
  await runP;
  expect(done).toBe(true);
});

test("isDangerousShellCall flags destructive patterns and ignores everything else", () => {
  expect(isDangerousShellCall("shell", { command: "rm", args: ["-rf", "/"] })).toBe(true);
  expect(isDangerousShellCall("shell", { command: "git", args: ["push", "--force"] })).toBe(true);
  expect(isDangerousShellCall("shell", { command: "git", args: ["reset", "--hard"] })).toBe(true);
  expect(isDangerousShellCall("shell", { command: "npm", args: ["test"] })).toBe(false);
  expect(isDangerousShellCall("write_file", { command: "rm -rf /" })).toBe(false); // not a shell call
});

test("a dangerous shell command still prompts even with a standing 'always allow shell' grant", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-agent-"));
  const bus = new Bus();
  const approvals = new ApprovalQueue();
  approvals.grant("a", "shell"); // as if the user had already clicked "always allow shell for a"

  let n = 0;
  const stub: Provider = {
    async send() {
      n++;
      if (n === 1) return { text: "", toolCalls: [{ id: "1", name: "shell", input: { command: "rm", args: ["-rf", "/"] } }] };
      return { text: "ok", toolCalls: [] };
    },
  };
  const agent = new Agent({ ...cfg, allowedTools: ["shell"] }, stub, bus, {
    root,
    approve: (tool, input, forceAsk) => approvals.request("a", tool, input, forceAsk),
  });

  const runP = agent.run("clean up");
  await new Promise((r) => setTimeout(r, 10));
  expect(approvals.current()?.tool).toBe("shell"); // queued despite the grant — dangerous overrides it
  approvals.answer(false);
  expect(await runP).toBe("done"); // denied, not executed, loop still finishes cleanly
});

test("with a store, loadTurns reconstructs exactly what was fed to provider.send()", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-agent-"));
  const store = new SessionStore(openDb(":memory:"));
  let n = 0;
  let lastSeen: Turn[] = [];
  const stub: Provider = {
    async send(_sys, turns) {
      n++;
      lastSeen = structuredClone(turns); // snapshot: the array is mutated in place by the loop
      if (n === 1) {
        return { text: "writing", toolCalls: [{ id: "1", name: "write_file", input: { path: "s.txt", content: "hi" } }], raw: [{ type: "thinking" }] };
      }
      return { text: "all done", toolCalls: [] };
    },
  };

  const agent = new Agent({ ...cfg, allowedTools: ["write_file"] }, stub, new Bus(), { root, store });
  expect(await agent.run("write a file", { taskId: "t1" })).toBe("done");

  const [session] = store.listSessions({ taskId: "t1" });
  expect(session?.status).toBe("done");
  const stored = store.loadTurns(session!.id);
  // Everything the model saw on its final call, plus the final assistant answer that ended the loop.
  expect(stored.slice(0, lastSeen.length)).toEqual(lastSeen);
  expect(stored.at(-1)).toEqual({ role: "assistant", text: "all done", toolCalls: [] });
  expect(resumeConversation(store, "t1")).toEqual(stored);
});

test("priorTurns seed a resumed run without being persisted twice", async () => {
  const store = new SessionStore(openDb(":memory:"));
  let seen: Turn[] = [];
  const stub: Provider = {
    async send(_sys, turns) {
      seen = structuredClone(turns);
      return { text: "ok", toolCalls: [] };
    },
  };
  const prior: Turn[] = [{ role: "user", text: "earlier work" }];
  const agent = new Agent({ ...cfg, allowedTools: [] }, stub, new Bus(), { store });
  await agent.run("continue", { taskId: "t9", priorTurns: prior });

  expect(seen[0]).toEqual(prior[0]!); // the model saw the resumed history
  const [session] = store.listSessions({ taskId: "t9" });
  // ...but this session only owns the new turns — prior ones stay attached to the session that made them.
  expect(store.loadTurns(session!.id)).toEqual([
    { role: "user", text: "continue" },
    { role: "assistant", text: "ok", toolCalls: [] },
  ]);
});

test("a config 'allow' runs the tool without ever queuing an approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-agent-"));
  const approvals = new ApprovalQueue();
  let n = 0;
  const stub: Provider = {
    async send() {
      n++;
      if (n === 1) return { text: "", toolCalls: [{ id: "1", name: "write_file", input: { path: "src/ok.txt", content: "hi" } }] };
      return { text: "ok", toolCalls: [] };
    },
  };
  mkdirSync(join(root, "src"));
  const agent = new Agent({ ...cfg, allowedTools: ["write_file"], permissions: { write_file: { "src/**": "allow" } } }, stub, new Bus(), {
    root,
    approve: (tool, input, forceAsk) => approvals.request("a", tool, input, forceAsk),
  });

  expect(await agent.run("write it")).toBe("done");
  expect(approvals.current()).toBeUndefined(); // never prompted
  expect(readFileSync(join(root, "src/ok.txt"), "utf8")).toBe("hi");
});

test("a config 'deny' short-circuits without queuing — and holds in headless mode (no approver)", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-agent-"));
  let n = 0;
  const stub: Provider = {
    async send() {
      n++;
      if (n === 1) return { text: "", toolCalls: [{ id: "1", name: "write_file", input: { path: "secret.txt", content: "x" } }] };
      return { text: "ok", toolCalls: [] };
    },
  };
  const bus = new Bus();
  const errors: string[] = [];
  bus.subscribe((e) => e.type === "error" && errors.push(e.payload));

  // No `approve` at all: headless. A deny is policy, not a question, so it must still block.
  const agent = new Agent({ ...cfg, allowedTools: ["write_file"], permissions: { write_file: { "secret*": "deny" } } }, stub, bus, { root });
  expect(await agent.run("write it")).toBe("done");
  expect(existsSync(join(root, "secret.txt"))).toBe(false);
  expect(errors.some((e) => e.includes("denied by permission policy"))).toBe(true);
});

test("a dangerous shell command still prompts despite a blanket allow rule", async () => {
  const approvals = new ApprovalQueue();
  let n = 0;
  const stub: Provider = {
    async send() {
      n++;
      if (n === 1) return { text: "", toolCalls: [{ id: "1", name: "shell", input: { command: "rm", args: ["-rf", "/tmp/x"] } }] };
      return { text: "ok", toolCalls: [] };
    },
  };
  const agent = new Agent({ ...cfg, allowedTools: ["shell"] }, stub, new Bus(), {
    approve: (tool, input, forceAsk) => approvals.request("a", tool, input, forceAsk),
    permissionLayers: [{ "*": { "*": "allow" } }], // as if --auto were on
  });

  const runP = agent.run("clean up");
  await new Promise((r) => setTimeout(r, 10));
  expect(approvals.current()?.tool).toBe("shell"); // dangerous overrides the allow
  approvals.answer(false);
  expect(await runP).toBe("done");
});

test("an edit is checkpointed before it runs, shows a diff in the approval, and undoes cleanly", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-agent-"));
  writeFileSync(join(root, "app.ts"), "const port = 3000;\n");
  const store = new SessionStore(openDb(":memory:"));
  const approvals = new ApprovalQueue();

  let n = 0;
  const stub: Provider = {
    async send() {
      n++;
      if (n === 1) {
        return { text: "", toolCalls: [{ id: "1", name: "edit", input: { path: "app.ts", oldString: "3000", newString: "8080" } }] };
      }
      return { text: "ok", toolCalls: [] };
    },
  };
  const agent = new Agent({ ...cfg, allowedTools: ["edit"] }, stub, new Bus(), {
    root,
    store,
    approve: (tool, input, forceAsk) => approvals.request("a", tool, input, forceAsk),
  });

  const runP = agent.run("change the port", { taskId: "t1" });
  await new Promise((r) => setTimeout(r, 10));
  expect(approvals.current()?.input.diff).toBe("@@ line 1 @@\n-3000\n+8080"); // hunk offered to the user
  approvals.answer(true);
  await runP;

  expect(readFileSync(join(root, "app.ts"), "utf8")).toBe("const port = 8080;\n");
  expect(store.undoLast()?.action).toBe("restored");
  expect(readFileSync(join(root, "app.ts"), "utf8")).toBe("const port = 3000;\n"); // back to disk truth
});

test("a denied write is never checkpointed — undo has nothing to revert", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-agent-"));
  const store = new SessionStore(openDb(":memory:"));
  let n = 0;
  const stub: Provider = {
    async send() {
      n++;
      if (n === 1) return { text: "", toolCalls: [{ id: "1", name: "write_file", input: { path: "no.txt", content: "x" } }] };
      return { text: "ok", toolCalls: [] };
    },
  };
  await new Agent({ ...cfg, allowedTools: ["write_file"] }, stub, new Bus(), { root, store, approve: async () => false }).run("write", { taskId: "t1" });
  expect(store.undoLast()).toBeUndefined();
});

test("a write that fails is never checkpointed — undo has nothing to revert", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-agent-"));
  const store = new SessionStore(openDb(":memory:"));
  let n = 0;
  const stub: Provider = {
    async send() {
      n++;
      // `edit` on a file that doesn't exist: runTool throws, so the write never lands.
      if (n === 1) return { text: "", toolCalls: [{ id: "1", name: "edit", input: { path: "missing.ts", oldString: "a", newString: "b" } }] };
      return { text: "ok", toolCalls: [] };
    },
  };
  await new Agent({ ...cfg, allowedTools: ["edit"] }, stub, new Bus(), { root, store, approve: async () => true }).run("edit", { taskId: "t1" });
  expect(store.undoLast()).toBeUndefined();
});

test("a message that lands on the finishing turn is read by that run, not stranded", async () => {
  // The nudge case: POST /agents/:id/message reports "delivered" while the agent is mid-run, but
  // the turn in flight was about to end the loop. The run has to keep going and read it.
  const bus = new Bus();
  const inbox: AgentMessage[] = [];
  const messenger: Messenger = {
    peers: () => [{ id: "b", role: "other" }],
    send: () => "ok",
    ask: async () => "ok",
    inbox: () => inbox.splice(0, inbox.length),
    pending: () => inbox.length,
  };
  const seen: string[] = [];
  const stub: Provider = {
    async send(_sys, turns) {
      seen.push(turns.map((t) => (t.role === "user" ? t.text : "")).join("|"));
      // The nudge lands *while this call is in flight* — after injectInbox already ran for this
      // turn, which is precisely the window POST /agents/:id/message reported "delivered" in.
      if (seen.length === 1) {
        inbox.push({ id: "m1", from: "user", to: "a", kind: "handoff", subject: "change of plan", body: "also add PURPLE", time: Date.now() });
      }
      return { text: "finished", toolCalls: [] }; // every turn would end the loop
    },
  };
  const out = await new Agent(cfg, stub, bus, { messenger }).runDetailed("do the thing");

  expect(out.outcome).toBe("done");
  expect(seen).toHaveLength(2); // looped again instead of returning on the first turn
  expect(seen[1]).toContain("also add PURPLE"); // and the nudge was actually in that turn's context
});

test("a message arriving on the last allowed turn does not downgrade a finished run", async () => {
  // The inbox never empties here, so without the turns-left guard the loop would run to the cap
  // and report "exhausted" for work the model had already finished.
  const messenger: Messenger = {
    peers: () => [{ id: "b", role: "other" }],
    send: () => "ok",
    ask: async () => "ok",
    inbox: () => [],
    pending: () => 1,
  };
  let calls = 0;
  const stub: Provider = {
    async send() {
      calls++;
      return { text: "finished", toolCalls: [] };
    },
  };
  const out = await new Agent(cfg, stub, new Bus(), { messenger, maxTurns: 3 }).runDetailed("do the thing");

  expect(out.outcome).toBe("done");
  expect(calls).toBe(3); // kept looping while the inbox was full, then finished on the last turn
});

test("ask() records its tokens — the orchestrator's plan/integrate turns are not off the books", async () => {
  const usage = new UsageTracker();
  const stub: Provider = {
    async send() {
      return { text: "a plan", toolCalls: [], usage: { inputTokens: 100, outputTokens: 20 } };
    },
  };
  await new Agent(cfg, stub, new Bus(), { usageTracker: usage }).ask("plan this");
  expect(usage.snapshot()).toEqual([{ agentId: "a", usage: { inputTokens: 100, outputTokens: 20, calls: 1, lastInput: 100 } }]);
});

test("spawn_fork runs a child loop, links its session to the parent, and returns its findings", async () => {
  const store = new SessionStore(openDb(":memory:"));
  let call = 0;
  const stub: Provider = {
    async send(_sys, turns) {
      call++;
      if (call === 1) return { text: "", toolCalls: [{ id: "1", name: "spawn_fork", input: { goal: "count the routes" } }] };
      if (call === 2) {
        expect(turns[0]).toEqual({ role: "user", text: "count the routes" }); // the fork starts fresh, on its own goal
        return { text: "there are 7 routes", toolCalls: [] };
      }
      return { text: "parent wraps up", toolCalls: [] };
    },
  };
  const agent = new Agent({ ...cfg, allowedTools: [] }, stub, new Bus(), { store });
  expect(await agent.run("audit the server", { taskId: "t1" })).toBe("done");
  expect(agent.output).toBe("parent wraps up"); // the fork never overwrote the parent's output

  const [parent] = store.listSessions({ taskId: "t1" });
  const [fork] = store.listSessions({ parentSessionId: parent!.id });
  expect(fork?.kind).toBe("fork");
  const forkTurns = store.loadTurns(fork!.id);
  expect(forkTurns.at(-1)).toEqual({ role: "assistant", text: "there are 7 routes", toolCalls: [] });
  // ...and the parent got the finding back as its tool result.
  expect(store.loadTurns(parent!.id).some((t) => t.role === "tool" && t.results[0]?.output === "there are 7 routes")).toBe(true);
});

test("forks stop at MAX_FORK_DEPTH instead of nesting forever", async () => {
  let forks = 0;
  const stub: Provider = {
    async send(_sys, turns, tools) {
      const alreadyForked = turns.some((t) => t.role === "tool"); // one fork per level, then stop
      if (!alreadyForked && tools.some((t) => t.name === "spawn_fork")) {
        forks++;
        return { text: "", toolCalls: [{ id: String(forks), name: "spawn_fork", input: { goal: "deeper" } }] };
      }
      return { text: "bottom", toolCalls: [] };
    },
  };
  const agent = new Agent({ ...cfg, allowedTools: [] }, stub, new Bus());
  await agent.run("start");
  expect(forks).toBe(MAX_FORK_DEPTH); // the tool is withdrawn once the cap is reached, so nesting stops
});

test("a fork inherits the parent's tool permissions — no privilege escalation", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-agent-"));
  let call = 0;
  const stub: Provider = {
    async send() {
      call++;
      if (call === 1) return { text: "", toolCalls: [{ id: "1", name: "spawn_fork", input: { goal: "write it" } }] };
      if (call === 2) return { text: "", toolCalls: [{ id: "2", name: "write_file", input: { path: "x.txt", content: "y" } }] };
      return { text: "ok", toolCalls: [] };
    },
  };
  // Deny inherited from the parent config; the fork is the same Agent, so it's bound by it too.
  const agent = new Agent({ ...cfg, allowedTools: ["write_file"], permissions: { write_file: { "*": "deny" } } }, stub, new Bus(), { root });
  await agent.run("delegate a write");
  expect(existsSync(join(root, "x.txt"))).toBe(false);
});

test("a disallowed tool surfaces an error and doesn't crash the loop", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-agent-"));
  let n = 0;
  const stub: Provider = {
    async send() {
      n++;
      if (n === 1) return { text: "", toolCalls: [{ id: "1", name: "shell", input: { command: "ls" } }] };
      return { text: "ok", toolCalls: [] };
    },
  };
  const bus = new Bus();
  const events: string[] = [];
  bus.subscribe((e) => events.push(e.type));

  // allowedTools is write_file only → shell is rejected by the sandbox gate.
  const ok = await new Agent(cfg, stub, bus, { root }).run("run ls");
  expect(ok).toBe("done");
  expect(events).toContain("error");
  expect(events).toContain("done");
});

test("dangerous shell detection matches flag sets, not exact spellings", () => {
  const d = (command: string, args: string[] = []) => isDangerousShellCall("shell", { command, args });

  // The spellings the old substring list caught.
  expect(d("rm", ["-rf", "/tmp/x"])).toBe(true);
  expect(d("git", ["push", "--force"])).toBe(true);

  // ...and the equivalents it missed, every one of which a model may prefer.
  expect(d("rm", ["-fr", "/tmp/x"])).toBe(true);
  expect(d("rm", ["-r", "-f", "/tmp/x"])).toBe(true);
  expect(d("rm", ["--recursive", "--force", "/tmp/x"])).toBe(true);
  expect(d("git", ["push", "-f"])).toBe(true);
  expect(d("git", ["push", "--force-with-lease"])).toBe(true);
  expect(d("git", ["clean", "-fd"])).toBe(true);
  expect(d("find", [".", "-delete"])).toBe(true);
  expect(d("/bin/sh", ["-c", "rm -rf /"])).toBe(true); // opaque payload, and an absolute path
  expect(d("python3", ["-c", "import shutil"])).toBe(true);

  // Ordinary commands must still run without a prompt, including harmless rm and push.
  expect(d("rm", ["one.txt"])).toBe(false);
  expect(d("rm", ["-r", "build"])).toBe(false); // recursive but not forced
  expect(d("git", ["push"])).toBe(false);
  expect(d("ls", ["-la"])).toBe(false);
  expect(d("bash", ["script.sh"])).toBe(false); // running a file, not an inline payload
});

test("cancel stops an in-flight agent between turns instead of paying for the rest", async () => {
  // /cancel used to stop only the scheduler from launching *new* tasks — an agent already running
  // kept going for every remaining turn, each a billed call that could still write files.
  let cancelled = false;
  let calls = 0;
  const stub: Provider = {
    async send() {
      calls++;
      if (calls === 3) cancelled = true; // the user hits /cancel while this turn is in flight
      return { text: "", toolCalls: [{ id: String(calls), name: "write_file", input: { path: `f${calls}.txt`, content: "x" } }] };
    },
  };
  const root = mkdtempSync(join(tmpdir(), "niti-cancel-"));
  const agent = new Agent({ ...cfg, allowedTools: ["write_file"] }, stub, new Bus(), {
    root,
    approve: async () => true,
    shouldStop: () => cancelled,
  });

  const result = await agent.run("keep going");

  expect(result).toBe("failed");
  expect(calls).toBe(3); // the turn after the cancel never made a model call (cap is 12)
});

test("leavesProjectRoot spots a shell call reaching outside the project", () => {
  expect(leavesProjectRoot("shell", { command: "ls", args: [".."] })).toBe(true);
  expect(leavesProjectRoot("shell", { command: "cat", args: ["../../.ssh/id_rsa"] })).toBe(true);
  expect(leavesProjectRoot("shell", { command: "ls", args: ["/etc"] })).toBe(true);
  expect(leavesProjectRoot("shell", { command: "cat", args: ["src/../../x"] })).toBe(true);
  expect(leavesProjectRoot("shell", { command: "../evil.sh", args: [] })).toBe(true);
  // In-project work is untouched — this must not become another source of prompts.
  expect(leavesProjectRoot("shell", { command: "ls", args: ["-la"] })).toBe(false);
  expect(leavesProjectRoot("shell", { command: "cat", args: ["package.json"] })).toBe(false);
  expect(leavesProjectRoot("shell", { command: "git", args: ["status"] })).toBe(false);
  expect(leavesProjectRoot("read_file", { path: "../x" })).toBe(false); // safePath already jails these
});

test("a safe read-only shell command runs without asking, but not one reaching outside the root", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-agent-"));
  const asked: string[] = [];
  let n = 0;
  const stub: Provider = {
    async send() {
      n++;
      if (n === 1) return { text: "", toolCalls: [{ id: "1", name: "shell", input: { command: "ls", args: ["-la"] } }] };
      if (n === 2) return { text: "", toolCalls: [{ id: "2", name: "shell", input: { command: "ls", args: [".."] } }] };
      return { text: "done", toolCalls: [] };
    },
  };
  await new Agent({ ...cfg, allowedTools: ["shell"] }, stub, new Bus(), {
    root,
    approve: async (tool, input) => {
      asked.push(String((input as { args?: string[] }).args?.join(" ")));
      return true;
    },
  }).run("look around");

  // `ls -la` is on the built-in allowlist; `ls ..` leaves the project and still has to ask.
  expect(asked).toEqual([".."]);
});
