import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Engine } from "../engine.ts";
import { splitModelId } from "../providers/catalog.ts";
import { costOf } from "../providers/pricing.ts";
import { saveTasks } from "../session.ts";
import { loadSkills } from "../skills/skills.ts";
import { isGitRepo, snapshotBranch } from "../orchestrator/worktree.ts";
import { buildExportReport } from "./export.ts";

// Slash commands live here, on the server, rather than in the Go TUI's key handler — otherwise the
// web dashboard needs an identical second implementation of every one of them. Clients fetch the
// list (for autocomplete/help) and POST a name to run it.

export interface CommandResult {
  ok: boolean;
  message: string;
  view?: string; // a pure client-side view switch ("panes" | "graph" | "usage")
}

export interface Command {
  name: string; // without the leading slash
  description: string;
  run: (engine: Engine, args: string) => Promise<CommandResult>;
}

const view = (name: string): Command => ({
  name,
  description: `Switch to the ${name} view`,
  async run() {
    return { ok: true, message: "", view: name };
  },
});

export const BUILTIN_COMMANDS: Command[] = [
  view("usage"),
  {
    name: "cancel",
    description: "Stop launching new work; in-flight tasks finish",
    async run(engine) {
      engine.cancel();
      return { ok: true, message: "cancelling — in-flight tasks will finish" };
    },
  },
  {
    name: "undo",
    description: "Revert the most recent file write an agent made",
    async run(engine) {
      return { ok: true, message: engine.undo() };
    },
  },
  {
    name: "rewind",
    description: "Revert the last N file writes at once (default 1): /rewind [n]",
    async run(engine, args) {
      const n = Math.max(1, parseInt(args.trim(), 10) || 1);
      return { ok: true, message: engine.rewind(n) };
    },
  },
  {
    name: "branch",
    description: "Snapshot the current working tree to a git branch, e.g. before a /rewind: /branch <name>",
    async run(engine, args) {
      const name = args.trim();
      if (!name) return { ok: false, message: "usage: /branch <name>" };
      if (!(await isGitRepo(engine.root))) return { ok: false, message: "not a git repository" };
      const r = await snapshotBranch(engine.root, name);
      return { ok: r.ok, message: r.message };
    },
  },
  {
    name: "model",
    description: "Switch an agent's model: /model <agentId> <provider/model>",
    async run(engine, args) {
      const [agentId, modelId] = args.trim().split(/\s+/);
      if (!agentId || !modelId) return { ok: false, message: "usage: /model <agentId> <provider/model>" };
      const parsed = splitModelId(undefined, modelId);
      const err = engine.switchModel(agentId, parsed.provider, parsed.model);
      return err ? { ok: false, message: err } : { ok: true, message: `${agentId} → ${modelId}` };
    },
  },
  {
    name: "sessions",
    description: "List stored sessions (conversations) for this project",
    async run(engine, args) {
      if (!engine.store) return { ok: false, message: "no session store — sessions aren't being persisted" };
      const rows = engine.store.listSessions(args.trim() ? { taskId: args.trim() } : {});
      if (!rows.length) return { ok: true, message: "no sessions yet" };
      return {
        ok: true,
        message: rows.map((r) => `${r.id.slice(0, 8)} ${r.kind.padEnd(5)} ${r.agentId} ${r.provider}/${r.model} [${r.status}]${r.taskId ? ` ${r.taskId}` : ""}`).join("\n"),
      };
    },
  },
  {
    name: "agents",
    description: "Show the team: who's on it, on which model, with which tools",
    async run(engine) {
      return {
        ok: true,
        message: engine.configs
          .map((c) => `${c.lead ? "★" : " "} ${c.id.padEnd(16)} ${c.provider}/${c.model}  [${(c.allowedTools ?? ["(all)"]).join(",")}]`)
          .join("\n"),
      };
    },
  },
  {
    name: "tasks",
    description: "Show the task board — what is planned, running, done or failed",
    async run(engine) {
      const tasks = engine.orch.all;
      if (!tasks.length) return { ok: true, message: "no tasks yet — describe what you want built" };
      return {
        ok: true,
        message: tasks
          .map((t) => `${TASK_GLYPH[t.status] ?? "○"} ${t.id.padEnd(8)} ${t.assignedTo ?? "-"}  ${t.description}`)
          .join("\n"),
      };
    },
  },
  {
    name: "skills",
    description: "List the skills agents can read from .amux/skills/",
    async run() {
      // Read from disk rather than off the engine: skills are files, and a skill added mid-session
      // should show up without a restart. The list is small and this is a manual command.
      const skills = loadSkills();
      if (!skills.length) {
        return { ok: true, message: "no skills yet — add .amux/skills/<name>/SKILL.md (name + description frontmatter)" };
      }
      return { ok: true, message: skills.map((s) => `${s.name.padEnd(20)} ${s.description || "(no description)"}`).join("\n") };
    },
  },
  {
    name: "mcp",
    description: "List connected MCP servers and how many tools each contributes",
    async run(engine) {
      const servers = engine.mcp?.servers?.() ?? [];
      if (!servers.length) return { ok: true, message: "no MCP servers connected (configure them under mcpServers: in .amux/agents.yaml)" };
      return { ok: true, message: servers.map((s) => `${s.name}  ${s.tools} tools`).join("\n") };
    },
  },
  {
    name: "lsp",
    description: "List configured language servers and whether each is running",
    async run(engine) {
      const servers = engine.lsp?.list() ?? [];
      if (!servers.length) return { ok: true, message: "no language servers configured (add an lsp: block to .amux/agents.yaml)" };
      return {
        ok: true,
        message: servers.map((s) => `${s.running ? "●" : "○"} ${s.name}  ${s.command}  ${s.extensions.join(" ")}`).join("\n"),
      };
    },
  },
  {
    name: "permissions",
    description: "Show which tools each agent may use without asking",
    async run(engine) {
      const lines = engine.configs.map((c) => {
        const rules = Object.entries(c.permissions ?? {}).flatMap(([tool, patterns]) =>
          Object.entries(patterns as Record<string, string>).map(([pattern, decision]) => `${tool}:${pattern}=${decision}`),
        );
        const pre = (c.autoApprove ?? []).map((t) => `${t}=allow`);
        return `${c.id.padEnd(16)} ${[...pre, ...rules].join("  ") || "(everything asks)"}`;
      });
      return { ok: true, message: lines.join("\n") };
    },
  },
  {
    name: "cost",
    description: "Show session spend, broken down per agent",
    async run(engine) {
      const lines: string[] = [];
      let total = 0;
      let complete = true;
      for (const { agentId, usage } of engine.usage.snapshot()) {
        const cfg = engine.configs.find((c) => c.id === agentId);
        if (!cfg) continue;
        const { usd, priced } = costOf(cfg.provider, cfg.model, usage.inputTokens, usage.outputTokens);
        total += usd;
        if (!priced) complete = false;
        lines.push(`${agentId.padEnd(16)} ${usage.inputTokens}in ${usage.outputTokens}out  $${usd.toFixed(4)}${priced ? "" : " (unpriced)"}`);
      }
      if (!lines.length) return { ok: true, message: "nothing spent yet" };
      return { ok: true, message: [...lines, `TOTAL $${total.toFixed(4)}${complete ? "" : "+"}`].join("\n") };
    },
  },
  {
    name: "status",
    description: "Summarise this session: project, team, progress and spend",
    async run(engine) {
      const tasks = engine.orch.all;
      const done = tasks.filter((t) => t.status === "done").length;
      const totals = engine.usage.totals();
      return {
        ok: true,
        message: [
          `project   ${engine.root}`,
          `team      ${engine.configs.length} agents${engine.running ? " — running" : ""}`,
          `tasks     ${done}/${tasks.length} done`,
          `tokens    ${totals.inputTokens}in ${totals.outputTokens}out over ${totals.calls} calls`,
          `wired to  ${engine.lsp?.list().length ?? 0} LSP · ${engine.mcp?.servers?.().length ?? 0} MCP · history ${engine.store ? "on" : "off"}`,
        ].join("\n"),
      };
    },
  },
  {
    name: "debate",
    description: "Have two agents debate a question and return a synthesis: /debate <agentA> <agentB> <question>",
    async run(engine, args) {
      const m = args.trim().match(/^(\S+)\s+(\S+)\s+(.+)$/s);
      if (!m) return { ok: false, message: "usage: /debate <agentA> <agentB> <question>" };
      const [, a, b, question] = m;
      if (!engine.configs.some((c) => c.id === a)) return { ok: false, message: `no such agent: ${a}` };
      if (!engine.configs.some((c) => c.id === b)) return { ok: false, message: `no such agent: ${b}` };
      return { ok: true, message: await engine.debate(a, b, question) };
    },
  },
  {
    name: "export",
    description: "Write a session audit report (tasks, transcripts, cost, diff) to .amux/reports/",
    async run(engine) {
      const { message } = await buildExportReport(engine);
      return { ok: true, message };
    },
  },
  {
    name: "resume",
    description: "Pick the previous session's unfinished tasks back up",
    async run(engine) {
      if (engine.running) return { ok: false, message: "a task is already running" };
      if (!engine.orch.all.some((t) => t.status !== "done")) return { ok: false, message: "nothing left to resume" };
      engine.resume().catch(() => {}); // long-running: progress arrives over the event stream
      return { ok: true, message: "resuming unfinished tasks" };
    },
  },
  {
    name: "clear",
    description: "Empty the task board and start from a clean slate",
    async run(engine) {
      if (engine.running) return { ok: false, message: "cancel the running task first" };
      const n = engine.orch.all.length;
      engine.orch.clear();
      saveTasks([]); // otherwise a restart resurrects the board this just cleared
      return { ok: true, message: `cleared ${n} task(s)` };
    },
  },
  {
    name: "init",
    description: "Have the team read this project and write an AGENTS.md for it",
    async run(engine) {
      if (engine.running) return { ok: false, message: "a task is already running" };
      engine.submit(INIT_PROMPT).catch(() => {});
      return { ok: true, message: "analysing the project → AGENTS.md" };
    },
  },
];

const TASK_GLYPH: Record<string, string> = { done: "●", in_progress: "◐", failed: "✖", pending: "○" };

const INIT_PROMPT =
  "Read this repository — its layout, build/test commands, conventions and dependencies — and write " +
  "an AGENTS.md at the project root describing them for future agents. Keep it short and factual: " +
  "how to build, how to test, how the code is organised, and any conventions a newcomer would " +
  "otherwise get wrong. If AGENTS.md already exists, update it rather than duplicating it.";

// User-defined commands: .amux/commands/<name>.md, YAML frontmatter (name/description) + a prompt
// body. Deliberately the same shape as .amux/skills/<name>/SKILL.md (see skills/skills.ts) rather
// than a second config format to learn. `$ARGUMENTS` in the body is replaced with whatever the user
// typed after the command.
export function loadCommands(dir = ".amux/commands"): Command[] {
  if (!existsSync(dir)) return [];
  const commands: Command[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const raw = readFileSync(join(dir, entry.name), "utf8");
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
    const fm = (m ? (parse(m[1]!) ?? {}) : {}) as Record<string, unknown>;
    const body = (m ? raw.slice(m[0].length) : raw).trim();
    const name = typeof fm.name === "string" ? fm.name : entry.name.replace(/\.md$/, "");
    commands.push({
      name,
      description: typeof fm.description === "string" ? fm.description : `Run the ${name} prompt`,
      async run(engine, args) {
        const prompt = body.replaceAll("$ARGUMENTS", args.trim());
        if (engine.running) return { ok: false, message: "a task is already running" };
        engine.submit(prompt).catch(() => {}); // long-running: progress arrives over the event stream
        return { ok: true, message: `running /${name}` };
      },
    });
  }
  return commands;
}

export class CommandRegistry {
  private byName = new Map<string, Command>();

  // User commands are loaded last and win on a name clash — a project can override a built-in.
  constructor(commands: Command[] = [...BUILTIN_COMMANDS, ...loadCommands()]) {
    for (const c of commands) this.byName.set(c.name, c);
    // /help lives here rather than in BUILTIN_COMMANDS because it's the one command that has to
    // see the finished registry — including whatever .amux/commands/ added.
    if (!this.byName.has("help")) {
      this.byName.set("help", {
        name: "help",
        description: "List every command",
        run: async () => ({
          ok: true,
          message: this.list()
            .map((c) => `/${c.name.padEnd(12)} ${c.description}`)
            .join("\n"),
        }),
      });
    }
  }

  list(): { name: string; description: string }[] {
    return [...this.byName.values()].map(({ name, description }) => ({ name, description }));
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  async run(engine: Engine, name: string, args = ""): Promise<CommandResult> {
    const cmd = this.byName.get(name);
    if (!cmd) return { ok: false, message: `unknown command: /${name}` };
    try {
      return await cmd.run(engine, args);
    } catch (err) {
      return { ok: false, message: `/${name} failed: ${err instanceof Error ? err.message : err}` };
    }
  }
}
