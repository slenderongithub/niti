// Tool telemetry → words, ported from the TUI (tui/internal/session/humanize.go, toolfeed.go) so
// both clients describe the same call the same way: `read_file {"path":"a.ts"}` → "Read a.ts".

const strField = (key: string) => new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`); // tolerates a payload cut mid-string
const RE_PATH = strField("(?:path|file_path|filePath)");
const RE_CMD = strField("command");
const RE_Q = strField("(?:query|pattern|symbol)");
const RE_KEY = strField("key");
const RE_KEY_ERROR = /api[ _-]?key|\b(401|403)\b|unauthori[sz]ed|forbidden|invalid (x-api-key|credential|token)|authentication|no API key/i;
const RE_TASK = /^(starting|queued) (\S+?)(?: → (\S+))?: (.*)$/;

const TOOL_VERBS: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  edit: "Edit",
  list_dir: "List",
  list_files: "List",
  glob: "Find",
  grep: "Search",
  search: "Search",
  shell: "Run",
  bash: "Run",
  remember: "Remember",
  recall: "Recall",
  todo: "Plan",
  hover: "Inspect",
  diagnostics: "Check",
};

export const PAST_VERB: Record<string, string> = {
  Run: "Ran",
  Read: "Read",
  Write: "Wrote",
  Edit: "Edited",
  List: "Listed",
  Find: "Found",
  Search: "Searched",
  Check: "Checked",
  Inspect: "Inspected",
  Remember: "Remembered",
  Recall: "Recalled",
};

const NOUNS: Record<string, [string, string]> = {
  Run: ["shell command", "shell commands"],
  Read: ["file", "files"],
  List: ["directory", "directories"],
  Find: ["pattern", "patterns"],
  Search: ["query", "queries"],
  Check: ["time", "times"],
  Inspect: ["symbol", "symbols"],
};

function unescape(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
}

export function truncate(s: string, n: number): string {
  const chars = [...s];
  return chars.length > n ? chars.slice(0, Math.max(n - 1, 0)).join("") + "…" : s;
}

function verbFor(tool: string): string {
  const v = TOOL_VERBS[tool];
  if (v) return v;
  const words = tool.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// "Read src/a.ts", "Run npm test", "Search TODO".
export function describeCall(name: string, args: string): { verb: string; target: string } {
  const verb = verbFor(name);
  if (verb === "Run") {
    try {
      const j = JSON.parse(args) as { command?: string; args?: string[] };
      if (j.command) return { verb, target: truncate(`${j.command} ${(j.args ?? []).join(" ")}`.trim(), 90) };
    } catch {
      /* cut at 180 chars: fall through to the regexes */
    }
  }
  for (const re of [RE_PATH, RE_CMD, RE_Q, RE_KEY]) {
    const m = re.exec(args);
    if (m) return { verb, target: unescape(m[1]!) };
  }
  return { verb, target: verb === "Run" ? "a command" : "" };
}

// "tool_call" start payloads are `name {json}`.
export function parseCall(payload: string): { name: string; args: string } {
  const i = payload.indexOf(" ");
  return i < 0 ? { name: payload, args: "" } : { name: payload.slice(0, i), args: payload.slice(i + 1) };
}

export type NoteTone = "thought" | "step" | "warning" | "error" | "info" | "user";

// A discrete (non-tool) event as a transcript note, or null to drop it — mirrors humanize().
export function noteFor(type: string, payload: string): { tone: NoteTone; text: string; keyError?: boolean } | null {
  const p = payload.trim();
  if (!p) return null;
  switch (type) {
    case "error": {
      const text = p.replace(": error: Error:", ":").replace(/^error: /, "");
      return { tone: "error", text, keyError: RE_KEY_ERROR.test(p) };
    }
    case "warning":
      return { tone: "warning", text: p };
    case "failover":
      return { tone: "warning", text: p };
    case "thought": {
      if (p.startsWith("received ")) return null;
      if (p.startsWith("verifying:") || p.startsWith("verification ") || p.startsWith("plan:")) return { tone: "step", text: p };
      const m = RE_TASK.exec(p);
      if (m) return { tone: "step", text: m[1] === "queued" ? `${m[2]} → ${m[3]}: ${m[4]}` : `${m[2]}: ${m[4]}` };
      return { tone: "thought", text: p };
    }
  }
  return { tone: "info", text: p };
}

export function fmtDur(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

// One finished group of same-verb calls: "Read src/a.ts" alone, "Read 3 files" together.
export function groupLabel(verb: string, n: number, target: string): string {
  const past = PAST_VERB[verb] ?? verb;
  const noun = NOUNS[verb];
  if (n === 1 && target) return `${past} ${target}`;
  if (!noun) return `${past} ×${n}`;
  return `${past} ${n} ${n === 1 ? noun[0] : noun[1]}`;
}
