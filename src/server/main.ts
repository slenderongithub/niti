import { existsSync } from "node:fs";
import { Engine } from "../engine.ts";
import { loadAgents, loadMcpServers, loadPermissions, loadLspServers, loadOptions, loadInstructions, findProjectRoot } from "../config/config.ts";
import { LspRegistry } from "../lsp/registry.ts";
import { makeProvider } from "../providers/factory.ts";
import { McpManager } from "../mcp/mcp.ts";
import { loadSkills, skillsPrompt } from "../skills/skills.ts";
import { loadTasks } from "../session.ts";
import { openDb } from "../store/db.ts";
import { SessionStore } from "../store/session-store.ts";
import { AuditLog } from "../store/audit-log.ts";
import { startServer, type ServerHandle } from "./server.ts";

export interface ServeResult {
  engine: Engine;
  server: ServerHandle;
}

// Boot the headless core: build the engine from .niti/agents.yaml, start the local server, and
// print the handshake line the Go TUI parses from stdout. Everything else logs to stderr so the
// first stdout line is always the handshake.
export async function serveMain(opts: { port?: number; interactive?: boolean; auto?: boolean; worktree?: boolean } = {}): Promise<ServeResult> {
  // Same root discovery as the CLI: the TUI spawns this directly, so it needs it too.
  const projectRoot = findProjectRoot();
  if (projectRoot !== process.cwd()) process.chdir(projectRoot);
  // Setup mode: with no config yet, start empty so the onboarding wizard can drive /auth and
  // /agents against a live server. Once agents.yaml exists we load it (invalid files still throw).
  const configs = existsSync(".niti/agents.yaml") ? loadAgents() : [];
  if (!configs.length) console.error("niti: no agents configured yet — running in setup mode");
  const options = loadOptions();
  const skillText = skillsPrompt(loadSkills()) + loadInstructions(options.instructions, process.cwd(), options.projectInstructions !== false);

  const mcpServers = loadMcpServers();
  let mcp: McpManager | undefined;
  if (mcpServers.length) {
    mcp = new McpManager();
    await mcp.connect(mcpServers, (name, err) => console.error(`niti: MCP server '${name}' unavailable: ${err}`));
  }

  const db = openDb();
  const engine = new Engine({
    configs,
    makeProvider,
    mcp,
    systemSuffix: skillText,
    interactive: opts.interactive ?? true, // gate write_file/shell through approvals by default
    store: new SessionStore(db),
    audit: new AuditLog(db),
    permissions: loadPermissions(),
    settings: { autoCompact: options.autoCompact, thinkingMode: options.thinkingMode },
    auto: opts.auto || options.auto, // the flag and the config both turn it on; neither can turn the other off
    lsp: new LspRegistry(loadLspServers()),
    // A long-lived server is exactly where an external edit is worth announcing, so watching is on
    // unless agents.yaml explicitly says otherwise.
    watch: options.watch ?? true,
    maxTurns: options.maxTurns,
    verify: options.verify,
    repoMap: options.repoMap,
    worktree: opts.worktree || options.worktree,
  });
  engine.orch.load(loadTasks()); // show any prior tasks on connect

  const server = startServer(engine, { port: opts.port, theme: options.theme, prefs: options });
  // Handshake — the ONLY thing on stdout, first line, machine-readable for the Go TUI.
  process.stdout.write(JSON.stringify({ nitiServer: { url: server.url, token: server.token } }) + "\n");
  return { engine, server };
}

// Allow `bun run src/server/main.ts` to launch the server standalone.
if (import.meta.main) {
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  serveMain({ port: portArg ? Number(portArg.slice(7)) : undefined, auto: process.argv.includes("--auto") }).catch((err) => {
    console.error(`niti-core serve: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
