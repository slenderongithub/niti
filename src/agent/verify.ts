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
