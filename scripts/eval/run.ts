// Scores the harness, not the model. Runs every task in scripts/eval/tasks.ts against one agent in
// a throwaway directory and reports what actually landed on disk.
//
//   bun run scripts/eval/run.ts --provider google --model gemini-flash-latest
//   bun run scripts/eval/run.ts --provider google --model gemini-flash-lite-latest --repeat 3
//   bun run scripts/eval/run.ts --only navigate --keep
//
// Use --repeat 3 or more for any comparison you intend to act on. A single pass is a smoke test:
// the same fixture on an unchanged harness scored 4/5 across five runs, so one run of the suite
// has a noise floor of roughly one task.
//
// Why this exists: every remaining idea for making niti smarter — a repo map, per-model prompts,
// a critic pass, cheaper compaction — is a guess until something scores it. The published numbers
// for harness changes (same weights, different scaffold) span tens of points, in both directions.
// Without a score, a change that makes things worse is indistinguishable from one that helps.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Agent, type AgentConfig } from "../../src/agent/agent.ts";
import { Bus } from "../../src/events/bus.ts";
import { UsageTracker } from "../../src/usage.ts";
import { makeProvider } from "../../src/providers/factory.ts";
import { detectChecks } from "../../src/agent/verify.ts";
import { TOOL_GUIDANCE } from "../../src/tools/tools.ts";
import { steeringFor } from "../../src/agent/steering.ts";
import { costOf } from "../../src/providers/pricing.ts";
import { TASKS, type Task } from "./tasks.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};

const provider = flag("provider", "google");
const model = flag("model", "gemini-flash-latest");
const repeat = Math.max(1, Number(flag("repeat", "1")));
const only = flag("only", "");
const keep = args.includes("--keep");
const verbose = args.includes("--verbose");

const SYSTEM_PROMPT =
  "You are a senior software engineer working in an existing project. " +
  "Complete the task you are given, then stop. Change only what the task asks for.";

function setup(task: Task): string {
  const dir = mkdtempSync(join(tmpdir(), "niti-eval-"));
  for (const [path, content] of Object.entries(task.files)) {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

interface Attempt {
  ok: boolean;
  errored: boolean; // the provider never answered — not a verdict on the harness
  reason: string;
  outcome: string;
  calls: number;
  tokens: number;
  cost: number;
  seconds: number;
}

// A rate limit is not a failing grade. Free-tier quotas trip constantly on a suite like this, and
// scoring those runs as failures produced a "1/6" that measured the quota and nothing else — the
// most misleading number this script could print. A run that never reached the model is reported
// separately and left out of the score entirely.
function isInfraError(outcome: string, calls: number): boolean {
  return calls === 0 || /429|too many requests|quota|rate limit|no API key|not signed in|unknown provider/i.test(outcome);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOne(task: Task): Promise<Attempt> {
  const dir = setup(task);
  const usage = new UsageTracker();
  const cfg: AgentConfig = {
    id: "eval",
    provider,
    model,
    role: "Engineer",
    // Same prompt the Engine assembles, minus the project map (these fixtures are far below the
    // size where one is generated). Leaving the per-model steering out would measure a harness
    // nobody runs.
    systemPrompt: SYSTEM_PROMPT + TOOL_GUIDANCE + steeringFor(provider, model),
    allowedTools: ["read_file", "write_file", "edit", "shell"],
  };
  const bus = new Bus();
  if (verbose) {
    bus.subscribe((e) => {
      if (e.type === "tool_call" || e.type === "file_edit" || e.type === "error") {
        console.log(`    ${e.type === "error" ? "!" : "·"} ${e.payload.slice(0, 110)}`);
      }
    });
  }
  const started = Date.now();
  let outcome = "failed";
  try {
    // No `approve`: headless, and every tool is pre-granted — the eval measures capability, not
    // the approval UI. Verification is detected from the fixture exactly as it would be in a
    // real project, so a task whose fixture has no check simply runs without one.
    const agent = new Agent(cfg, makeProvider(cfg), bus, { root: dir, usageTracker: usage, verify: detectChecks(dir) });
    outcome = await agent.run(task.prompt);
  } catch (err) {
    outcome = `error: ${(err as Error).message}`;
  }
  const seconds = (Date.now() - started) / 1000;
  const read = (p: string): string | undefined => (existsSync(join(dir, p)) ? readFileSync(join(dir, p), "utf8") : undefined);
  const reason = task.check(read) ?? "";
  const totals = usage.totals();
  if (keep) console.log(`    fixture kept at ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
  const errored = isInfraError(outcome, totals.calls);
  return {
    ok: reason === "" && !errored,
    errored,
    reason,
    outcome,
    calls: totals.calls,
    tokens: totals.inputTokens + totals.outputTokens,
    cost: costOf(provider, model, totals.inputTokens, totals.outputTokens, totals.cacheReadTokens, totals.cacheWriteTokens).usd,
    seconds,
  };
}

const selected = only ? TASKS.filter((t) => t.tests === only || t.name.includes(only)) : TASKS;
if (selected.length === 0) {
  console.error(`no tasks match '${only}'. Tasks: ${TASKS.map((t) => t.name).join(", ")}`);
  process.exit(1);
}

console.log(`\n  ${provider}/${model} · ${selected.length} tasks${repeat > 1 ? ` × ${repeat}` : ""}\n`);

let passed = 0;
let scored = 0;
let errors = 0;
let cost = 0;
let tokens = 0;
const byKind = new Map<string, { pass: number; total: number }>();
const gap = Number(flag("delay", "4")) * 1000; // free-tier quotas are per-minute; pace for them

for (const task of selected) {
  for (let i = 0; i < repeat; i++) {
    let a = await runOne(task);
    if (a.errored) {
      // One retry, after a longer pause: a per-minute quota that tripped mid-suite usually clears.
      await sleep(Math.max(gap, 20_000));
      a = await runOne(task);
    }
    tokens += a.tokens;
    cost += a.cost;
    const label = `${task.name}${repeat > 1 ? ` #${i + 1}` : ""}`.padEnd(34);
    const stats = `${String(a.calls).padStart(2)} calls  ${a.seconds.toFixed(1)}s`;
    if (a.errored) {
      errors++;
      console.log(`  ERR   ${label} ${stats}\n          ${a.outcome} — not scored`);
    } else {
      scored++;
      const kind = byKind.get(task.tests) ?? { pass: 0, total: 0 };
      kind.total++;
      if (a.ok) {
        passed++;
        kind.pass++;
      }
      byKind.set(task.tests, kind);
      console.log(`  ${a.ok ? "PASS" : "FAIL"}  ${label} ${stats}${a.ok ? "" : `\n          ${a.reason || a.outcome}`}`);
    }
    if (gap > 0) await sleep(gap);
  }
}

const pct = scored > 0 ? Math.round((passed / scored) * 100) : 0;
console.log(`\n  ${passed}/${scored} passed (${pct}%)  ·  ${tokens.toLocaleString()} tokens  ·  $${cost.toFixed(4)}`);
if (errors > 0) console.log(`  ${errors} run(s) never reached the model and were not scored`);
// Measured, not guessed: one fixture run five times on an unchanged harness scored 4/5. A single
// pass of this suite therefore carries a noise floor of about one task, and two runs differing by
// one task say nothing at all. Printed rather than left in a comment, because the moment this
// matters is the moment someone is staring at a one-task difference deciding whether it is real.
if (repeat === 1 && passed < scored) {
  console.log(`  note: single run — tasks here are ~80% reliable, so ±1 task is noise. Use --repeat 3 before concluding anything.`);
}
for (const [kind, s] of [...byKind].sort()) console.log(`    ${kind.padEnd(10)} ${s.pass}/${s.total}`);
console.log();

// Non-zero on a regression, so this can gate a change rather than merely describe one. An
// unscored run counts against it too: a suite that could not be measured has not passed.
process.exit(scored > 0 && passed === scored && errors === 0 ? 0 : 1);
