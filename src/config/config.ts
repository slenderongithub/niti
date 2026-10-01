import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { parse, parseDocument, type Document } from "yaml";
import type { AgentConfig } from "../agent/agent.ts";
import type { McpServerConfig } from "../mcp/mcp.ts";
import type { LspServerConfig } from "../lsp/registry.ts";
import { parsePermissions, type PermissionRules } from "../permissions.ts";
import { CATALOG, providerKeys } from "../providers/catalog.ts";
import { parseReasoning } from "../providers/provider.ts";
import { truncateMiddle } from "../agent/context.ts";

// Find the project root the way git finds a repo: walk up for the first ancestor holding .niti/
// (or, failing that, .git/). Every path in niti is cwd-relative, so running from a subdirectory
// used to create a second, empty .niti/ there and start with zero agents — while the real config
// sat one level up. Call this once at process start, before any loader runs.
// `dir` is the home directory, however either side is spelled: cwd is always a real path, but $HOME
// may be a symlink (or differ in case/trailing slash), and a plain string compare then missed it.
export function isHomeDir(dir: string, home = homedir()): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolvePath(p);
    }
  };
  return dir === home || real(dir) === real(home);
}

export function findProjectRoot(from = process.cwd(), home = homedir()): string {
  const start = resolvePath(from);
  // $HOME is never a project root unless you launched from it: ~/.niti (global config) or a stray
  // ~/.git would otherwise capture every folder under home, showing the whole home dir as "the project".
  const stop = (dir: string) => dir !== start && isHomeDir(dir, home);
  for (let dir = start; !stop(dir); ) {
    if (existsSync(join(dir, ".niti"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // hit the filesystem root
    dir = parent;
  }
  // No .niti/ anywhere: fall back to the enclosing git repo, so `niti "task"` in a fresh checkout
  // roots itself at the project rather than at whatever subdirectory you happened to be in.
  for (let dir = start; !stop(dir); ) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start; // not a repo either — cwd it is
}

// Loads and validates .niti/agents.yaml. User-authored → validate required fields with clear errors.
export function loadAgents(path = ".niti/agents.yaml"): AgentConfig[] {
  // Explicit, so "missing" is distinguishable from "invalid" upstream. readFileSync's own ENOENT
  // message names the path, but every validation error below names it too — and the CLI used to
  // treat both as "no agents configured", telling users to re-run init and overwrite the config
  // they were trying to fix.
  if (!existsSync(path)) throw new Error(`ENOENT: no such file '${path}'`);
  const raw = parse(readFileSync(path, "utf8"));
  const agents = raw?.agents;
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error(`${path}: expected a non-empty 'agents:' list`);
  }
  const max = typeof raw?.maxAgents === "number" && raw.maxAgents > 0 ? raw.maxAgents : undefined;
  if (max && agents.length > max) {
    throw new Error(`${path}: ${agents.length} agents configured but maxAgents is ${max}`);
  }
  return agents.map((a, i) => validate(a, i, path));
}

// Everything in .niti/agents.yaml that isn't an agent, a permission rule or a server: the knobs
// that used to be constants or CLI-only flags. All optional — an agents.yaml with none of them
// behaves exactly as before.
export interface NitiOptions {
  theme?: string; // TUI colour scheme, applied at launch (see tui/internal/theme)
  auto?: boolean; // approve anything not explicitly denied (same as --auto; dangerous commands still prompt)
  watch?: boolean; // false → stop announcing edits made outside niti
  instructions?: string[]; // files (AGENTS.md, CLAUDE.md, …) appended to every agent's system prompt
  maxTurns?: number; // tool-loop cap per agent turn; the built-in default is 12
  maxAgents?: number; // ceiling on team size, enforced when agents.yaml is loaded
  worktree?: boolean; // isolate each run's file writes in a fresh git worktree (same as --worktree)
  // Commands an agent's changes must pass before it may report a task done, e.g.
  // ["bun run typecheck", "bun test"]. Omitted → detected from the project; `false` → never verify.
  verify?: string[] | false;
  autoCompact?: boolean; // false → never compact the context (default true); toggled live via POST /settings
  thinkingMode?: boolean; // false → send no thinking/reasoning parameters (default true)
  // TUI/preference flags, toggled from the Config tab via POST /settings (see PREF_DEFAULTS).
  lightMode?: boolean; // light palette
  reduceMotion?: boolean; // static spinner, no animation ticks
  showTurnDuration?: boolean; // append how long a tool call took to its finished line
  openAgentsView?: boolean; // launch focused on an agent tab instead of the overview
  projectInstructions?: boolean; // false → don't auto-read .niti.md / AGENTS.md (default true)
  repoMap?: boolean; // false → don't put a generated project map in the system prompt
}

export function loadOptions(path = ".niti/agents.yaml"): NitiOptions {
  if (!existsSync(path)) return {};
  const raw = (parse(readFileSync(path, "utf8")) ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" && v > 0 ? v : undefined);
  return {
    theme: typeof raw.theme === "string" ? raw.theme : undefined,
    auto: raw.auto === true,
    watch: raw.watch === undefined ? undefined : raw.watch !== false,
    instructions: Array.isArray(raw.instructions) ? raw.instructions.filter((i): i is string => typeof i === "string") : undefined,
    maxTurns: num(raw.maxTurns),
    maxAgents: num(raw.maxAgents),
    worktree: raw.worktree === true,
    // `false` is meaningful here (turn detection off), so it can't collapse into undefined.
    verify: raw.verify === false ? false : Array.isArray(raw.verify) ? raw.verify.filter((v): v is string => typeof v === "string") : undefined,
    autoCompact: raw.autoCompact === false ? false : undefined,
    thinkingMode: raw.thinkingMode === false ? false : undefined,
    lightMode: raw.lightMode === true ? true : undefined,
    reduceMotion: raw.reduceMotion === true ? true : undefined,
    showTurnDuration: raw.showTurnDuration === true ? true : undefined,
    openAgentsView: raw.openAgentsView === true ? true : undefined,
    projectInstructions: raw.projectInstructions === false ? false : undefined,
    repoMap: raw.repoMap === false ? false : undefined,
  };
}

// The contents of every `instructions:` file, concatenated for the system prompt. A listed file
// that doesn't exist is skipped rather than fatal — AGENTS.md is commonly listed before it's
// written, and half a prompt beats a core that won't boot.
// With `discover`, the first of INSTRUCTION_FILES that exists in the project root is included too,
// so a plain AGENTS.md needs no `instructions:` entry — unless the user already listed it.
export const INSTRUCTION_FILES = [".niti.md", "AGENTS.md", "agents.md"];

// The Config tab's preference flags and their defaults — one table so the core, /session and
// /settings can't disagree about which keys exist.
export const PREF_DEFAULTS = {
  lightMode: false,
  reduceMotion: false,
  showTurnDuration: false,
  openAgentsView: false,
  projectInstructions: true,
  notifyOnDone: true, // bell (and a desktop notification on macOS) when a long run finishes
} as const;
export type PrefKey = keyof typeof PREF_DEFAULTS;

const AUTO_INSTRUCTIONS_MAX_CHARS = 32_000;

export function loadInstructions(files: string[] = [], root = process.cwd(), discover = false): string {
  const parts: string[] = [];
  let auto = discover ? INSTRUCTION_FILES.find((f) => existsSync(join(root, f))) : undefined;
  if (auto && files.some((f) => f.replace(/^\.\//, "").toLowerCase() === auto!.toLowerCase())) auto = undefined; // listed, so chosen
  if (auto) files = [auto, ...files];
  for (const f of files) {
    const p = f.startsWith("/") ? f : join(root, f);
    if (!existsSync(p)) continue;
    let body = readFileSync(p, "utf8").trim();
    // The auto-discovered file is resent at the head of every call to every agent, and nobody chose
    // to pay for it — a 200 KB AGENTS.md became ~50k tokens per call. Files listed under
    // `instructions:` were chosen deliberately, so only the discovered one is capped (~8k tokens).
    if (f === auto) body = truncateMiddle(body, AUTO_INSTRUCTIONS_MAX_CHARS);
    if (body) parts.push(`\n\n# Project instructions (${f})\n\n${body}`);
  }
  return parts.join("");
}

// Project-wide tool policy under a top-level `permissions:` block — the layer consulted when an
// agent's own `permissions:` has nothing to say about a call.
export function loadPermissions(path = ".niti/agents.yaml"): PermissionRules | undefined {
  if (!existsSync(path)) return undefined;
  const raw = parse(readFileSync(path, "utf8")) as { permissions?: unknown };
  return parsePermissions(raw?.permissions, path);
}

// Language servers declared under a top-level `lsp:` block — one entry per language:
//   lsp:
//     typescript: { command: typescript-language-server, args: [--stdio], extensions: [.ts, .tsx] }
// Servers are user-installed; a malformed entry is skipped rather than blocking startup, exactly
// like mcpServers above.
export function loadLspServers(path = ".niti/agents.yaml"): LspServerConfig[] {
  if (!existsSync(path)) return [];
  const raw = parse(readFileSync(path, "utf8")) as { lsp?: unknown };
  if (typeof raw?.lsp !== "object" || raw.lsp == null || Array.isArray(raw.lsp)) return [];
  return Object.entries(raw.lsp as Record<string, unknown>).flatMap(([name, value]) => {
    const s = (value ?? {}) as Record<string, unknown>;
    const extensions = Array.isArray(s.extensions) ? s.extensions.filter((e): e is string => typeof e === "string") : [];
    if (typeof s.command !== "string" || !extensions.length) return [];
    return [{ name, command: s.command, args: Array.isArray(s.args) ? (s.args as string[]) : undefined, extensions }];
  });
}

// MCP servers declared under `mcpServers:` in the same file. Skips malformed entries.
export function loadMcpServers(path = ".niti/agents.yaml"): McpServerConfig[] {
  if (!existsSync(path)) return [];
  const raw = parse(readFileSync(path, "utf8")) as { mcpServers?: unknown } | null;
  if (!Array.isArray(raw?.mcpServers)) return []; // raw is null for an empty file
  return raw.mcpServers.flatMap((s: unknown) => {
    const r = (s ?? {}) as Record<string, unknown>;
    if (typeof r.name !== "string" || typeof r.command !== "string") return [];
    return [{ name: r.name, command: r.command, args: Array.isArray(r.args) ? (r.args as string[]) : undefined }];
  });
}

// Every write to agents.yaml goes through here. Two ways the old inline writes lost a user's config:
// a crash or concurrent writer mid-writeFileSync left a truncated file (so it is tmp + rename, like
// the task board and the auth store), and a hand-edited file with a YAML error was re-serialised
// from a half-parsed document, replacing what the user had with whatever survived the parse.
function editConfig(path: string, apply: (doc: Document) => void): void {
  mkdirSync(dirname(path), { recursive: true });
  const doc = existsSync(path) ? parseDocument(readFileSync(path, "utf8")) : parseDocument("{}");
  if (doc.errors.length) {
    throw new Error(`${path} is not valid YAML (${doc.errors[0]!.message}) — fix it by hand; niti will not overwrite it`);
  }
  apply(doc);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, doc.toString());
  renameSync(tmp, path);
}

// Persist role assignments back to .niti/agents.yaml (written by the team picker and the live
// /model switcher so changes survive a restart). Keys never land here — they're in auth.json.
//
// Only the `agents:` key is replaced: the picker runs on every launch, and rewriting the file from
// scratch would silently delete the permissions/lsp/mcpServers blocks and every option next to
// them — config the user hand-wrote and never asked to have touched.
export function saveAgents(agents: AgentConfig[], path = ".niti/agents.yaml"): void {
  // The read path validated carefully and the write path validated nothing — yet the write path is
  // the one facing untrusted input (POST /agents). One guard here covers all three writers: the
  // HTTP route, the init wizard, and the TUI team picker.
  agents.forEach((a, i) => validate(a, i, path));
  // Only the `agents:` key is replaced, and only through the Document API — so comments elsewhere
  // in the file (and any top-level key niti does not know about) survive a picker relaunch.
  const next = {
    agents: agents.map((a) => ({
      id: a.id,
      provider: a.provider,
      model: a.model,
      role: a.role,
      ...(a.lead ? { lead: true } : {}),
      systemPrompt: a.systemPrompt,
      ...(a.allowedTools ? { allowedTools: a.allowedTools } : {}),
      ...(a.baseURL ? { baseURL: a.baseURL } : {}),
      ...(a.autoApprove ? { autoApprove: a.autoApprove } : {}),
      ...(a.permissions ? { permissions: a.permissions } : {}),
      ...(a.reviewer ? { reviewer: a.reviewer } : {}),
      ...(a.reasoning ? { reasoning: a.reasoning } : {}),
      ...(a.maxOutput ? { maxOutput: a.maxOutput } : {}),
    })),
  };
  editConfig(path, (doc) => doc.set("agents", next.agents));
}

// Persist the active theme name back to .niti/agents.yaml (written by the TUI's theme carousel so
// the choice survives a restart and the web dashboard can read it back via loadOptions()). Same
// read-merge-write shape as saveAgents — only the `theme` key is touched.
export function setTheme(theme: string, path = ".niti/agents.yaml"): void {
  // parse→stringify round-trips *data*, discarding every comment in the file. This runs on every
  // keypress of the theme carousel, so a user who documented their roster lost all of it the first
  // time they cycled a colour scheme. The Document API edits in place and keeps the rest verbatim.
  editConfig(path, (doc) => doc.set("theme", theme));
}

// Persist the approval mode back to .niti/agents.yaml (written by the team picker's setup question
// and by /auto | /manual) so the choice survives a restart. Same read-merge-write shape as
// setTheme — only the `auto` key is touched, every comment and hand-written block around it stays.
export function setOption(key: string, value: boolean, path = ".niti/agents.yaml"): void {
  editConfig(path, (doc) => doc.set(key, value));
}

export const setAuto = (on: boolean, path?: string): void => setOption("auto", on, path);

function validate(a: unknown, i: number, path: string): AgentConfig {
  const rec = (a ?? {}) as Record<string, unknown>;
  const str = (k: string): string => {
    const v = rec[k];
    if (typeof v !== "string" || v === "") throw new Error(`${path} agent[${i}]: missing '${k}'`);
    return v;
  };
  const provider = str("provider");
  if (!CATALOG[provider]) {
    throw new Error(`${path} agent[${i}]: unknown provider '${provider}' (known: ${providerKeys().join(", ")})`);
  }
  const baseURL = typeof rec.baseURL === "string" ? rec.baseURL : undefined;
  if (provider === "custom" && !baseURL) {
    throw new Error(`${path} agent[${i}]: provider 'custom' requires a 'baseURL'`);
  }
  return {
    id: str("id"),
    provider,
    model: str("model"),
    role: str("role"),
    systemPrompt: str("systemPrompt"),
    allowedTools: Array.isArray(rec.allowedTools) ? (rec.allowedTools as string[]) : undefined,
    lead: rec.lead === true,
    baseURL,
    autoApprove: Array.isArray(rec.autoApprove) ? (rec.autoApprove as string[]) : undefined,
    permissions: parsePermissions(rec.permissions, `${path} agent[${i}]`),
    reviewer: typeof rec.reviewer === "string" ? rec.reviewer : undefined,
    reasoning: parseReasoning(rec.reasoning),
    maxOutput: Number.isInteger(rec.maxOutput) && (rec.maxOutput as number) > 0 ? (rec.maxOutput as number) : undefined,
  };
}
