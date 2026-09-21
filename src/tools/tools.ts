import { dirname, join, relative, resolve, sep } from "node:path";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ToolSpec, ToolCall as ProviderCall } from "../providers/provider.ts";

// Tool calls an agent may request. Executed locally, jailed to the project root.
export type ToolCall =
  | { tool: "read_file"; path: string; offset?: number; limit?: number }
  | { tool: "write_file"; path: string; content: string }
  | { tool: "edit"; path: string; oldString: string; newString: string; replaceAll?: boolean }
  | { tool: "shell"; command: string; args: string[] }
  | { tool: "list_dir"; path?: string }
  | { tool: "glob"; pattern: string; limit?: number }
  | { tool: "grep"; pattern: string; path?: string; glob?: string; limit?: number; ignoreCase?: boolean };

// Tools that mutate a file at `path` — the set the agent loop checkpoints and locks on.
export const WRITE_TOOLS = new Set(["write_file", "edit"]);

// Tools that only look. The agent loop runs a turn's worth of these concurrently instead of one
// round-trip at a time: four reads and a grep are independent, and serializing them was pure
// latency — the model had already decided on all of them before the first one ran.
export const READ_ONLY_TOOLS = new Set(["read_file", "list_dir", "glob", "grep", "diagnostics", "hover", "recall"]);

// SECURITY BOUNDARY — do not simplify. Resolve the agent-supplied path and reject any escape.
// ponytail: path-prefix check only. Symlinks inside the root that point out are NOT caught —
// real OS sandboxing (realpath/chroot/seccomp) is the documented v1 ceiling.
export function safePath(root: string, p: string): string {
  const abs = resolve(root, p);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`path escapes project root: ${p}`);
  }
  return abs;
}

// ponytail: fixed ceilings, not per-agent configurable — move to agents.yaml if a real project
// needs a longer build than this.
export const SHELL_TIMEOUT_MS = 120_000;
export const SHELL_MAX_OUTPUT = 100_000;

// What a spawned command is allowed to inherit. An allowlist, not a denylist, because the thing
// being kept out (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, …) grows with every provider
// added to the catalog, and a denylist would silently fall behind.
// ponytail: build tools that need more (npm_config_*, CI, proxy vars) will hit this — widen the
// list when someone reports it, rather than guessing at it now.
const ENV_PASSTHROUGH = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TERM", "TMPDIR", "SHELL", "USER"];

export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_PASSTHROUGH) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

// Bounded capture that keeps both ends. Keeping only the first N characters (as this used to)
// drops exactly the part of a build or test log the model needs — the failure summary is at the
// bottom — while spending the whole budget on the banner and the first passing tests.
class HeadTail {
  private head = "";
  private tail = "";
  private omitted = 0;
  private half: number;
  constructor(max: number) {
    this.half = Math.floor(max / 2);
  }
  add(chunk: string): void {
    let rest = chunk;
    if (this.head.length < this.half) {
      const take = this.half - this.head.length;
      this.head += rest.slice(0, take);
      rest = rest.slice(take);
    }
    if (!rest) return;
    this.tail += rest;
    if (this.tail.length > this.half) {
      this.omitted += this.tail.length - this.half;
      this.tail = this.tail.slice(-this.half);
    }
  }
  text(): string {
    return this.omitted > 0 ? `${this.head}\n[output truncated]\n[${this.omitted} characters omitted from the middle]\n${this.tail}` : this.head + this.tail;
  }
}

export function shell(
  root: string,
  command: string,
  args: string[],
  limits: { timeoutMs?: number; maxOutput?: number } = {}, // overridden only by the tests, which can't wait 120s
): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeoutMs = limits.timeoutMs ?? SHELL_TIMEOUT_MS;
  const maxOutput = limits.maxOutput ?? SHELL_MAX_OUTPUT;
  // spawn (never exec/shell:true) with args as an array → no shell *metacharacter* injection.
  //
  // SCOPE OF THE JAIL — read this before trusting it. `cwd` is pinned to root, but that is not a
  // sandbox: `{command:"bash",args:["-c","…"]}` is a shell, and `{command:"cat",args:["../../.ssh/id_rsa"]}`
  // needs no shell at all. Granting an agent `shell` is granting it your machine, and the docs say
  // so. What we CAN cheaply remove is the credential handoff: an inherited environment carried
  // every provider API key into the child, so one `env` call exfiltrated the lot into a model's
  // context. The child now gets an explicit allowlist.
  //
  // The three bounds below are what stop one command from wedging an agent forever: stdin is
  // /dev/null so anything prompting for input reads EOF instead of blocking; `timeout` +
  // SIGKILL caps wall-clock; and the accumulators are capped so `find /` can't grow a string
  // until the process dies (and can't be re-sent as tool output on every later turn).
  return new Promise((res) => {
    const child = spawn(command, args, {
      cwd: root,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv(),
    });
    const stdout = new HeadTail(maxOutput);
    const stderr = new HeadTail(maxOutput);
    child.stdout.on("data", (d) => stdout.add(String(d)));
    child.stderr.on("data", (d) => stderr.add(String(d)));
    child.on("close", (code, signal) => {
      // node kills a timed-out child with killSignal; nothing else in this process sends SIGKILL.
      const timedOut = signal === "SIGKILL";
      res({
        stdout: stdout.text(),
        stderr: stderr.text() + (timedOut ? `\n[timed out after ${timeoutMs / 1000}s]` : ""),
        code: code ?? -1,
      });
    });
    child.on("error", (err) => res({ stdout: stdout.text(), stderr: String(err), code: -1 }));
  });
}

// A tool result is pushed into `turns` and re-sent on every later iteration of the loop, so an
// unbounded read is not one big response — it is one big response per turn, forever. Cap it, and
// refuse binaries outright rather than feeding a model a screenful of replacement characters.
export const READ_FILE_MAX = 256_000;
export const READ_FILE_MAX_LINES = 1500; // a window, not a wall: past this the model is told how to page

// Reads come back line-numbered (`    12\ttext`), the same shape `grep` reports matches in. That
// shared coordinate system is most of what makes navigation work: the model greps, gets
// `src/app.ts:212:`, and can read straight to the window it wants instead of pulling whole files
// and counting. The numbers are display-only — `edit` strips them back off if a model pastes one
// into oldString (see applyEdit), which is the failure this format otherwise invites.
function numberLines(text: string, startLine: number): string {
  return text
    .split("\n")
    .map((l, i) => `${String(startLine + i).padStart(6)}\t${l}`)
    .join("\n");
}

async function readCapped(abs: string, shown: string, offset?: number, limit?: number): Promise<string> {
  const buf = await readFile(abs);
  if (buf.includes(0)) return `error: ${shown} looks like a binary file (${buf.length} bytes) — not read`;
  let text = buf.toString("utf8");
  let charNote = "";
  if (text.length > READ_FILE_MAX) {
    text = text.slice(0, READ_FILE_MAX);
    charNote = `\n[truncated: showing the first ${READ_FILE_MAX} characters of ${shown}]`;
  }
  const all = text.split("\n");
  // 1-based, like every editor and like the line numbers this same tool prints.
  const from = Math.max(1, Math.floor(offset ?? 1));
  const take = Math.max(1, Math.floor(limit ?? READ_FILE_MAX_LINES));
  if (from > all.length) return `error: ${shown} has ${all.length} lines — offset ${from} is past the end`;
  const window = all.slice(from - 1, from - 1 + take);
  const end = from + window.length - 1;
  const note =
    end < all.length || from > 1
      ? `\n[showing lines ${from}-${end} of ${all.length} — read again with offset ${end + 1} for more]`
      : "";
  return numberLines(window.join("\n"), from) + note + charNote;
}

// Directories never worth walking. A hardcoded set rather than a .gitignore parser: these are 99%
// of the noise, and the cost of the remaining 1% is a few extra paths in a listing — whereas the
// cost of walking node_modules is the tool being unusable.
// ponytail: no .gitignore parsing, no per-project config. Add it when a real project's build
// output is drowning a search.
const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt", ".svelte-kit", "target", "vendor",
  "__pycache__", ".venv", "venv", ".cache", "coverage", ".turbo", ".output", ".gradle", ".idea",
]);

// Ceiling on one walk. A monorepo with a million files should degrade to "a partial answer, fast"
// rather than to a hung tool call.
const MAX_WALK_FILES = 20_000;
const GREP_MAX_FILE_BYTES = 1_000_000; // a minified bundle is not what anyone is grepping for
const GREP_CONCURRENCY = 48;

// Project-relative paths of every file under `dir`, ignore-set applied. Symlinked directories are
// skipped by construction (withFileTypes reports them as links, not directories), so no cycle
// detection is needed.
async function listFiles(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0 && out.length < MAX_WALK_FILES) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip it rather than failing the whole search
    }
    for (const e of entries) {
      const abs = join(current, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) stack.push(abs);
      } else if (e.isFile()) {
        out.push(relative(root, abs));
        if (out.length >= MAX_WALK_FILES) break;
      }
    }
  }
  return out.sort();
}

async function listDir(root: string, rel: string): Promise<string> {
  const abs = safePath(root, rel || ".");
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch (err) {
    return `error: cannot list ${rel || "."}: ${(err as Error).message}`;
  }
  const visible = entries.filter((e) => !IGNORED_DIRS.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (visible.length === 0) return `${rel || "."} is empty`;
  // Directories first and marked with a trailing slash — the model's next call is almost always
  // "descend into one of these", and it should not have to guess which entries it can descend into.
  const dirs = visible.filter((e) => e.isDirectory()).map((e) => `${e.name}/`);
  const files = visible.filter((e) => !e.isDirectory()).map((e) => e.name);
  return [`${rel || "."}:`, ...dirs, ...files].join("\n");
}

async function globFiles(root: string, pattern: string, limit: number): Promise<string> {
  if (!pattern) return "error: glob needs a pattern, e.g. 'src/**/*.ts'";
  const g = new Bun.Glob(pattern);
  const all = await listFiles(root, root);
  const hits = all.filter((p) => g.match(p));
  if (hits.length === 0) return `no files match ${pattern}`;
  const shown = hits.slice(0, limit);
  const more = hits.length > shown.length ? `\n[${hits.length - shown.length} more — narrow the pattern]` : "";
  return shown.join("\n") + more;
}

async function grepFiles(
  root: string,
  pattern: string,
  opts: { path?: string; glob?: string; limit: number; ignoreCase?: boolean },
): Promise<string> {
  if (!pattern) return "error: grep needs a pattern";
  let re: RegExp;
  try {
    re = new RegExp(pattern, opts.ignoreCase ? "i" : "");
  } catch (err) {
    return `error: invalid regular expression ${JSON.stringify(pattern)}: ${(err as Error).message}`;
  }
  const base = safePath(root, opts.path || ".");
  let candidates = await listFiles(root, base);
  if (opts.glob) {
    const g = new Bun.Glob(opts.glob);
    // Match the basename too, so `*.ts` means what everyone means by it rather than only matching
    // files sitting at the project root.
    candidates = candidates.filter((p) => g.match(p) || g.match(p.split(sep).pop() ?? p));
  }
  if (candidates.length === 0) return "no files to search (check the path/glob)";

  const lines: string[] = [];
  let total = 0;
  const files = new Set<string>();
  for (let i = 0; i < candidates.length; i += GREP_CONCURRENCY) {
    const batch = candidates.slice(i, i + GREP_CONCURRENCY);
    const results = await Promise.all(batch.map((rel) => grepOne(root, rel, re)));
    for (const hits of results) {
      for (const h of hits) {
        total++;
        files.add(h.file);
        if (lines.length < opts.limit) lines.push(`${h.file}:${h.line}: ${h.text}`);
      }
    }
    // Enough to answer with, and enough to tell the model to narrow down. Scanning the rest only
    // to throw it away is latency nobody reads.
    if (total > opts.limit * 4) break;
  }
  if (total === 0) return `no matches for ${pattern}`;
  const more = total > lines.length ? `\n[${total - lines.length}+ more matches in ${files.size} files — narrow the pattern or pass a glob]` : "";
  return lines.join("\n") + more;
}

async function grepOne(root: string, rel: string, re: RegExp): Promise<{ file: string; line: number; text: string }[]> {
  const abs = join(root, rel);
  try {
    const info = await stat(abs);
    if (info.size > GREP_MAX_FILE_BYTES) return [];
    const buf = await readFile(abs);
    if (buf.includes(0)) return []; // binary
    const out: { file: string; line: number; text: string }[] = [];
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) out.push({ file: rel, line: i + 1, text: lines[i]!.trim().slice(0, 200) });
    }
    return out;
  } catch {
    return [];
  }
}

// Gate on allowedTools, then dispatch. Returns a string result for feeding back to the model.
export async function runTool(
  call: ToolCall,
  allowed: string[],
  root: string = process.cwd(),
): Promise<string> {
  if (!allowed.includes(call.tool)) {
    throw new Error(`tool '${call.tool}' not allowed for this agent`);
  }
  switch (call.tool) {
    case "read_file":
      return await readCapped(safePath(root, call.path), call.path, call.offset, call.limit);
    case "list_dir":
      return await listDir(root, call.path ?? ".");
    case "glob":
      return await globFiles(root, call.pattern, call.limit ?? 100);
    case "grep":
      return await grepFiles(root, call.pattern, {
        path: call.path,
        glob: call.glob,
        limit: call.limit ?? 50,
        ignoreCase: call.ignoreCase,
      });
    case "write_file": {
      const abs = safePath(root, call.path);
      // Create the parent directories. Without this every `write_file src/api/routes.ts` into a
      // directory that doesn't exist yet failed with a bare ENOENT — which is most of what an
      // agent building something new does. The path is already jailed by safePath, so the
      // directories created are inside the project root by construction.
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, call.content);
      return `wrote ${call.path}`;
    }
    case "edit": {
      const abs = safePath(root, call.path);
      const before = await readFile(abs, "utf8");
      const after = applyEdit(before, call.oldString, call.newString, call.replaceAll ?? false, call.path);
      await writeFile(abs, after);
      return `edited ${call.path}`;
    }
    case "shell": {
      // spawn("") throws a Node TypeError that names an argument the model never saw. Say what is
      // actually wrong, and how to fix the call, in the model's own terms.
      if (!call.command.trim()) {
        return "error: shell was called with an empty command. Give the program to run in `command` (for example command: \"npm\", args: [\"run\", \"typecheck\"]).";
      }
      const r = await shell(root, call.command, call.args);
      return `exit ${r.code}\n${r.stdout}${r.stderr}`;
    }
  }
}

// Patch-based editing: replace an exact snippet rather than rewriting the whole file. An ambiguous
// match is still an error, never a guess — the model gets told to include more context, the same
// contract Claude Code and OpenCode use (models are trained on this shape).
//
// A *missing* match is different. "oldString not found" was the single most common way a task
// derailed: the model re-read the file, guessed again, and burned turns on a mismatch that was
// almost always one of two harmless things — it pasted back the line numbers `read_file` printed,
// or its indentation drifted. Both are recoverable without guessing at intent, so both are
// recovered here, and only a genuine miss reaches the model as an error. When it does, it carries
// the nearest lines in the file, because "not found" alone gives the model nothing to correct with.
//
// The recovery lives in resolveEdit rather than inline, because the approval prompt has to show
// the hunk that will actually be applied. When editDiff rendered the model's un-recovered snippet,
// the '-' lines in the dialog were text that does not appear in the file — and the approval dialog
// is the one place in niti where a human is asked to vouch for a change.
export function resolveEdit(before: string, oldString: string, newString: string): { old: string; replacement: string } {
  let old = oldString;
  let replacement = newString;
  if (countOf(before, old) === 0) {
    const stripped = stripLineNumbers(old);
    if (stripped !== old && countOf(before, stripped) > 0) {
      old = stripped;
      replacement = stripLineNumbers(replacement);
    }
  }
  if (countOf(before, old) === 0) {
    const m = matchIgnoringIndent(before, old);
    if (m) {
      // The model wrote newString at *its* indentation, which matched neither the file nor
      // anything else. Shift it by the same delta the match revealed, or the edit lands correct
      // in content and wrong in shape — and in Python, wrong outright.
      replacement = reindent(replacement, m.delta);
      old = m.text;
    }
  }
  return { old, replacement };
}

export function applyEdit(before: string, oldString: string, newString: string, replaceAll: boolean, path = ""): string {
  if (oldString === "") throw new Error(`edit ${path}: oldString must not be empty (use write_file to create a file)`);
  const { old, replacement } = resolveEdit(before, oldString, newString);
  const count = countOf(before, old);
  if (count === 0) throw new Error(`edit ${path}: oldString not found.${nearestLines(before, oldString)}`);
  if (count > 1 && !replaceAll) {
    throw new Error(`edit ${path}: oldString occurs ${count} times (${occurrenceLines(before, old)}) — include more surrounding context, or set replaceAll`);
  }
  if (replaceAll) return before.split(old).join(replacement);
  const at = before.indexOf(old);
  return before.slice(0, at) + replacement + before.slice(at + old.length);
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// `    12\tconst x = 1` → `const x = 1`. Only strips when *every* non-empty line carries a number,
// so real code that happens to start with a digit is left alone.
const LINE_NUMBER_PREFIX = /^\s*\d+\t/;

function stripLineNumbers(s: string): string {
  const lines = s.split("\n");
  const numbered = lines.filter((l) => l.trim() !== "");
  if (numbered.length === 0 || !numbered.every((l) => LINE_NUMBER_PREFIX.test(l))) return s;
  return lines.map((l) => l.replace(LINE_NUMBER_PREFIX, "")).join("\n");
}

// The file's own text for a window whose lines match `old`'s ignoring leading whitespace — but
// only when exactly one window matches, so this can never pick between two candidates.
function matchIgnoringIndent(before: string, old: string): { text: string; delta: number } | undefined {
  const want = old.split("\n");
  const have = before.split("\n");
  if (want.length > have.length) return undefined;
  const key = (l: string) => l.trim();
  let found: { text: string; delta: number } | undefined;
  for (let i = 0; i + want.length <= have.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (key(have[i + j]!) !== key(want[j]!)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (found) return undefined; // ambiguous without the indentation — refuse rather than pick
    found = { text: have.slice(i, i + want.length).join("\n"), delta: indentOf(have[i]!) - indentOf(want[0]!) };
  }
  return found;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function reindent(s: string, delta: number): string {
  if (delta === 0) return s;
  return s
    .split("\n")
    .map((l) => {
      if (l.trim() === "") return l;
      if (delta > 0) return " ".repeat(delta) + l;
      return l.slice(Math.min(-delta, indentOf(l))); // never eat non-whitespace

    })
    .join("\n");
}

// Where the near-misses are, so the model's retry is informed rather than another guess.
function nearestLines(before: string, old: string): string {
  const first = old.split("\n").find((l) => l.trim() !== "")?.trim();
  if (!first) return "";
  const probe = stripLineNumbers(first).trim();
  const lines = before.split("\n");
  const near: string[] = [];
  // Containment alone misses the most common near-miss by far — a line the model reproduced with
  // one value or one word changed, which contains nothing and is contained by nothing. A shared
  // prefix catches those, and is cheap enough to run over a whole file.
  const shared = (a: string, b: string): number => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  const enough = Math.max(6, Math.floor(probe.length * 0.4));
  for (let i = 0; i < lines.length && near.length < 3; i++) {
    const t = lines[i]!.trim();
    if (t === "" || t.length < 3) continue;
    if (t === probe || t.includes(probe) || probe.includes(t) || shared(t, probe) >= enough) {
      near.push(`  line ${i + 1}: ${lines[i]!.slice(0, 120)}`);
    }
  }
  if (near.length === 0) return " The file does not contain that text — read it again before editing.";
  return ` Closest lines in the file (copy one of these exactly, without the line numbers):\n${near.join("\n")}`;
}

function occurrenceLines(before: string, old: string): string {
  const at: number[] = [];
  let from = 0;
  while (at.length < 5) {
    const i = before.indexOf(old, from);
    if (i < 0) break;
    at.push(before.slice(0, i).split("\n").length);
    from = i + old.length;
  }
  return `lines ${at.join(", ")}`;
}

// The hunk an edit will apply, for the approval prompt. We already know exactly what changes, so
// this is the diff — no LCS pass over the file needed.
export function editDiff(before: string, oldString: string, newString: string): string {
  // Resolved the same way applyEdit will resolve it, so the approver reads the hunk that is
  // actually about to be written rather than the model's approximation of it.
  const { old, replacement } = resolveEdit(before, oldString, newString);
  const at = before.indexOf(old);
  const line = at < 0 ? 1 : before.slice(0, at).split("\n").length;
  const minus = old.split("\n").map((l) => `-${l}`);
  const plus = replacement.split("\n").map((l) => `+${l}`);
  return [`@@ line ${line} @@`, ...minus, ...plus].join("\n");
}

// Same crude format as editDiff, for the write_file approval prompt. before === null means the
// file doesn't exist yet (all-plus); otherwise it's a whole-file replace (all-minus, all-plus) —
// no LCS pass needed since nothing downstream does more than colorize +/- lines.
export function writeFileDiff(before: string | null, content: string): string {
  const minus = before === null ? [] : before.split("\n").map((l) => `-${l}`);
  const plus = content.split("\n").map((l) => `+${l}`);
  return [`@@ line 1 @@`, ...minus, ...plus].join("\n");
}

// Tool definitions exposed to the model, keyed by allowedTools name. (No additionalProperties —
// Gemini's schema subset rejects it, and the others don't need it.)
const SPECS: Record<string, ToolSpec> = {
  read_file: {
    name: "read_file",
    description:
      "Read a UTF-8 text file within the project root. Output is line-numbered as '   42\\ttext'; the numbers are for reference only — never include them in an 'edit' oldString. Long files come back as a window: pass offset (1-based first line) and limit to page through the rest.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number", description: "first line to show, 1-based (default 1)" },
        limit: { type: "number", description: "how many lines to show (default 1500)" },
      },
      required: ["path"],
    },
  },
  list_dir: {
    name: "list_dir",
    description: "List the entries of one directory in the project. Directories are marked with a trailing '/'. Use this to orient yourself; use 'glob' or 'grep' to search.",
    parameters: { type: "object", properties: { path: { type: "string", description: "project-relative directory (default '.')" } } },
  },
  glob: {
    name: "glob",
    description:
      "Find files by path pattern, e.g. 'src/**/*.ts' or '**/*test*'. Returns project-relative paths. Use this instead of guessing where a file lives.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "glob pattern matched against project-relative paths" },
        limit: { type: "number", description: "max paths to return (default 100)" },
      },
      required: ["pattern"],
    },
  },
  grep: {
    name: "grep",
    description:
      "Search file contents by regular expression. Returns 'path:line: text' for each match — read those lines with read_file's offset. This is the fastest way to find where something is defined or used; prefer it over reading files to look around.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression" },
        path: { type: "string", description: "limit the search to this directory (default: whole project)" },
        glob: { type: "string", description: "only search files matching this glob, e.g. '*.ts'" },
        limit: { type: "number", description: "max matching lines to return (default 50)" },
        ignoreCase: { type: "boolean" },
      },
      required: ["pattern"],
    },
  },
  write_file: {
    name: "write_file",
    description: "Create or overwrite a file within the project root.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  edit: {
    name: "edit",
    description:
      "Replace an exact snippet in an existing file. oldString must appear exactly once (or set replaceAll) — include surrounding lines to make it unique. Prefer this over write_file for changes to existing files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldString: { type: "string", description: "exact text to replace, including indentation" },
        newString: { type: "string", description: "replacement text ('' deletes the snippet)" },
        replaceAll: { type: "boolean", description: "replace every occurrence instead of requiring a unique match" },
      },
      required: ["path", "oldString", "newString"],
    },
  },
  shell: {
    name: "shell",
    description:
      "Run a command in the project root. 'command' must be a single executable name — put every argument in 'args', which is passed literally (no shell interpretation, no globbing).",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } } },
      required: ["command"],
    },
  },
};

// Appended to every agent's system prompt. Git awareness is guidance, not a tool: `shell` already
// runs git, and a project can make it silent with `permissions: { shell: { "git diff*": allow } }`
// in .niti/agents.yaml — a dedicated git_diff tool would be a second path to the same place.
export const TOOL_GUIDANCE = `

Working habits:
- The project you are in is the whole job. Never look outside it (no '..', no absolute paths elsewhere on the machine).
- Find before you read. 'grep' tells you where something is in one call; 'glob' finds a file by name. Reading files to look for something, or guessing at a path, wastes the turns you need for the actual work.
- Read before you write, and prefer 'edit' (exact snippet replacement) over 'write_file' for changes to an existing file — a blind overwrite loses work you didn't know was there.
- 'edit' matches the file exactly. Copy oldString from what 'read_file' showed you, without the line numbers, and include enough surrounding lines to make it unique.
- You can ask for several independent tool calls in one turn — they run together. Batch your reads and searches instead of spending a turn on each.
- A task that only creates new files needs no exploration at all. Go write the files.
- Verify before you claim to be done: run the project's tests or type-check with 'shell', or 'diagnostics' if it is available. "It should work" is not a finished task.
- Never weaken a check to make it pass. Do not edit, skip, delete or relax a test, an assertion, a lint rule or a build config so a failure turns green — fix the code the check is complaining about. A check you disabled is a bug you shipped.
- Use 'spawn_fork' for a self-contained sub-goal whose details don't belong in this conversation.`;

// Search tools ride along with read_file rather than needing their own entry in every existing
// .niti/agents.yaml. They are strictly read-only and strictly inside the root — an agent already
// trusted to read files is already trusted to find them, and an agent that can't read files has
// no use for either. Without this, every project configured before these tools existed would
// silently keep the blind-navigation harness they were written against.
const SEARCH_TOOLS = ["list_dir", "glob", "grep"];

export function expandTools(allowed: string[]): string[] {
  if (!allowed.includes("read_file")) return allowed;
  const missing = SEARCH_TOOLS.filter((t) => !allowed.includes(t));
  return missing.length > 0 ? [...allowed, ...missing] : allowed;
}

export function toolSpecs(allowed: string[]): ToolSpec[] {
  return allowed.map((n) => SPECS[n]).filter((s): s is ToolSpec => Boolean(s));
}

// Provider tool-call → sandbox ToolCall. Throws on unknown tool (caught by the agent loop).
// POSIX-style word splitting and nothing more: quotes group, backslashes escape, whitespace
// separates. There is no expansion, globbing, pipe or redirect — the result goes to spawn verbatim,
// exactly like args[] would. Splitting on bare whitespace turned `git commit -m "fix bug"` into
// ["git","commit","-m",'"fix','bug"'], a guaranteed failure the model then spent turns diagnosing.
// On Windows a backslash is a path separator, so it only escapes inside nothing at all.
export function splitCommand(line: string): string[] {
  const posix = process.platform !== "win32";
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (posix && c === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!)) cur += line[++i]!;
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (posix && c === "\\" && i + 1 < line.length) {
      cur += line[++i]!;
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) out.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (quote) throw new Error(`unterminated ${quote} quote in shell command — put the arguments in args[] instead`);
  if (inWord) out.push(cur);
  return out;
}

// Models routinely encode a whole command line as `{"command":"git status"}`. The args[] array is
// the documented shape and always wins; tokenizing only fills in when it is absent.
export function normalizeShellInput(input: Record<string, unknown>): { command: string; args: string[] } {
  const line = String(input.command ?? "").trim();
  if (Array.isArray(input.args) && input.args.length) return { command: line.split(/\s+/)[0] ?? "", args: input.args.map(String) };
  const [command = "", ...args] = splitCommand(line);
  return { command, args };
}

// Inputs already rewritten to {command, args}. A command that legitimately contains a space (a path
// like "/Applications/My App/tool" with no args) would be split a second time otherwise.
const NORMALIZED = new WeakSet<object>();

// Rewrite a shell call's input to its canonical {command, args} shape, once, before anything
// looks at it. The permission and danger checks (isDangerousShellCall, leavesProjectRoot,
// isEgressShellCall) read the raw input, and they judged `{"command":"git push --force"}` by the
// whole string as a command name — so `base === "git"` never matched, while execution went on to
// split it and run git anyway. Checks and execution must see the same call.
export function canonicalizeShellCall(call: { name: string; input: Record<string, unknown> }): void {
  if (call.name !== "shell" || NORMALIZED.has(call.input)) return;
  const n = normalizeShellInput(call.input);
  call.input = { ...call.input, command: n.command, args: n.args };
  NORMALIZED.add(call.input);
}

export function toSandboxCall(c: ProviderCall): ToolCall {
  const i = c.input ?? {};
  // Models hand back "12" as often as 12 for a numeric field, and a NaN offset silently became
  // "read from line NaN" — i.e. the whole file, with the paging hint the model asked for ignored.
  const num = (v: unknown): number | undefined => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : undefined;
  };
  switch (c.name) {
    case "read_file":
      return { tool: "read_file", path: String(i.path ?? ""), offset: num(i.offset), limit: num(i.limit) };
    case "list_dir":
      return { tool: "list_dir", path: i.path === undefined ? "." : String(i.path) };
    case "glob":
      return { tool: "glob", pattern: String(i.pattern ?? ""), limit: num(i.limit) };
    case "grep":
      return {
        tool: "grep",
        pattern: String(i.pattern ?? ""),
        path: i.path === undefined ? undefined : String(i.path),
        glob: i.glob === undefined ? undefined : String(i.glob),
        limit: num(i.limit),
        ignoreCase: i.ignoreCase === true,
      };
    case "write_file":
      return { tool: "write_file", path: String(i.path ?? ""), content: String(i.content ?? "") };
    case "edit":
      return {
        tool: "edit",
        path: String(i.path ?? ""),
        oldString: String(i.oldString ?? ""),
        newString: String(i.newString ?? ""),
        replaceAll: i.replaceAll === true,
      };
    case "shell": {
      const n = NORMALIZED.has(c.input) ? { command: String(i.command ?? ""), args: (i.args as unknown[]).map(String) } : normalizeShellInput(i);
      return { tool: "shell", command: n.command, args: n.args };
    }
    default:
      throw new Error(`unknown tool: ${c.name}`);
  }
}
