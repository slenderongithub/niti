import { dirname, resolve, sep } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ToolSpec, ToolCall as ProviderCall } from "../providers/provider.ts";

// Tool calls an agent may request. Executed locally, jailed to the project root.
export type ToolCall =
  | { tool: "read_file"; path: string }
  | { tool: "write_file"; path: string; content: string }
  | { tool: "edit"; path: string; oldString: string; newString: string; replaceAll?: boolean }
  | { tool: "shell"; command: string; args: string[] };

// Tools that mutate a file at `path` — the set the agent loop checkpoints and locks on.
export const WRITE_TOOLS = new Set(["write_file", "edit"]);

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
    let stdout = "";
    let stderr = "";
    const cap = (buf: string, d: unknown) => (buf.length >= maxOutput ? buf : (buf + d).slice(0, maxOutput));
    const mark = (buf: string) => (buf.length >= maxOutput ? `${buf}\n[output truncated]` : buf);
    child.stdout.on("data", (d) => (stdout = cap(stdout, d)));
    child.stderr.on("data", (d) => (stderr = cap(stderr, d)));
    child.on("close", (code, signal) => {
      // node kills a timed-out child with killSignal; nothing else in this process sends SIGKILL.
      const timedOut = signal === "SIGKILL";
      res({
        stdout: mark(stdout),
        stderr: mark(stderr) + (timedOut ? `\n[timed out after ${timeoutMs / 1000}s]` : ""),
        code: code ?? -1,
      });
    });
    child.on("error", (err) => res({ stdout: mark(stdout), stderr: String(err), code: -1 }));
  });
}

// A tool result is pushed into `turns` and re-sent on every later iteration of the loop, so an
// unbounded read is not one big response — it is one big response per turn, forever. Cap it, and
// refuse binaries outright rather than feeding a model a screenful of replacement characters.
export const READ_FILE_MAX = 256_000;

async function readCapped(abs: string, shown: string): Promise<string> {
  const buf = await readFile(abs);
  if (buf.includes(0)) return `error: ${shown} looks like a binary file (${buf.length} bytes) — not read`;
  const text = buf.toString("utf8");
  if (text.length <= READ_FILE_MAX) return text;
  return `${text.slice(0, READ_FILE_MAX)}\n[truncated: ${shown} is ${text.length} characters, showing the first ${READ_FILE_MAX}]`;
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
      return await readCapped(safePath(root, call.path), call.path);
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
      const r = await shell(root, call.command, call.args);
      return `exit ${r.code}\n${r.stdout}${r.stderr}`;
    }
  }
}

// Patch-based editing: replace an exact snippet rather than rewriting the whole file. An ambiguous
// or absent match is an error, never a guess — the model gets told to include more context, which
// is the same contract Claude Code and OpenCode use (models are trained on this shape).
export function applyEdit(before: string, oldString: string, newString: string, replaceAll: boolean, path = ""): string {
  if (oldString === "") throw new Error(`edit ${path}: oldString must not be empty (use write_file to create a file)`);
  const count = before.split(oldString).length - 1;
  if (count === 0) throw new Error(`edit ${path}: oldString not found`);
  if (count > 1 && !replaceAll) throw new Error(`edit ${path}: oldString occurs ${count} times — include more surrounding context, or set replaceAll`);
  if (replaceAll) return before.split(oldString).join(newString);
  const at = before.indexOf(oldString);
  return before.slice(0, at) + newString + before.slice(at + oldString.length);
}

// The hunk an edit will apply, for the approval prompt. We already know exactly what changes, so
// this is the diff — no LCS pass over the file needed.
export function editDiff(before: string, oldString: string, newString: string): string {
  const at = before.indexOf(oldString);
  const line = at < 0 ? 1 : before.slice(0, at).split("\n").length;
  const minus = oldString.split("\n").map((l) => `-${l}`);
  const plus = newString.split("\n").map((l) => `+${l}`);
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
    description: "Read a UTF-8 text file within the project root.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
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
- The project you are in is the whole job. Every tool call should move your assigned task forward, not survey what is around it — and never look outside the project (no '..', no absolute paths elsewhere on the machine).
- Skip 'ls'/'pwd'/'cat package.json'-style exploration unless you actually need what it would tell you. A task that is just creating new files needs none of it; go write the files.
- Read before you write, and prefer 'edit' (exact snippet replacement) over 'write_file' for changes to an existing file — a blind overwrite loses work you didn't know was there.
- 'git status'/'git diff'/'git log' are worth running when there is real history to check before you touch it. They are not a ritual for every task — skip them when you are only adding new files.
- If 'diagnostics' is available, run it on files you edited before declaring the work done.
- Your tool calls are capped. Spend them on reads and writes that move the task, not on open-ended exploration — running out mid-task means the work is left unfinished.
- Use 'spawn_fork' for a self-contained sub-goal whose details don't belong in this conversation.`;

export function toolSpecs(allowed: string[]): ToolSpec[] {
  return allowed.map((n) => SPECS[n]).filter((s): s is ToolSpec => Boolean(s));
}

// Provider tool-call → sandbox ToolCall. Throws on unknown tool (caught by the agent loop).
export function toSandboxCall(c: ProviderCall): ToolCall {
  const i = c.input ?? {};
  switch (c.name) {
    case "read_file":
      return { tool: "read_file", path: String(i.path ?? "") };
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
      // Models routinely encode a whole command line as `{"command":"git status"}`, which spawned
      // a binary literally named "git status" and failed with a PATH error blaming the user. The
      // args[] array is the documented shape and always wins; splitting only fills in for the
      // other guess.
      // ponytail: whitespace split, no quote handling — `{"command":"echo 'a b'"}` still splits
      // naively. Anything needing quoting has args[] available and gets it right.
      const parts = String(i.command ?? "").trim().split(/\s+/);
      const given = Array.isArray(i.args) && i.args.length ? i.args.map(String) : undefined;
      return {
        tool: "shell",
        command: parts[0] ?? "",
        args: given ?? parts.slice(1),
      };
    }
    default:
      throw new Error(`unknown tool: ${c.name}`);
  }
}
