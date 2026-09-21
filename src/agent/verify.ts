import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { shell } from "../tools/tools.ts";

// A model's "done" is a claim, not a fact. Everything else in the harness — the review gate, the
// hand-off, the DAG releasing dependents — treats it as a fact, so a task that doesn't compile
// propagates as a finished one and the failure surfaces three tasks later somewhere unrelated.
//
// This is the cheapest ground truth available: run what the project already runs, and hand the
// model its own errors back while it still has the context to fix them. The measured effect of a
// feedback loop like this is larger than the gap between model tiers — it is the difference
// between an agent that writes plausible code and one that writes code that builds.

export interface Check {
  name: string;
  command: string;
  args: string[];
}

// Deliberately type-checks and builds; deliberately does NOT run test suites by default. A build
// is seconds and its failures are unambiguous; a test suite can be minutes, can touch a database,
// and can fail for reasons that have nothing to do with the task at hand — the agent then "fixes"
// a pre-existing failure it did not cause. Projects that want their tests in the loop say so:
//   verify: ["bun test", "bun run lint"]   # in .niti/agents.yaml
// and `verify: false` turns the whole thing off.
export function detectChecks(root = process.cwd()): Check[] {
  const has = (f: string) => existsSync(join(root, f));

  if (has("package.json")) {
    let scripts: Record<string, unknown> = {};
    try {
      scripts = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {}) as Record<string, unknown>;
    } catch {
      return []; // an unparseable package.json is the user's problem, not something to guess around
    }
    const runner = has("bun.lock") || has("bun.lockb") ? "bun" : has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    // First match wins. `typecheck` is the cheapest real signal; `build` is the fallback for
    // projects that never added one.
    for (const name of ["typecheck", "type-check", "tsc", "check", "build"]) {
      if (typeof scripts[name] === "string") return [{ name: `${runner} run ${name}`, command: runner, args: ["run", name] }];
    }
    // No script, but TypeScript is configured: tsc itself is still a real check.
    if (has("tsconfig.json")) return [{ name: "tsc --noEmit", command: "npx", args: ["--no-install", "tsc", "--noEmit"] }];
    return [];
  }
  if (has("go.mod")) return [{ name: "go build ./...", command: "go", args: ["build", "./..."] }];
  if (has("Cargo.toml")) return [{ name: "cargo check", command: "cargo", args: ["check", "--quiet"] }];
  if (has("pyproject.toml") && has("mypy.ini")) return [{ name: "mypy .", command: "mypy", args: ["."] }];
  return [];
}

// `verify:` from agents.yaml — a list of command lines, split on whitespace like the shell tool's
// fallback. ponytail: no quote handling; a check that needs quoting can live in a package script,
// which is where a check that complicated belongs anyway.
export function parseChecks(lines: string[]): Check[] {
  return lines
    .map((line) => line.trim().split(/\s+/).filter(Boolean))
    .filter((parts) => parts.length > 0)
    .map((parts) => ({ name: parts.join(" "), command: parts[0]!, args: parts.slice(1) }));
}

const VERIFY_TIMEOUT_MS = 180_000;
const REPORT_MAX = 4_000; // per check: enough for a compiler's first errors, not a whole log

export interface VerifyResult {
  ok: boolean;
  report: string; // "" when ok
}

// Runs every check; reports all failures at once rather than stopping at the first, so one pass
// gives the model the whole picture instead of one error per round-trip.
export async function runChecks(root: string, checks: Check[]): Promise<VerifyResult> {
  const failures: string[] = [];
  for (const c of checks) {
    const r = await shell(root, c.command, c.args, { timeoutMs: VERIFY_TIMEOUT_MS });
    if (r.code === 0) continue;
    // A missing tool is not a failing check. `cargo check` on a machine without cargo would
    // otherwise be reported to the model as "your code is broken", and it would set about fixing
    // code that was never the problem.
    if (r.code === -1 && /ENOENT|not found/i.test(r.stderr)) continue;
    const detail = `${r.stdout}\n${r.stderr}`.trim().slice(0, REPORT_MAX);
    failures.push(`$ ${c.name}\nexit ${r.code}\n${detail}`);
  }
  if (failures.length === 0) return { ok: true, report: "" };
  return { ok: false, report: failures.join("\n\n") };
}

// ── The check surface: files whose contents decide a verdict rather than being judged by it ──
//
// Observed directly on the eval's `fix-what-it-broke` fixture: told its changes failed the check,
// gemini-flash-lite read the check script, edited the check script, re-ran it green, and reported
// the task done. It did not fix the code — it broke the thermometer and reported a normal
// temperature. A prompt rule against this was tried first and did not hold.
//
// Two things are classified here, because they deserve different answers:
//
//   "enforcer" — the script a check runs, and the config that sets how strict it is. Editing one
//   of these to clear a failure is essentially never legitimate mid-task, so it is blocked.
//
//   "test" — test files, and manifests like package.json that are genuinely dual-use. These change
//   for honest reasons all the time: rename a function and its tests must follow; add a dependency
//   and the manifest must follow. Blocking those would derail ordinary refactors, so a suspicious
//   edit here is reported loudly instead of refused.
//
// Whether an edit is *suspicious* at all is not guessed from filenames — see tamperedChecks() in
// agent.ts, which reverts the file and re-runs the check to find out whether the green result
// actually depended on it.

export type CheckRole = "enforcer" | "test";

const TEST_PATH = [
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
  /(^|\/)spec\//,
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
  /_test\.(go|py|rb|rs)$/,
  /(^|\/)test_[^/]+\.py$/,
  /(^|\/)conftest\.py$/,
];

// Config whose only job is deciding how strict a check is. Loosening one turns a failure green
// without touching a line of the code under test, and no ordinary task needs to.
const ENFORCER_FILE = new Set([
  "tsconfig.json", "jsconfig.json",
  "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs",
  ".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.cjs", ".eslintrc.yml",
  "jest.config.js", "jest.config.ts", "vitest.config.ts", "vitest.config.js",
  "mypy.ini", ".flake8", "ruff.toml", "pytest.ini", "tox.ini", "setup.cfg",
  ".golangci.yml", ".golangci.yaml", "clippy.toml",
]);

// Dual-use: real reasons to edit these mid-task exist (a new dependency, a new build step), so they
// are reported rather than refused.
const DUAL_USE_FILE = new Set(["package.json", "Cargo.toml", "pyproject.toml", "Makefile", "justfile"]);

const RUNNERS = new Set(["npm", "bun", "pnpm", "yarn", "npx"]);

// File-looking tokens in a command line, e.g. `node check.js` or `pytest tests/unit`.
function fileTokens(parts: string[]): string[] {
  return parts
    .filter((a) => !a.startsWith("-"))
    .filter((a) => /\.[a-z0-9]{1,5}$/i.test(a) || a.includes("/"))
    .map((a) => a.replace(/^\.\//, ""));
}

// What a check actually runs. `npm run typecheck` names no files at all — the real command lives in
// package.json — and almost every project's check is exactly that shape, so without this expansion
// the guard cannot see the one file most worth protecting: the script doing the checking. Found the
// hard way: the eval fixture verifies with `npm run typecheck` → `node check.js`, and an agent
// editing check.js sailed straight past a guard that had only ever looked at ["run", "typecheck"].
function commandTargets(checks: Check[], root: string): string[] {
  const out: string[] = [];
  let scripts: Record<string, unknown> | undefined;
  const loadScripts = (): Record<string, unknown> => {
    if (scripts) return scripts;
    try {
      scripts = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {}) as Record<string, unknown>;
    } catch {
      scripts = {};
    }
    return scripts;
  };

  for (const c of checks) {
    out.push(...fileTokens(c.args));
    const base = c.command.split("/").pop() ?? c.command;
    if (!RUNNERS.has(base) || c.args[0] !== "run" || !c.args[1]) continue;
    const body = loadScripts()[c.args[1]];
    // Split on whitespace and shell operators — a script is routinely `tsc --noEmit && node check.js`,
    // and both halves decide the verdict.
    if (typeof body === "string") out.push(...fileTokens(body.split(/[\s;|&]+/).filter(Boolean)));
  }
  return out;
}

// Classifies a project-relative path, or undefined when it is ordinary source. `root` is needed to
// resolve a package-manager script to the command it actually runs.
export function checkSurface(checks: Check[], root = process.cwd()): (path: string) => CheckRole | undefined {
  const named = new Set(commandTargets(checks, root));
  return (path: string): CheckRole | undefined => {
    const rel = path.replace(/^\.\//, "");
    const base = rel.split("/").pop() ?? rel;
    if (named.has(rel) || named.has(base)) return "enforcer";
    if (ENFORCER_FILE.has(base)) return "enforcer";
    if (DUAL_USE_FILE.has(base)) return "test";
    return TEST_PATH.some((re) => re.test(rel)) ? "test" : undefined;
  };
}

// ── A task that asks for the change ──
//
// The guard above reverts an enforcer file, re-runs the checks, and calls it gaming when they fail
// without the edit. That is the right test for "the agent quietly loosened the thermometer", and
// the wrong one when the task IS the thermometer: "update tsconfig to ESNext" is finished exactly
// when the check that reads tsconfig goes green, so reverting the file always makes the check fail.
//
// The guard therefore steps aside for a file the task text asks to have edited. This is read from
// the text because a task carries nothing else (TaskNode has no file targets), and it is built to
// fail toward the guard staying on: one sentence must contain an edit verb and a specific reference
// to the file, and nothing negating it. A missed match is today's behaviour; only a wrong match
// weakens the guard, so the reference must be the file's name or a phrase for the tool's
// *configuration* — never the bare tool, because "make eslint pass" names the check, not the config.
// ponytail: prose heuristic, English only. Upgrade path: the planner emits explicit file targets.

const EDIT_VERB = /\b(update|change|edit|modify|add|enable|disable|set|configure|bump|switch|migrate|upgrade|tighten|loosen|relax|raise|lower|remove|turn (on|off))\b/i;
const NEGATION = /\b(do not|don't|dont|never|without|avoid|leave|shouldn't|must not|not|keep|preserve|unchanged|untouched|as[- ]is|read-only)\b/i;
// Orchestrator subtasks are terse: "target esnext in tsconfig", "deps: bump typescript to 5.5". No
// edit verb, no full sentence — but a short clause aimed at one config is still a request for it.
const TERSE_MAX_WORDS = 10;

// [file, phrase for its configuration, the bare tool name — only trusted in terse shorthand]
const CONFIG_PHRASES: [file: RegExp, phrase: RegExp, tool: string][] = [
  [/^[jt]sconfig\.json$/, /\b[jt]sconfig\b|\b(typescript|ts) (config|compiler)|\bcompiler options?\b/i, "[jt]sconfig|typescript"],
  [/eslint/, /\b(eslint|lint(er)?) (config|configuration|rules?|settings?)\b|\beslintrc\b/i, "eslint"],
  [/^(jest|vitest)\.config/, /\b(jest|vitest) (config|configuration|settings?)\b/i, "jest|vitest"],
  [/^(mypy\.ini|\.flake8|ruff\.toml|pytest\.ini|tox\.ini|setup\.cfg)$/, /\b(ruff|mypy|flake8|pytest|tox) (config|configuration|settings?|options?|rules?)\b/i, "ruff|mypy|flake8|pytest|tox"],
  [/golangci|clippy/, /\b(golangci(-lint)?|clippy) (config|configuration|rules?)\b/i, "golangci(?:-lint)?|clippy"],
  [/^package\.json$/, /^\s*(deps?|dependencies|devdeps|scripts?)\s*:/i, "deps?"],
];

export function taskEditsCheckFile(task: string, rel: string): boolean {
  const base = rel.split("/").pop() ?? rel;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const refs = [new RegExp(`(^|[\\s"'\`(/])${escaped}(?![\\w.-])`, "i")];
  // Terse shorthand also accepts the bare tool, but only as a target ("in tsconfig", "eslint: ...") —
  // "make eslint pass" is short too, and it names the check, not its config.
  const names = [escaped];
  for (const [file, phrase, tool] of CONFIG_PHRASES) {
    if (!file.test(base)) continue;
    refs.push(phrase);
    names.push(tool);
  }
  const target = new RegExp(`\\b(?:in|to|for|of)\\s+(?:${names.join("|")})(?![\\w.-])|^\\s*(?:${names.join("|")})\\s*:`, "i");
  // Split on sentence ends followed by whitespace, so "tsconfig.json" is not cut at its dot.
  return task.split(/(?<=[.!?;])\s+|\n+/).some((sentence) => {
    if (NEGATION.test(sentence)) return false; // a prohibition always wins, verb or no verb
    if (EDIT_VERB.test(sentence) && refs.some((re) => re.test(sentence))) return true;
    const terse = sentence.trim().split(/\s+/).length <= TERSE_MAX_WORDS;
    return terse && target.test(sentence);
  });
}
