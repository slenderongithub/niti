#!/usr/bin/env bun
// amux-core — the headless engine + scripting CLI.
//
//   For the interactive session, run the Go TUI: ./amux (build with `bun run build:tui`).
//   This binary is for scripting, automation, and what the Go TUI spawns as its subprocess:
//     amux-core "<task>"           → run one task headlessly and exit (plain-text progress)
//     amux-core resume             → continue the last session's unfinished tasks (with their history)
//     ... --auto                   → approve anything not explicitly denied in agents.yaml
//     ... --worktree               → isolate this run's writes in a fresh git worktree (manual merge)
//     amux-core init               → setup wizard: add providers, assign models to roles, pick orchestrator
//     amux-core serve [--port=N]   → start the local core server (what the Go TUI connects to)
//     amux-core --web ["<task>"]   → start the server + open the live web dashboard
//     amux-core auth login|list|logout <provider>
//     amux-core keys set <provider> → store a BYOK key (legacy; `amux-core auth login` is preferred)
//     amux-core login copilot       → sign in with a GitHub Copilot subscription
import { makeProvider } from "./providers/factory.ts";
import { Engine } from "./engine.ts";
import { loadAgents, loadMcpServers, loadPermissions, loadLspServers, loadOptions, loadInstructions, saveAgents } from "./config/config.ts";
import { LspRegistry } from "./lsp/registry.ts";
import { McpManager } from "./mcp/mcp.ts";
import { setKey } from "./keystore/keystore.ts";
import { startDeviceFlow, pollForToken } from "./providers/copilot.ts";
import { loadSkills, skillsPrompt } from "./skills/skills.ts";
import { loadTasks } from "./session.ts";
import { openDb } from "./store/db.ts";
import { SessionStore } from "./store/session-store.ts";
import { serveMain } from "./server/main.ts";
import { setCredential, removeCredential, listCredentials } from "./auth/auth-store.ts";
import { CATALOG, providerKeys } from "./providers/catalog.ts";
import type { AgentConfig } from "./agent/agent.ts";
import type { AgentEvent } from "./events/bus.ts";

const args = process.argv.slice(2);
function die(msg: string): never {
  console.error(`amux: ${msg}`);
  process.exit(1);
}

// --- credential commands ---------------------------------------------------
if (args[0] === "keys") {
  if (args[1] === "set" && args[2]) {
    const key = prompt(`Enter API key for ${args[2]}:`)?.trim();
    if (!key) die("no key entered");
    setKey(args[2], key!);
    console.log(`Stored ${args[2]} key in the OS keychain.`);
    process.exit(0);
  }
  die("usage: amux-core keys set <provider>");
}

if (args[0] === "login") {
  if (args[1] !== "copilot") die("usage: amux-core login copilot");
  const dc = await startDeviceFlow();
  console.log(`\nOpen ${dc.verification_uri} and enter code: ${dc.user_code}\n\nWaiting for authorization…`);
  const token = await pollForToken(dc.device_code, dc.interval);
  setCredential({ provider: "github-copilot", type: "oauth", access: token });
  console.log("Signed in to GitHub Copilot. Select it in /model (provider: GitHub Copilot).");
  process.exit(0);
}

if (args[0] === "auth") {
  const sub = args[1];
  if (sub === "list") {
    const creds = listCredentials();
    if (!creds.length) console.log("No credentials stored. Run: amux-core auth login");
    else for (const c of creds) console.log(`  ${c.provider.padEnd(20)} ${c.type}`);
    process.exit(0);
  }
  if (sub === "logout" && args[2]) {
    removeCredential(args[2]);
    console.log(`Removed credentials for ${args[2]}.`);
    process.exit(0);
  }
  if (sub === "login") {
    await authLogin(args[2]);
    process.exit(0);
  }
  die("usage: amux-core auth login|list|logout [provider]");
}

// --- server / dashboard ----------------------------------------------------
if (args[0] === "serve") {
  const portArg = args.find((a) => a.startsWith("--port="));
  try {
    const { server } = await serveMain({ port: portArg ? Number(portArg.slice(7)) : undefined, auto: args.includes("--auto"), worktree: args.includes("--worktree") });
    console.error(`amux core server running at ${server.url} — Ctrl-C to stop`);
    process.on("SIGINT", () => {
      server.stop();
      process.exit(0);
    });
  } catch (err) {
    surfaceStartupError(err);
  }
  // Bun.serve keeps the process alive.
}

if (args[0] !== "serve" && args.includes("--web")) {
  const goal = args.filter((a) => a !== "--web").join(" ").trim();
  try {
    // The web dashboard is read-only (no approver in this process), so run headless/auto-approve.
    const { engine, server } = await serveMain({ interactive: false });
    const url = `${server.url}/dashboard?token=${server.token}`;
    console.log(`\namux dashboard: ${url}\n`);
    openBrowser(url);
    if (goal) engine.submit(goal).catch((e) => console.error("run error:", e));
    process.on("SIGINT", () => {
      server.stop();
      process.exit(0);
    });
  } catch (err) {
    surfaceStartupError(err);
  }
}

if (args[0] === "init") {
  await runInit();
  process.exit(0);
}

// --- engine-driven modes (headless one-shot / resume) -----------------------
// No interactive mode here — that's the Go TUI (`./amux`, see tui/). This binary is scripting-only:
// one-shot runs to completion printing plain-text progress, or `resume` to reload prior tasks.
if (args[0] !== "serve" && !args.includes("--web") && args[0] !== "init") {
  const resume = args[0] === "resume";
  const goal = resume ? "" : args.filter((a) => !a.startsWith("--")).join(" ").trim(); // flags aren't part of the task text

  if (!goal && !resume) {
    console.log(
      "amux-core: no task given.\n\n" +
        "  For the interactive session, run the Go TUI:  ./amux  (build with `bun run build:tui`)\n" +
        '  For a scripted one-shot run:                   amux-core "your task"\n' +
        "  Other commands:  init · serve · auth · resume · --web\n",
    );
    process.exit(0);
  }

  let engine: Engine;
  try {
    engine = await buildEngine(false); // headless: auto-approve gated tools, no interactive approver
  } catch (err) {
    surfaceStartupError(err);
    throw err; // unreachable (surfaceStartupError exits)
  }
  if (resume) engine.orch.load(loadTasks());


  // Plain-text progress: one line per non-streaming event, so scripting/CI output stays readable.
  const unsubscribe = engine.bus.subscribe((e: AgentEvent) => {
    if (e.type === "delta") return; // streaming chunks — too noisy for line-oriented output
    const line = e.payload ? `[${e.agentId}] ${e.type}: ${e.payload}` : `[${e.agentId}] ${e.type}`;
    (e.type === "error" ? console.error : console.log)(line);
  });

  if (goal) await engine.submit(goal);
  else if (resume) await engine.resume(); // continue unfinished tasks with their stored conversations
  unsubscribe();

  console.log("\n--- tasks ---");
  for (const t of engine.orch.all) console.log(`${t.id} [${t.status}] ${t.assignedTo ?? "-"}: ${t.description}`);
  process.exit(0);
}

// --- helpers ---------------------------------------------------------------
async function buildEngine(interactive: boolean): Promise<Engine> {
  const configs = loadAgents();
  const options = loadOptions();
  const skillText = skillsPrompt(loadSkills()) + loadInstructions(options.instructions);
  const mcpServers = loadMcpServers();
  let mcp: McpManager | undefined;
  if (mcpServers.length) {
    mcp = new McpManager();
    await mcp.connect(mcpServers, (name, err) => console.error(`amux: MCP server '${name}' unavailable: ${err}`));
  }
  return new Engine({
    configs,
    makeProvider,
    mcp,
    systemSuffix: skillText,
    interactive,
    store: new SessionStore(openDb()),
    permissions: loadPermissions(),
    auto: args.includes("--auto") || options.auto,
    lsp: new LspRegistry(loadLspServers()),
    watch: options.watch,
    maxTurns: options.maxTurns,
    worktree: args.includes("--worktree") || options.worktree,
  });
}

function surfaceStartupError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOENT|agents\.yaml/.test(msg)) die(`no agents configured. Run 'amux-core init' to set up providers and roles.`);
  die(msg);
}

// One provider through the opencode-style flow: pick auth method by category, validate-on-first-use.
async function authLogin(providerArg?: string): Promise<void> {
  const provider = (providerArg || prompt("Provider id (e.g. openai, anthropic, google, github-copilot):")?.trim() || "").trim();
  const entry = CATALOG[provider];
  if (!entry) die(`unknown provider '${provider}'. Try one of: ${providerKeys().slice(0, 16).join(", ")}, …`);
  if (entry!.client === "copilot") {
    const dc = await startDeviceFlow();
    console.log(`\nOpen ${dc.verification_uri} and enter code: ${dc.user_code}\n\nWaiting…`);
    const token = await pollForToken(dc.device_code, dc.interval);
    setCredential({ provider, type: "oauth", access: token });
    console.log(`Signed in to ${entry!.label}.`);
    return;
  }
  if ((entry!.category ?? "byok") === "local" || entry!.keyOptional) {
    const baseURL = (prompt(`Base URL [${entry!.baseURL ?? ""}]:`)?.trim() || entry!.baseURL || "").trim();
    if (baseURL) {
      setCredential({ provider, type: "local", baseURL });
      console.log(`Saved ${entry!.label} (local endpoint ${baseURL}).`);
      return;
    }
  }
  const key = prompt(`API key for ${entry!.label}:`)?.trim();
  if (!key) die("no key entered");
  setCredential({ provider, type: "api", key: key! });
  console.log(`Saved ${entry!.label} key.`);
}

// Minimal terminal onboarding (the rich version lives in the Go TUI). Add credentials → assign
// models to custom roles → pick the orchestrator → write .amux/agents.yaml.
async function runInit(): Promise<void> {
  console.log("amux setup — add providers, assign models to roles, pick an orchestrator.\n");
  for (;;) {
    await authLogin();
    if ((prompt("Add another provider? (y/N):")?.trim().toLowerCase() ?? "") !== "y") break;
  }

  const roles: AgentConfig[] = [];
  const usedIds = new Set<string>();
  console.log("\nNow assign models to roles.");
  for (;;) {
    const modelId = prompt("  Model (provider/model, e.g. anthropic/claude-opus-4-8):")?.trim();
    if (!modelId || !modelId.includes("/")) {
      console.log("  need provider/model, e.g. openai/gpt-4o");
      continue;
    }
    const slash = modelId.indexOf("/");
    const provider = modelId.slice(0, slash);
    const model = modelId.slice(slash + 1);
    if (!CATALOG[provider]) {
      console.log(`  unknown provider '${provider}'.`);
      continue;
    }
    const role = prompt("  Role name (e.g. Frontend Designer):")?.trim() || "Engineer";
    let id = role.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || `agent${roles.length + 1}`;
    while (usedIds.has(id)) id += "-2";
    usedIds.add(id);
    const toolsRaw = prompt("  Allowed tools [read_file,write_file,edit,shell]:")?.trim();
    const allowedTools = (toolsRaw || "read_file,write_file,edit,shell").split(",").map((s) => s.trim()).filter(Boolean);
    roles.push({ id, provider, model, role, systemPrompt: `You are the ${role}. Implement your assigned tasks directly and keep responses concise.`, allowedTools });
    console.log(`  ✓ ${role} → ${provider}/${model}`);
    if ((prompt("Assign another model to a role? (y = another / Enter = start):")?.trim().toLowerCase() ?? "") !== "y") break;
  }
  if (!roles.length) die("no roles assigned");

  console.log("\nRoles: " + roles.map((r, i) => `${i + 1}. ${r.role} (${r.id})`).join("   "));
  const pick = prompt("Which model looks over everything and decides the chronology (the orchestrator)? [1]:")?.trim();
  const idx = Math.max(0, Math.min(roles.length - 1, (Number(pick) || 1) - 1));
  roles.forEach((r, i) => (r.lead = i === idx));

  saveAgents(roles);
  console.log(`\nSaved ${roles.length} agents to .amux/agents.yaml. Start with:  amux`);
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* headless — the URL is printed above */
  }
}
