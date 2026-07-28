import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, overContextThreshold, isDangerousShellCall, SHELL_LOCK, type AgentConfig } from "./agent.ts";
import { Bus } from "../events/bus.ts";
import { ApprovalQueue } from "../approval.ts";
import { LockRegistry } from "../orchestrator/locks.ts";
import type { Provider } from "../providers/provider.ts";

const cfg: AgentConfig = {
  id: "a",
  provider: "anthropic",
  model: "x",
  role: "r",
  systemPrompt: "s",
  allowedTools: ["write_file"],
};

test("agent runs the full tool loop: request → sandboxed execute → feed back → finish", async () => {
  const root = mkdtempSync(join(tmpdir(), "amux-agent-"));

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
  const root = mkdtempSync(join(tmpdir(), "amux-agent-"));
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

test("a denied gated tool is not executed and 'denied by user' is fed back", async () => {
  const root = mkdtempSync(join(tmpdir(), "amux-agent-"));
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
  const root = mkdtempSync(join(tmpdir(), "amux-agent-"));
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
  const root = mkdtempSync(join(tmpdir(), "amux-agent-"));
  const bus = new Bus();
  const locks = new LockRegistry(bus);
  await locks.acquire("shared.txt", "other-agent"); // simulate another agent mid-write

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

  locks.release("shared.txt", "other-agent");
  await runP;
  expect(done).toBe(true);
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
  const root = mkdtempSync(join(tmpdir(), "amux-agent-"));
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

test("a disallowed tool surfaces an error and doesn't crash the loop", async () => {
  const root = mkdtempSync(join(tmpdir(), "amux-agent-"));
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
