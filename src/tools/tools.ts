import { resolve, sep } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
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

function shell(
  root: string,
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  // spawn (never exec/shell:true) with args as an array → no shell metacharacter injection.
  // cwd pinned to root; there is no shell to `cd` out of.
  return new Promise((res) => {
    const child = spawn(command, args, { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => res({ stdout, stderr, code: code ?? -1 }));
    child.on("error", (err) => res({ stdout, stderr: String(err), code: -1 }));
  });
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
      return await readFile(safePath(root, call.path), "utf8");
    case "write_file":
      await writeFile(safePath(root, call.path), call.content);
      return `wrote ${call.path}`;
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
    description: "Run a command in the project root. Args are passed literally (no shell interpretation).",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } } },
      required: ["command"],
    },
  },
};

// Appended to every agent's system prompt. Git awareness is guidance, not a tool: `shell` already
// runs git, and a project can make it silent with `permissions: { shell: { "git diff*": allow } }`
// in .amux/agents.yaml — a dedicated git_diff tool would be a second path to the same place.
export const TOOL_GUIDANCE = `

Working habits:
- Read before you write, and prefer 'edit' (exact snippet replacement) over 'write_file' for changes to an existing file — a blind overwrite loses work you didn't know was there.
- Use 'shell' for git: 'git status', 'git diff', 'git log --oneline -20' tell you what has changed and what state the tree is in. Do that before large edits.
- If 'diagnostics' is available, run it on files you edited before declaring the work done.
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
    case "shell":
      return {
        tool: "shell",
        command: String(i.command ?? ""),
        args: Array.isArray(i.args) ? i.args.map(String) : [],
      };
    default:
      throw new Error(`unknown tool: ${c.name}`);
  }
}
