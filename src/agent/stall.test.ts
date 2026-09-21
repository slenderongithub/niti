import { test, expect } from "bun:test";
import { StallGuard, stallNudge, recurringNudge, NUDGE_AFTER, STOP_AFTER, RECUR_NUDGE, RECUR_STOP, type StallVerdict } from "./stall.ts";
import { failureMessage } from "./verify.ts";
import type { ToolCall, ToolResult } from "../providers/provider.ts";

let n = 0;
const round = (name: string, input: Record<string, unknown>, output: string): [ToolCall[], ToolResult[]] => {
  const id = `c${n++}`;
  return [[{ id, name, input }], [{ id, name, output }]];
};
const feed = (g: StallGuard, r: [ToolCall[], ToolResult[]]): StallVerdict => g.observe(r[0], r[1]);
const edit = () => round("edit", { path: "a.ts" }, "edited a.ts");
const failCheck = (line = 3) => round("shell", { command: "node", args: ["check.js"] }, `exit 1\nsrc/a.ts:${line} - error: bad`);
const read = (p: string) => round("read_file", { path: p }, "     1\tcontent");

test("read/check spinning after a write is nudged once, then stopped", () => {
  const g = new StallGuard();
  feed(g, edit());
  const verdicts: StallVerdict[] = [];
  for (let i = 0; i < NUDGE_AFTER + STOP_AFTER; i++) verdicts.push(feed(g, i % 2 ? read("a.ts") : failCheck()));
  expect(verdicts.indexOf("nudge")).toBe(NUDGE_AFTER - 1);
  expect(verdicts.filter((v) => v === "nudge")).toHaveLength(1);
  expect(verdicts.at(-1)).toBe("stop");
  expect(verdicts.indexOf("stop")).toBe(verdicts.length - 1); // and not a round sooner
});

test("a run that has not written anything is never judged: reading is its job", () => {
  const g = new StallGuard();
  for (let i = 0; i < 40; i++) expect(feed(g, i % 2 ? read("a.ts") : failCheck())).toBe("ok");
});

test("distinct, succeeding reads earn a nudge but never a stop — that is a deep dive, not a loop", () => {
  const g = new StallGuard();
  feed(g, edit());
  const verdicts = Array.from({ length: 40 }, (_, i) => feed(g, read(`f${i}.ts`)));
  expect(verdicts.filter((v) => v === "nudge")).toHaveLength(1);
  expect(verdicts).not.toContain("stop");
});

test("re-reading the same file is a loop even when every read succeeds", () => {
  const g = new StallGuard();
  feed(g, edit());
  const verdicts = Array.from({ length: NUDGE_AFTER + STOP_AFTER }, () => feed(g, read("a.ts")));
  expect(verdicts.at(-1)).toBe("stop");
});

test("an edit resets the count, so edit-check-edit debugging is never interrupted", () => {
  const g = new StallGuard();
  for (let cycle = 0; cycle < 20; cycle++) {
    feed(g, edit());
    // The error moves each cycle: the edits are changing the outcome, which is what progress is.
    for (let i = 0; i < NUDGE_AFTER - 1; i++) expect(feed(g, i % 2 ? read("a.ts") : failCheck(cycle * 100 + i))).toBe("ok");
  }
});

test("a failed edit is not progress, and a passing command is", () => {
  const g = new StallGuard();
  feed(g, edit());
  for (let i = 0; i < NUDGE_AFTER - 1; i++) feed(g, round("edit", { path: "a.ts" }, "error: oldString not found"));
  expect(feed(g, round("edit", { path: "a.ts" }, "error: oldString not found"))).toBe("nudge");
  const h = new StallGuard();
  feed(h, edit());
  for (let i = 0; i < NUDGE_AFTER - 1; i++) feed(h, failCheck());
  expect(feed(h, round("shell", { command: "npm", args: ["install"] }, "exit 0\nadded 3 packages"))).toBe("ok"); // may have changed the tree
  for (let i = 0; i < NUDGE_AFTER - 1; i++) expect(feed(h, failCheck())).toBe("ok"); // counting restarted
});

test("a round mixing a read with a real action is progress", () => {
  const g = new StallGuard();
  feed(g, edit());
  for (let i = 0; i < NUDGE_AFTER - 1; i++) feed(g, failCheck());
  const [rc, rr] = read("a.ts");
  const [ec, er] = edit();
  expect(g.observe([...rc, ...ec], [...rr, ...er])).toBe("ok");
  expect(g.rounds).toBe(0);
});

test("the nudge names the count and the action; the failure message names the first error and says to edit", () => {
  expect(stallNudge(8)).toContain("8 rounds");
  expect(stallNudge(8)).toContain("edit or write_file");
  const msg = failureMessage("$ npm run typecheck\nexit 1\n> fixture@1.0.0 typecheck\n\nsrc/math.ts:3 - error: TODO_BROKEN is not defined");
  expect(msg).toContain("Start with: src/math.ts:3 - error: TODO_BROKEN is not defined");
  expect(msg).toContain("edit or write_file");
  expect(msg).toContain("Do not disable, delete or weaken a check");
  expect(failureMessage("exit 2\nboom")).not.toContain("Start with"); // nothing to point at: say nothing rather than guess
});

test("through the agent: a stalled run is nudged, then ends exhausted long before the turn cap", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Agent } = await import("./agent.ts");
  const { Bus } = await import("../events/bus.ts");
  const root = mkdtempSync(join(tmpdir(), "niti-stall-"));
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  let sends = 0;
  let sawNudge = false;
  const provider = {
    async send(_sys: string, turns: import("../providers/provider.ts").Turn[]) {
      sends++;
      if (turns.some((t) => t.role === "user" && t.text.startsWith("You have made"))) sawNudge = true;
      const call: ToolCall =
        sends === 1
          ? { id: "e", name: "edit", input: { path: "a.ts", oldString: "= 1", newString: "= 2" } }
          : { id: `r${sends}`, name: "read_file", input: { path: "a.ts" } };
      return { text: "", toolCalls: [call] };
    },
  };
  const agent = new Agent(
    { id: "a", provider: "scripted", model: "x", role: "r", systemPrompt: "s", allowedTools: ["read_file", "edit"], autoApprove: ["edit"] },
    provider,
    new Bus(),
    { root },
  );
  expect(await agent.run("fix it")).toBe("exhausted");
  expect(sawNudge).toBe(true);
  expect(sends).toBeLessThan(30); // the default cap
  expect(sends).toBe(1 + NUDGE_AFTER + STOP_AFTER);
});

test("the same error after separate edits is nudged, then stops the run — every round was 'progress'", () => {
  const g = new StallGuard();
  const verdicts: StallVerdict[] = [];
  for (let i = 0; i < RECUR_STOP + 2; i++) {
    verdicts.push(feed(g, edit()));
    verdicts.push(feed(g, failCheck())); // identical error each time
    if (verdicts.at(-1) === "stop") break;
  }
  const seq = verdicts.filter((v) => v !== "ok");
  expect(seq).toEqual(["nudge", "stop"]);
  expect(verdicts.indexOf("nudge")).toBe(2 * (RECUR_NUDGE - 1) + 1); // on the third occurrence
  expect(g.kind).toBe("recurring");
  expect(g.detail).toBe("src/a.ts:3 - error: bad");
  expect(g.recurCount).toBe(RECUR_STOP);
});

test("re-running an unchanged check is not a recurrence, and a green run in between does not reset it", () => {
  const g = new StallGuard();
  feed(g, edit());
  for (let i = 0; i < 6; i++) feed(g, failCheck()); // no writes between: one occurrence, not six
  expect(g.recurCount).toBe(0);
  // The check edited green, then failing again: the same failure coming back.
  const h = new StallGuard();
  const v: StallVerdict[] = [];
  for (let i = 0; i < 4; i++) {
    v.push(feed(h, edit()), feed(h, failCheck()), feed(h, edit()), feed(h, round("shell", { command: "node", args: ["check.js"] }, "exit 0\n")));
  }
  expect(v).toContain("nudge");
});

test("different errors are different failures; an error with nothing to point at is not fingerprinted", () => {
  const g = new StallGuard();
  const v: StallVerdict[] = [];
  for (let i = 0; i < 12; i++) v.push(feed(g, edit()), feed(g, failCheck(i)));
  for (let i = 0; i < 12; i++) v.push(feed(g, edit()), feed(g, round("shell", { command: "x" }, "exit 2\nboom")));
  expect(v.every((x) => x === "ok")).toBe(true);
});

test("the recurring-failure nudge quotes the error and forbids editing the check", () => {
  const m = recurringNudge("src/a.ts:3 - error: bad", 3);
  expect(m).toContain("src/a.ts:3 - error: bad");
  expect(m).toContain("3 separate attempts");
  expect(m).toContain("Do not edit the check");
});

test("through the agent: edits that never change the error are nudged, then end exhausted", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Agent } = await import("./agent.ts");
  const { Bus } = await import("../events/bus.ts");
  const root = mkdtempSync(join(tmpdir(), "niti-recur-"));
  writeFileSync(join(root, "check.js"), "console.error('src/a.ts:3 - error: X is not defined'); process.exit(1);\n");
  let sends = 0;
  let nudge = "";
  const provider = {
    async send(_sys: string, turns: import("../providers/provider.ts").Turn[]) {
      sends++;
      const n = turns.findLast((t) => t.role === "user" && t.text.startsWith("The same failure"));
      if (n && n.role === "user") nudge = n.text;
      const call: ToolCall =
        sends % 2 === 1
          ? { id: `w${sends}`, name: "write_file", input: { path: "a.ts", content: `export const a = ${sends};\n` } } // a different edit each time
          : { id: `s${sends}`, name: "shell", input: { command: "node", args: ["check.js"] } };
      return { text: "", toolCalls: [call] };
    },
  };
  const agent = new Agent(
    { id: "a", provider: "scripted", model: "x", role: "r", systemPrompt: "s", allowedTools: ["write_file", "shell"], autoApprove: ["write_file", "shell"] },
    provider,
    new Bus(),
    { root },
  );
  const r = await agent.runDetailed("fix it");
  expect(r.outcome).toBe("exhausted");
  expect(r.error).toContain("the same failure returned after");
  expect(nudge).toContain("X is not defined");
  expect(sends).toBe(2 * RECUR_STOP); // write, check, ×5 — nowhere near the 30-turn cap
});
