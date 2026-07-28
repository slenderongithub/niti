import { resolve, sep } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ToolSpec, ToolCall as ProviderCall } from "../providers/provider.ts";

// Tool calls an agent may request. Executed locally, jailed to the project root.
export type ToolCall =
  | { tool: "read_file"; path: string }
  | { tool: "write_file"; path: string; content: string }
  | { tool: "shell"; command: string; args: string[] };

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
    case "shell": {
      const r = await shell(root, call.command, call.args);
      return `exit ${r.code}\n${r.stdout}${r.stderr}`;
    }
  }
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
