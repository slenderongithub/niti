// Config-driven tool permissions: which tool calls run silently, which prompt, which are refused
// outright. Replaces the old fixed `GATED = {write_file, shell}` set in the agent loop.
//
//   permissions:
//     shell:      { "git *": allow, "git commit *": ask, "git push --force*": deny }
//     write_file: { "src/**": allow, "*": ask }
//
// Layers are consulted in order (agent config → project config → --auto → built-in defaults); the
// first layer with a matching pattern decides. Unmatched everywhere → "ask".
import { normalize } from "node:path";

export type Decision = "allow" | "ask" | "deny";
export type ToolRules = Record<string, Decision>; // pattern → decision
export type PermissionRules = Record<string, ToolRules>; // tool name (or "*") → patterns

export const DECISIONS: Decision[] = ["allow", "ask", "deny"];

// Same effect as the pre-config behaviour: reads are free, everything else (write_file, shell, MCP
// tools, …) prompts. An agent with no `permissions:` block therefore behaves exactly as before.
export const DEFAULT_RULES: PermissionRules = {
  read_file: { "*": "allow" },
  // Read-only questions about code, answered by a language server — prompting for these would make
  // "check your work compiles" cost a dialog per call.
  diagnostics: { "*": "allow" },
  hover: { "*": "allow" },
};

// Approving anything not explicitly denied (`--auto`). Sits below the user's own layers, so a
// project `deny` still wins, and dangerous shell commands still force a prompt (see agent.ts).
export const AUTO_RULES: PermissionRules = { "*": { "*": "allow" } };

// Read-only shell commands common enough, and harmless enough, that prompting for every one of them
// is friction rather than protection. Without this the very first thing a fresh team does — `ls`,
// `git status`, `cat package.json` — costs a dialog each, which is what made the tool feel broken
// before anything had even been written.
//
// Consulted BELOW everything the user configured (see agent.ts), so an explicit `permissions:` block
// — allow, ask, or deny — always wins; this only fills the silence when nobody said anything. It is
// also not trusted for a command that reaches outside the project: `leavesProjectRoot` in agent.ts
// force-asks those, because `shell` pins cwd to the root but does not jail arguments, and "let ls
// stop nagging" must not quietly become "let cat read your home directory".
export const SAFE_SHELL_RULES: PermissionRules = {
  shell: {
    "git status*": "allow",
    "git diff*": "allow",
    "git log*": "allow",
    "git branch*": "allow",
    "git show*": "allow",
    "ls*": "allow",
    "pwd*": "allow",
    "cat *": "allow",
    "head *": "allow",
    "tail *": "allow",
    "wc *": "allow",
    "echo *": "allow",
    "grep *": "allow",
    "rg *": "allow",
    // `find` earns its place (agents reach for it constantly) but `find -delete`/`-exec` is caught
    // by isDangerousShellCall, which force-asks regardless of anything decided here.
    "find *": "allow",
  },
};

const STRICTNESS: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };

// What a pattern is matched against: the whole command line for shell, the file path otherwise.
export function subject(tool: string, input: Record<string, unknown>): string {
  if (tool === "shell") {
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    return [String(input.command ?? ""), ...args].join(" ").trim();
  }
  // Normalized, because the pattern is matched against raw model output and the *executed* path is
  // resolved later by safePath. Unnormalized, `./secret.txt` slipped past a `secret*` deny and
  // `src/../.niti/agents.yaml` satisfied an `src/**` allow — both writing the same file the rule
  // was protecting.
  return typeof input.path === "string" ? normalize(input.path) : "";
}

// Path subjects use real glob semantics (`src/*` ≠ `src/**`, as in approval.ts). Command lines are
// not paths — `"rm -rf*"` must match `rm -rf /tmp/x`, which a path glob refuses because `*` won't
// cross a `/` — so they match on plain `*`/`?` wildcards instead.
function matches(pattern: string, subj: string, kind: "path" | "text"): boolean {
  if (pattern === "*" || pattern === "**") return true; // "everything", whatever the subject looks like
  if (kind === "path") return new Bun.Glob(pattern).match(subj);
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return re.test(subj);
}

// Most specific pattern wins (longest literal); an exact tie goes to the stricter decision, so a
// careless config can never silently become more permissive than its author intended.
function matchRules(rules: ToolRules | undefined, subj: string, kind: "path" | "text"): Decision | undefined {
  if (!rules) return undefined;
  let best: { length: number; decision: Decision } | undefined;
  for (const [pattern, decision] of Object.entries(rules)) {
    if (!matches(pattern, subj, kind)) continue;
    const better =
      !best || pattern.length > best.length || (pattern.length === best.length && STRICTNESS[decision] > STRICTNESS[best.decision]);
    if (better) best = { length: pattern.length, decision };
  }
  return best?.decision;
}

function matchLayer(rules: PermissionRules | undefined, tool: string, subj: string, kind: "path" | "text"): Decision | undefined {
  if (!rules) return undefined;
  return matchRules(rules[tool], subj, kind) ?? matchRules(rules["*"], subj, kind);
}

export function resolve(layers: (PermissionRules | undefined)[], tool: string, input: Record<string, unknown>): Decision {
  const kind = tool === "shell" ? "text" : "path";
  const subj = subject(tool, input);
  for (const layer of layers) {
    const decision = matchLayer(layer, tool, subj, kind);
    if (decision) return decision;
  }
  return "ask";
}

// Validate a user-authored `permissions:` block (agents.yaml). Returns undefined for a missing
// block; throws with a pointed message on anything malformed.
export function parsePermissions(raw: unknown, where: string): PermissionRules | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: 'permissions' must be a mapping of tool → { pattern: allow|ask|deny }`);
  const out: PermissionRules = {};
  for (const [tool, patterns] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof patterns !== "object" || patterns == null || Array.isArray(patterns)) {
      throw new Error(`${where}: permissions.${tool} must be a mapping of pattern → allow|ask|deny`);
    }
    const rules: ToolRules = {};
    for (const [pattern, decision] of Object.entries(patterns as Record<string, unknown>)) {
      if (typeof decision !== "string" || !DECISIONS.includes(decision as Decision)) {
        throw new Error(`${where}: permissions.${tool}["${pattern}"] must be one of ${DECISIONS.join(", ")} (got ${JSON.stringify(decision)})`);
      }
      rules[pattern] = decision as Decision;
    }
    out[tool] = rules;
  }
  return out;
}
