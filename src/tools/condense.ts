import { mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

// Test runners and builds print for a human: a line per passing test, progress bars redrawn with
// \r, colour codes, the same warning forty times. A tool result is re-sent on every later turn, so
// that noise is paid for again and again — in AgentDiet's trajectory study, a typical test step was
// 1,714 tokens of passing-test lines around 281 tokens that mattered.
//
// This drops only lines that cannot be the signal: a test that passed, a progress redraw, a
// duplicate. Failures, errors, warnings, file:line references and summaries are never touched.
// It is deliberately NOT applied to file reads or grep — an agent edits against those bytes, and
// compressing them makes it re-read (Paritok) or mis-edit (round-1 research, Go patch study).
//
// ponytail: regexes for the common runners, no per-tool parser. Upgrade path: inject the runner's
// machine-readable reporter (pytest --junit-xml, jest --json) the way `cartoon` does.

// Commands whose output this understands. Matched against "command args…".
const RUNNER =
  /^(?:\S*\/)?(?:pytest|py\.test|jest|vitest|mocha|tsc|eslint|ruff|mypy|rspec|phpunit|gradle|gradlew|mvn|make|ctest)\b|^(?:\S*\/)?(?:python3?|uv|poetry)\s+(?:run\s+)?(?:-m\s+)?(?:pytest|unittest)\b|^(?:\S*\/)?(?:bun|deno)\s+test\b|^(?:\S*\/)?go\s+(?:test|build|vet)\b|^(?:\S*\/)?cargo\s+(?:test|build|check|clippy|nextest)\b|^(?:\S*\/)?(?:npm|pnpm|yarn|bun|npx)\s+(?:(?:run\s+)?(?:test|build|lint|typecheck|check)|install|ci|i|add|exec\s+\S+)\b|^(?:\S*\/)?npx\s+(?:jest|vitest|tsc|eslint|mocha)\b/;

// A line that only reports success. Each pattern is anchored so a line with an error on it can't match.
const PASSING: RegExp[] = [
  /^\s*(?:✓|✔|√)\s/, // jest / vitest / mocha
  /^\s*\(pass\)\s/, // bun test
  /^\s*PASS\s+\S/, // jest file header
  /::\S.*\sPASSED(?:\s+\[\s*\d+%\])?\s*$/, // pytest -v
  /^(?:\S+\s+)?\.+\s+\[\s*\d+%\]\s*$/, // pytest progress line with no F/E/s in it
  /^\.+$/, // dot reporters
  /^\s*test\s+\S.*\s\.\.\.\s+ok\s*$/, // cargo test
  /^\s*---\s+PASS:\s/, // go test -v
  /^\s*===\s+(?:RUN|PAUSE|CONT)\s/, // go test -v
  /^\s*ok\s+\d+\s+-\s/, // TAP
];

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const MIN_CHARS = 2_000; // below this the output is already cheap
const MIN_SAVING = 0.2; // and a rewrite that saves less than a fifth isn't worth the note

// "npm run test" from either shape the shell tool accepts: {command, args} or one command string.
export function shellCommandLine(input: Record<string, unknown>): string {
  const args = Array.isArray(input.args) ? input.args.map(String) : [];
  return [String(input.command ?? ""), ...args].join(" ");
}

export function isRunner(commandLine: string): boolean {
  return RUNNER.test(commandLine.trim());
}

// The condensed output, or undefined when this command isn't a runner or nothing worth dropping.
export function condenseOutput(commandLine: string, output: string): { text: string; dropped: number } | undefined {
  if (output.length < MIN_CHARS || !isRunner(commandLine)) return undefined;
  // A progress bar redraws itself with \r; only its last state ever reached a human's screen.
  const lines = output.replace(ANSI, "").split("\n").map((l) => {
    const t = l.replace(/\r+$/, "");
    return t.slice(t.lastIndexOf("\r") + 1);
  });
  const out: string[] = [];
  let dropped = 0;
  let prev: string | undefined;
  let repeats = 0;
  const flush = () => {
    if (repeats > 0) out.push(`  [previous line repeated ${repeats} more time${repeats === 1 ? "" : "s"}]`);
    repeats = 0;
  };
  for (const line of lines) {
    if (PASSING.some((re) => re.test(line))) {
      dropped++;
      continue;
    }
    if (line === prev && line.trim()) {
      repeats++;
      dropped++;
      continue;
    }
    flush();
    if (!line.trim() && !out.at(-1)?.trim()) continue; // collapse blank runs
    out.push(line);
    prev = line;
  }
  flush();
  const text = out.join("\n");
  if (dropped === 0 || text.length > output.length * (1 - MIN_SAVING)) return undefined;
  return { text, dropped };
}

const LOG_DIR = join(".niti", "logs");
const KEEP_LOGS = 20;

// Keeps the untouched output where read_file and grep can reach it (inside the project root), in a
// directory that ignores itself so it never shows up in the user's git status. Returns the path to
// mention, or undefined if it couldn't be written — the condensed text is still correct without it.
function saveRawLog(root: string, output: string): string | undefined {
  try {
    const dir = join(root, LOG_DIR);
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "*\n");
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}.log`;
    writeFileSync(join(dir, name), output);
    const logs = readdirSync(dir).filter((f) => f.endsWith(".log")).sort();
    for (const old of logs.slice(0, Math.max(0, logs.length - KEEP_LOGS))) rmSync(join(dir, old), { force: true });
    return join(LOG_DIR, name);
  } catch {
    return undefined;
  }
}

// The two together, as the text that goes to the model.
export function condenseForModel(root: string, commandLine: string, output: string): string {
  const c = condenseOutput(commandLine, output);
  if (!c) return output;
  const path = saveRawLog(root, output);
  return (
    `${c.text}\n[niti: ${c.dropped} passing-test, progress and repeated lines left out` +
    `${path ? `; the full output is in ${path} (read_file / grep it if you need a line that isn't here)` : ""}.]`
  );
}
