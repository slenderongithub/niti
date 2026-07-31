import { existsSync } from "node:fs";
import { Engine } from "../engine.ts";
import { loadAgents, loadMcpServers, loadPermissions, loadLspServers } from "../config/config.ts";
import { LspRegistry } from "../lsp/registry.ts";
import { makeProvider } from "../providers/factory.ts";
import { McpManager } from "../mcp/mcp.ts";
import { loadSkills, skillsPrompt } from "../skills/skills.ts";
import { loadTasks } from "../session.ts";
import { openDb } from "../store/db.ts";
import { SessionStore } from "../store/session-store.ts";
import { startServer, type ServerHandle } from "./server.ts";

export interface ServeResult {
  engine: Engine;
  server: ServerHandle;
}

// Boot the headless core: build the engine from .amux/agents.yaml, start the local server, and
// print the handshake line the Go TUI parses from stdout. Everything else logs to stderr so the
// first stdout line is always the handshake.
export async function serveMain(opts: { port?: number; interactive?: boolean; auto?: boolean } = {}): Promise<ServeResult> {
  // Setup mode: with no config yet, start empty so the onboarding wizard can drive /auth and
  // /agents against a live server. Once agents.yaml exists we load it (invalid files still throw).
  const configs = existsSync(".amux/agents.yaml") ? loadAgents() : [];
  if (!configs.length) console.error("amux: no agents configured yet — running in setup mode");
  const skillText = skillsPrompt(loadSkills());

  const mcpServers = loadMcpServers();
  let mcp: McpManager | undefined;
  if (mcpServers.length) {
    mcp = new McpManager();
    await mcp.connect(mcpServers, (name, err) => console.error(`amux: MCP server '${name}' unavailable: ${err}`));
  }

  const engine = new Engine({
    configs,
    makeProvider,
    mcp,
    systemSuffix: skillText,
    interactive: opts.interactive ?? true, // gate write_file/shell through approvals by default
    store: new SessionStore(openDb()),
    permissions: loadPermissions(),
    auto: opts.auto,
    lsp: new LspRegistry(loadLspServers()),
    watch: true, // a long-lived server is exactly where an external edit is worth announcing
  });
  engine.orch.load(loadTasks()); // show any prior tasks on connect

  const server = startServer(engine, { port: opts.port });
  // Handshake — the ONLY thing on stdout, first line, machine-readable for the Go TUI.
  process.stdout.write(JSON.stringify({ amuxServer: { url: server.url, token: server.token } }) + "\n");
  return { engine, server };
}

// Allow `bun run src/server/main.ts` to launch the server standalone.
if (import.meta.main) {
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  serveMain({ port: portArg ? Number(portArg.slice(7)) : undefined, auto: process.argv.includes("--auto") }).catch((err) => {
    console.error(`amux serve: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
