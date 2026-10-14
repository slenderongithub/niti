import { existsSync } from "node:fs";
import { Engine } from "../engine.ts";
import { loadAgents, loadMcpServers, loadPermissions, loadLspServers, loadOptions, loadInstructions, saveAgents, type NitiOptions } from "../config/config.ts";
import type { AgentConfig } from "../agent/agent.ts";
import { LspRegistry } from "../lsp/registry.ts";
import { makeProvider } from "../providers/factory.ts";
import { McpManager } from "../mcp/mcp.ts";
import { loadSkills, skillsPrompt } from "../skills/skills.ts";
import { loadTasks } from "../session.ts";
import { openDb } from "../store/db.ts";
import { SessionStore } from "../store/session-store.ts";
import { AuditLog } from "../store/audit-log.ts";
import { startServer, type ServerHandle } from "./server.ts";
import { startModelRefresh, isDeprecated } from "../providers/live-catalog.ts";
import { RemoteBridge } from "../remote/bridge.ts";

interface ServeResult {
  engine: Engine;
  server: ServerHandle;
}

// The Engine as .niti/agents.yaml describes it — one builder for the server and the CLI's headless
// run, so an option wired into one can't be missing from the other. Flags (`auto`, `worktree`) can
// only turn a setting on; `watch` is the default when agents.yaml says nothing.
export async function buildEngine(o: { configs: AgentConfig[]; interactive: boolean; auto?: boolean; worktree?: boolean; watch?: boolean }): Promise<{ engine: Engine; options: NitiOptions }> {
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
    configs: o.configs,
    makeProvider,
    mcp,
    systemSuffix: skillText,
    interactive: o.interactive,
    store: new SessionStore(db),
    audit: new AuditLog(db),
    permissions: loadPermissions(),
    settings: { autoCompact: options.autoCompact, thinkingMode: options.thinkingMode },
    auto: o.auto || options.auto,
    lsp: new LspRegistry(loadLspServers()),
    watch: options.watch ?? o.watch,
    maxTurns: options.maxTurns,
    verify: options.verify,
    repoMap: options.repoMap,
    sandbox: options.sandbox,
    worktree: o.worktree || options.worktree,
    persist: (configs) => saveAgents(configs),
  });
  return { engine, options };
}

// Boot the headless core: build the engine from .niti/agents.yaml, start the local server, and
// print the handshake line the Go TUI parses from stdout. Everything else logs to stderr so the
// first stdout line is always the handshake.
export async function serveMain(opts: { port?: number; interactive?: boolean; auto?: boolean; worktree?: boolean } = {}): Promise<ServeResult> {
  // A promise rejection nobody awaited — a provider stream, an MCP/LSP child, a timer — is a failure
  // of that one operation, not of the core. Without a handler it killed the whole core, and with it
  // every running agent. Log it (stderr is .niti/core.log), show it in the transcript, keep serving.
  // A synchronous uncaught exception is deliberately NOT caught: the process state is unknown after
  // one, so it exits, and the TUI reports "the core exited — see .niti/core.log".
  let notify = (_msg: string) => {};
  process.on("unhandledRejection", (err: unknown) => {
    console.error(`niti: unhandled rejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    notify(`unhandled error: ${err instanceof Error ? err.message : String(err)} (details in .niti/core.log)`);
  });
  // Setup mode: with no config yet, start empty so the onboarding wizard can drive /auth and
  // /agents against a live server. Once agents.yaml exists we load it (invalid files still throw).
  const configs = existsSync(".niti/agents.yaml") ? loadAgents() : [];
  if (!configs.length) console.error("niti: no agents configured yet — running in setup mode");
  const { engine, options } = await buildEngine({
    configs,
    interactive: opts.interactive ?? true, // gate write_file/shell through approvals by default
    auto: opts.auto,
    worktree: opts.worktree,
    // A long-lived server is exactly where an external edit is worth announcing, so watching is on
    // unless agents.yaml explicitly says otherwise.
    watch: true,
  });
  notify = (payload) => engine.bus.publish({ agentId: "orchestrator", type: "error", payload, time: Date.now() });
  engine.orch.load(loadTasks()); // show any prior tasks on connect
  engine.goal.load(); // a goal the last core left behind comes back paused

  const server = startServer(engine, { port: opts.port, theme: options.theme, prefs: options });
  // Remote control: only here, never in startServer, so a test server never dials a relay. Idle
  // unless this Mac is signed in (/remote login) and the project hasn't opted out.
  engine.remote = new RemoteBridge(engine, server, { enabled: options.remote !== false });
  engine.remote.start();
  // Handshake — the ONLY thing on stdout, first line, machine-readable for the Go TUI.
  process.stdout.write(JSON.stringify({ nitiServer: { url: server.url, token: server.token } }) + "\n");
  // Model lists: the cached copy applies at once, a fresh one is fetched in the background at most
  // once a day. Either way, an agent configured with a model its provider has deprecated is told.
  const warnDeprecated = () => {
    for (const c of configs) {
      if (isDeprecated(c.provider, c.model)) {
        engine.bus.publish({ agentId: c.id, type: "warning", payload: `${c.provider}/${c.model} is deprecated by its provider — pick a current model with /model`, time: Date.now() });
      }
    }
  };
  void startModelRefresh().then(warnDeprecated);
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
