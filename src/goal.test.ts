import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.ts";
import { parseGoalArgs, type GoalStatus } from "./goal.ts";
import { CommandRegistry } from "./commands/registry.ts";
import type { Provider, ProviderReply } from "./providers/provider.ts";
import type { AgentConfig } from "./agent/agent.ts";

// A team of two on a fake model. The lead plans one task per round; the worker writes a file when
// the round says WRITE (so the tree changes) and only talks otherwise. The judge's answers are
// scripted per test through `verdicts`, and every prompt the team saw is kept for assertions.
function team(o: { verdicts: string[]; write?: boolean; root?: string; slow?: boolean; worktree?: boolean }) {
  const root = o.root ?? mkdtempSync(join(tmpdir(), "niti-goal-"));
  const prompts: string[] = [];
  let judged = 0;
  let wrote = 0;
  const usage = { inputTokens: 10, outputTokens: 5 };
  const fake: Provider = {
    async send(sys, turns, _tools, _onDelta, signal): Promise<ProviderReply> {
      const last = [...turns].reverse().find((t) => t.role === "user");
      const text = last && "text" in last ? last.text : "";
      if (sys.includes("LEAD")) {
        if (text.includes("NITI-GOAL-JUDGE")) return { text: o.verdicts[Math.min(judged++, o.verdicts.length - 1)]!, toolCalls: [] };
        if (text.includes("orchestrator of a team")) {
          prompts.push(text);
          return { text: '[{"description":"do the next piece","role":"worker"}]', toolCalls: [] };
        }
        return { text: "integrated", toolCalls: [] };
      }
      if (o.slow) await new Promise((r, j) => { const t = setTimeout(r, 300); signal?.addEventListener("abort", () => (clearTimeout(t), j(new Error("interrupted")))); });
      if (o.write && !turns.some((t) => t.role === "tool")) {
        wrote++;
        return { text: "", toolCalls: [{ id: `w${wrote}`, name: "write_file", input: { path: `f${wrote}.txt`, content: `round ${wrote}` } }], usage };
      }
      return { text: "worked", toolCalls: [], usage };
    },
  };
  const configs: AgentConfig[] = [
    { id: "lead", provider: "anthropic", model: "x", role: "Lead", systemPrompt: "LEAD", lead: true, allowedTools: [] },
    { id: "worker", provider: "anthropic", model: "x", role: "Worker", systemPrompt: "WORKER", allowedTools: o.write ? ["write_file"] : [] },
  ];
  const engine = new Engine({ configs, makeProvider: () => fake, root, interactive: false, auto: true, repoMap: false, verify: false, sandbox: false, worktree: o.worktree });
  const states: GoalStatus[] = [];
  engine.hub.subscribe((e) => e.kind === "goal" && e.status && states.push(e.status));
  return { engine, root, prompts, states, judged: () => judged };
}

const NOT_DONE = '{"done": false, "reason": "not yet", "next": "add the tests"}';
const DONE = '{"done": true, "reason": "tests pass"}';

async function settled(engine: Engine, ms = 5000): Promise<GoalStatus> {
  const end = Date.now() + ms;
  while (engine.goal.active || engine.running) {
    if (Date.now() > end) throw new Error(`goal still ${engine.goal.status?.state} after ${ms}ms`);
    await Bun.sleep(10);
  }
  return engine.goal.status!;
}

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "niti-goal-git-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(root, "README.md"), "x\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return root;
}

test("parseGoalArgs reads budgets and rejects nonsense", () => {
  expect(parseGoalArgs("make it fast --rounds 3 --usd $2.5")).toEqual({ objective: "make it fast", rounds: 3, tokens: undefined, usd: 2.5 });
  expect(parseGoalArgs("x --tokens=5000")).toMatchObject({ tokens: 5000, rounds: 20 });
  expect(typeof parseGoalArgs("x --rounds -1")).toBe("string");
  expect(typeof parseGoalArgs("--rounds 3")).toBe("string");
});

test("a goal runs rounds until the judge says done, carrying the judge's next step forward", async () => {
  const t = team({ verdicts: [NOT_DONE, DONE], write: true, root: gitRepo() });
  expect(t.engine.goal.start("ship the feature", { rounds: 5 })).toBeUndefined();
  const s = await settled(t.engine);
  expect(s.state).toBe("done");
  expect(s.reason).toBe("tests pass");
  expect(s.round).toBe(2);
  expect(s.verdicts.map((v) => v.changed)).toEqual([true, true]);
  expect(t.prompts[1]).toContain("Next step: add the tests");
  expect(t.engine.history.at(-1)!.goal).toBe("goal 2/5: ship the feature"); // the label, not the long prompt
  // Persisted, and a fresh engine on the same project sees the finished goal.
  const saved = JSON.parse(readFileSync(join(t.root, ".niti", "goal.json"), "utf8"));
  expect(saved.status.state).toBe("done");
});

test("two rounds that change nothing stop the goal as blocked", async () => {
  const t = team({ verdicts: [NOT_DONE], root: gitRepo() });
  t.engine.goal.start("do the impossible", { rounds: 10 });
  const s = await settled(t.engine);
  expect(s.state).toBe("blocked");
  expect(s.round).toBe(2);
});

test("the round cap and the token budget each end a goal", async () => {
  const a = team({ verdicts: [NOT_DONE], write: true, root: gitRepo() });
  a.engine.goal.start("keep going", { rounds: 2 });
  expect((await settled(a.engine)).state).toBe("rounds");

  const b = team({ verdicts: [NOT_DONE], write: true, root: gitRepo() });
  b.engine.goal.start("keep going", { rounds: 10, tokens: 1 }); // the first recorded call spends it
  const s = await settled(b.engine);
  expect(s.state).toBe("budget");
  expect(s.round).toBe(1);
  expect(b.engine.goal.extend({ rounds: 1, tokens: 1_000_000 })).toContain("resume");
  expect(b.engine.goal.status!.state).toBe("paused");
});

test("/cancel during a round pauses the goal; resume carries on; stop ends it", async () => {
  const t = team({ verdicts: [NOT_DONE, DONE], write: true, slow: true, root: gitRepo() });
  t.engine.goal.start("long job", { rounds: 5 });
  await Bun.sleep(80);
  t.engine.cancel();
  const paused = await settled(t.engine);
  expect(paused.state).toBe("paused");
  expect(paused.reason).toBe("cancelled");
  expect(t.engine.running).toBe(false);

  expect(t.engine.goal.resume()).toBe("goal resumed");
  expect((await settled(t.engine)).state).toBe("done");
  expect(t.engine.goal.stop()).toBe("no goal is active");
});

test("a note reaches the next round's prompt, and /prompt-style runs are refused meanwhile", async () => {
  const t = team({ verdicts: [NOT_DONE, DONE], write: true, slow: true, root: gitRepo() });
  t.engine.goal.start("build it", { rounds: 5 });
  expect(t.engine.running).toBe(true);
  expect(t.engine.goal.note("use sqlite, not postgres")).toContain("next round");
  await expect(t.engine.submit("something else")).rejects.toThrow(/already running/);
  await settled(t.engine);
  expect(t.prompts[1]).toContain("use sqlite, not postgres");
});

test("graceful pause waits for the round to end", async () => {
  const t = team({ verdicts: [NOT_DONE], write: true, slow: true, root: gitRepo() });
  t.engine.goal.start("step by step", { rounds: 5 });
  await Bun.sleep(20);
  expect(t.engine.goal.pause()).toContain("after this round");
  const s = await settled(t.engine);
  expect(s.state).toBe("paused");
  expect(s.round).toBe(1);
  expect(s.verdicts).toHaveLength(1); // the round finished and was judged before pausing
});

test("a restarted core loads a running goal as paused, with its memory", async () => {
  const root = gitRepo();
  const t = team({ verdicts: [NOT_DONE], write: true, slow: true, root });
  t.engine.goal.start("survive restarts", { rounds: 5 });
  await settled(t.engine).catch(() => {}); // runs to blocked/rounds eventually; we only need a file
  // Simulate a crash mid-goal: rewrite the file as if the core died while it was running.
  const file = join(root, ".niti", "goal.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  saved.status.state = "running";
  writeFileSync(file, JSON.stringify(saved));

  const next = team({ verdicts: [DONE], root });
  next.engine.goal.load();
  expect(next.engine.goal.status!.state).toBe("paused");
  expect(next.engine.goal.status!.reason).toBe("core restarted");
  expect(next.engine.history.some((h) => h.goal.startsWith("goal round"))).toBe(true);
  expect(next.engine.goal.holdsAwake).toBe(false); // an error pause lets the Mac sleep
});

test("/goal and /clear through the command registry", async () => {
  const t = team({ verdicts: [NOT_DONE, DONE], write: true, root: gitRepo() });
  const cmds = new CommandRegistry([]);
  const reg = new CommandRegistry((await import("./commands/registry.ts")).BUILTIN_COMMANDS);
  expect(cmds.has("goal")).toBe(false);
  expect((await reg.run(t.engine, "goal", "")).message).toContain("no goal");
  expect((await reg.run(t.engine, "goal", "finish it --rounds 4")).ok).toBe(true);
  expect((await reg.run(t.engine, "goal", "again")).message).toContain("already active");
  expect((await reg.run(t.engine, "clear", "")).ok).toBe(false);
  await settled(t.engine);
  expect((await reg.run(t.engine, "goal", "status")).message).toContain("state   done");
  expect((await reg.run(t.engine, "clear", "")).ok).toBe(true);
  expect(t.engine.goal.status).toBeUndefined();
  expect(existsSync(join(t.root, ".niti", "goal.json"))).toBe(true);
});

test("worktree mode: every round of a goal works in one worktree, one commit per round", async () => {
  const root = gitRepo();
  const t = team({ verdicts: [NOT_DONE, DONE], write: true, root, worktree: true });
  expect(t.engine.goal.start("isolated work", { rounds: 5 })).toBeUndefined();
  expect((await settled(t.engine)).state).toBe("done");
  const handle = t.engine.worktreeHandle!;
  expect(handle).toBeDefined();
  const log = execFileSync("git", ["log", "--format=%s", `${handle.baseSha}..${handle.branch}`], { cwd: root, encoding: "utf8" });
  expect(log.trim().split("\n")).toEqual(["niti goal round 2: isolated work", "niti goal round 1: isolated work"]);
  expect(existsSync(join(root, "f1.txt"))).toBe(false); // the real tree is untouched until a merge
  expect((await t.engine.mergeWorktree()).ok).toBe(true);
  expect(existsSync(join(root, "f1.txt")) && existsSync(join(root, "f2.txt"))).toBe(true);
});
