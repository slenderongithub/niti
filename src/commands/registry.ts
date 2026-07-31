import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Engine } from "../engine.ts";
import { splitModelId } from "../providers/catalog.ts";

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
  view("panes"),
  view("graph"),
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
];

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
