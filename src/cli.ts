#!/usr/bin/env bun
// niti-core — the headless engine + scripting CLI. The usage text below is USAGE, printed by
// --help; keep them as one thing so the comment and the help output can't drift apart.
import pkg from "../package.json";
import { makeProvider } from "./providers/factory.ts";
import { Engine } from "./engine.ts";
import { loadAgents, loadMcpServers, loadPermissions, loadLspServers, loadOptions, loadInstructions, saveAgents, findProjectRoot } from "./config/config.ts";
import { LspRegistry } from "./lsp/registry.ts";
import { McpManager } from "./mcp/mcp.ts";
import { setKey } from "./keystore/keystore.ts";
import { startDeviceFlow, pollForToken } from "./providers/copilot.ts";
import { loadSkills, skillsPrompt } from "./skills/skills.ts";
import { loadTasks } from "./session.ts";
import { openDb } from "./store/db.ts";
import { SessionStore } from "./store/session-store.ts";
import { AuditLog } from "./store/audit-log.ts";
import { checkTrust, grantTrust } from "./trust/trust-store.ts";
import { serveMain } from "./server/main.ts";
import { setCredential, removeCredential, listCredentials } from "./auth/auth-store.ts";
import { CATALOG, providerKeys } from "./providers/catalog.ts";
import type { AgentConfig } from "./agent/agent.ts";
import type { AgentEvent } from "./events/bus.ts";

const args = process.argv.slice(2);
function die(msg: string): never {
  console.error(`niti: ${msg}`);
  process.exit(1);
}

const USAGE = `niti-core — the headless engine + scripting CLI.

  For the interactive session, run the Go TUI: niti
  This binary is for scripting, automation, and what the Go TUI spawns as its subprocess:

    niti-core "<task>"            run one task headlessly and exit (plain-text progress)
    niti-core resume              continue the last session's unfinished tasks (with their history)
    niti-core init                setup wizard: add providers, assign models to roles
    niti-core serve [--port=N]    start the local core server (what the Go TUI connects to)
    niti-core --web ["<task>"]    start the server + open the live web dashboard
    niti-core auth login|list|logout <provider>
    niti-core keys set <provider> store a BYOK key (legacy; 'auth login' is preferred)
    niti-core login copilot       sign in with a GitHub Copilot subscription
    niti-core audit verify        check the tamper-evident tool-call/approval log's hash chain
    niti-core trust check|grant   query or approve this directory (do you trust the files here?)

  Flags:
    --auto                        approve anything not explicitly denied in agents.yaml
    --worktree                    isolate this run's writes in a fresh git worktree (manual merge)
    --port=N                      port for serve/--web (default: an ephemeral one)
    --show-url                    --web: print the dashboard URL with its real token (default: masked)
    --trust                       treat this run as trusted without persisting (for automation);
                                   same as env var NITI_TRUST=1
    --help, -h · --version, -v

  Exit codes (headless runs): 0 all tasks done · 1 a task failed · 2 unfinished (turn cap/pending).`;

// Bundled at compile time (same trick as the theme palettes), so the compiled binary carries the
// version without a package.json beside it and there is still exactly one place to bump.
const VERSION = pkg.version;

if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
if (args.includes("--version") || args.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

// A typo must never become a billed model run. Every flag is checked against this list, and a
// bare one-word first argument that looks like a subcommand is rejected rather than submitted as
// a prompt — `niti-core stauts` used to reach the orchestrator and cost real money.
const KNOWN_FLAGS = new Set(["--auto", "--worktree", "--web", "--show-url", "--trust", "--help", "-h", "--version", "-v"]);
const SUBCOMMANDS = new Set(["keys", "login", "auth", "serve", "init", "resume", "help", "audit", "trust"]);
// Subcommands that never read/execute anything from the project directory — the trust gate below
// (ensureTrusted) is skipped for these, and for "trust" itself (it IS the trust UI).
const TRUST_EXEMPT = new Set(["keys", "login", "auth", "trust", "help"]);
for (const a of args) {
  if (a.startsWith("-") && !KNOWN_FLAGS.has(a) && !a.startsWith("--port=")) {
    die(`unknown flag '${a}'\n\n${USAGE}`);
  }
}
if (args.length === 1 && /^[a-z][a-z0-9-]*$/.test(args[0]!) && !SUBCOMMANDS.has(args[0]!)) {
  die(`unknown command '${args[0]}' — if you meant it as a task, quote it: niti-core "${args[0]}"`);
}

// Before any loader runs: every artefact (.niti/agents.yaml, the SQLite store, session.json) is
// resolved from cwd, so running from a subdirectory created a stray second project there.
const projectRoot = findProjectRoot();
if (projectRoot !== process.cwd()) process.chdir(projectRoot);

// Claude-Code-style "do you trust this folder?" — the first time niti is about to read this
// directory's config, spawn its MCP servers, or run agents against its code, the human confirms it.
// Runs BEFORE any of that (loadMcpServers/mcp.connect in serveMain, agents.yaml in buildEngine),
// so an untrusted directory's config never executes anything on the strength of just being cloned.
//
// --trust (or its env-var equivalent, NITI_TRUST=1) means "treat this run as already approved"
// without persisting — the Go TUI sets the env var on the child it spawns after its own prompt
// already got a yes, so `niti-core serve` doesn't ask again for the same already-approved run.
// Neither is a blanket "always trust everything" flag — both are scoped to one process's run.
async function ensureTrusted(root: string): Promise<void> {
  if (args.includes("--trust") || process.env.NITI_TRUST === "1") return;
  const servers = loadMcpServers();
  const status = checkTrust(root, servers);
  if (status === "trusted") return;
  if (!process.stdin.isTTY) {
    die(
      `'${root}' is not a trusted directory (${status === "changed" ? "its mcpServers: config changed" : "first time here"}).\n` +
        `Run 'niti-core trust grant' once to approve it, or pass --trust to run without persisting.`,
    );
  }
  const why = status === "changed" ? "Its mcpServers: config has changed since you last trusted it." : "niti hasn't run here before.";
  console.log(
    `\n${why}\nTrusting a directory lets niti read its .niti/agents.yaml, spawn any MCP servers it ` +
      `configures, and run agents against its code.\n\n  ${root}\n`,
  );
  const answer = (prompt("Trust this folder? [1] Yes, proceed  [2] Yes, and remember  [3] No, exit") ?? "3").trim();
  if (answer === "2") {
    grantTrust(root, servers);
    console.log("niti: trusted — this won't ask again unless the MCP config changes.\n");
  } else if (answer !== "1") {
    console.log("niti: not trusted — exiting without touching this directory.");
    process.exit(0);
  }
}
if (!TRUST_EXEMPT.has(args[0] ?? "")) await ensureTrusted(projectRoot);

function parsePort(): number | undefined {
  const arg = args.find((a) => a.startsWith("--port="));
  if (!arg) return undefined;
  const port = Number(arg.slice(7));
  if (!Number.isInteger(port) || port < 0 || port > 65535) die(`invalid --port '${arg.slice(7)}'`);
  return port;
}

// --- credential commands ---------------------------------------------------
if (args[0] === "keys") {
  if (args[1] === "set" && args[2]) {
    // A typo here stores a key under a provider id nothing ever looks up — silently, and the user
    // then debugs "why is my key not being used".
    if (!Object.hasOwn(CATALOG, args[2])) {
      die(`unknown provider '${args[2]}'. Try one of: ${providerKeys().slice(0, 16).join(", ")}, …`);
    }
    const key = await promptSecret(`Enter API key for ${args[2]}:`);
    if (!key) die("no key entered");
    setKey(args[2], key!);
    console.log(`Stored ${args[2]} key in the OS keychain.`);
    process.exit(0);
  }
  die("usage: niti-core keys set <provider>");
}

if (args[0] === "login") {
  if (args[1] !== "copilot") die("usage: niti-core login copilot");
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
    if (!creds.length) console.log("No credentials stored. Run: niti-core auth login");
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
  die("usage: niti-core auth login|list|logout [provider]");
}

if (args[0] === "audit") {
  if (args[1] === "verify") {
    const result = new AuditLog(openDb()).verify();
    if (result === true) {
      console.log("niti: audit log ok — chain intact.");
      process.exit(0);
    }
    console.error(`niti: audit log broken at row ${result.brokenAt} — the chain no longer matches from there forward.`);
    process.exit(1);
  }
  die("usage: niti-core audit verify");
}

if (args[0] === "trust") {
  // No server spawn, no engine — this only needs the root + the mcpServers: config to hash.
  if (args[1] === "check") {
    const servers = loadMcpServers();
    const status = checkTrust(projectRoot, servers);
    console.log(JSON.stringify({ trusted: status === "trusted", root: projectRoot, changed: status === "changed" }));
    process.exit(status === "trusted" ? 0 : 1);
  }
  if (args[1] === "grant") {
    grantTrust(projectRoot, loadMcpServers());
    console.log(`niti: trusted ${projectRoot}`);
    process.exit(0);
  }
  die("usage: niti-core trust check|grant");
}

// --- server / dashboard ----------------------------------------------------
if (args[0] === "serve") {
  try {
    const { engine, server } = await serveMain({ port: parsePort(), auto: args.includes("--auto"), worktree: args.includes("--worktree") });
    console.error(`niti core server running at ${server.url} — Ctrl-C to stop`);
    onShutdown(engine, server);
  } catch (err) {
    surfaceStartupError(err);
  }
  // Bun.serve keeps the process alive.
}

if (args[0] !== "serve" && args.includes("--web")) {
  const goal = args.filter((a) => !a.startsWith("-")).join(" ").trim();
  try {
    // The dashboard implements the full approval flow against POST /approval (web/app.js), and the
    // queue is the same FIFO the TUI answers — so this process gets a real approver. It used to
    // pass interactive:false, which silently ran every write and shell unattended.
    const { engine, server } = await serveMain({
      port: parsePort(),
      interactive: true,
      auto: args.includes("--auto"),
      worktree: args.includes("--worktree"),
    });
    const url = `${server.url}/dashboard?token=${server.token}`;
    // openBrowser navigates with the real token programmatically — the human doesn't need to read
    // or copy it, so don't put a live bearer token in scrollback/CI logs/screen-shares by default.
    const shown = args.includes("--show-url") ? url : url.replace(/token=[^&]+/, "token=***");
    console.log(`\nniti dashboard: ${shown}\n`);
    if (args.includes("--auto")) console.error("niti: --auto is on — writes and shell run without asking.");
    openBrowser(url);
    if (goal) engine.submit(goal).catch((e) => console.error(`niti: ${e instanceof Error ? e.message : e}`));
    onShutdown(engine, server);
  } catch (err) {
    surfaceStartupError(err);
  }
}

if (args[0] === "init") {
  await runInit();
  process.exit(0);
}

// --- engine-driven modes (headless one-shot / resume) -----------------------
// No interactive mode here — that's the Go TUI (`./niti`, see tui/). This binary is scripting-only:
// one-shot runs to completion printing plain-text progress, or `resume` to reload prior tasks.
if (args[0] !== "serve" && !args.includes("--web") && args[0] !== "init") {
  const resume = args[0] === "resume";
  const goal = resume ? "" : args.filter((a) => !a.startsWith("--")).join(" ").trim(); // flags aren't part of the task text

  if (!goal && !resume) {
    console.log(
      "niti-core: no task given.\n\n" +
        "  For the interactive session, run the Go TUI:  ./niti  (build with `bun run build:tui`)\n" +
        '  For a scripted one-shot run:                   niti-core "your task"\n' +
        "  Other commands:  init · serve · auth · resume · --web\n",
    );
    process.exit(0);
  }

  let engine: Engine;
  try {
    // Not interactive (there's no TTY to prompt on), but not a blanket auto-approve either: the
    // engine denies anything resolving to `ask` unless --auto was typed. See engine.ts.
    engine = await buildEngine(false);
  } catch (err) {
    surfaceStartupError(err);
    throw err; // unreachable (surfaceStartupError exits)
  }
  if (resume) engine.orch.load(loadTasks());
  onShutdown(engine);

  // Plain-text progress: one line per non-streaming event, so scripting/CI output stays readable.
  const unsubscribe = engine.bus.subscribe((e: AgentEvent) => {
    if (e.type === "delta") return; // streaming chunks — too noisy for line-oriented output
    const line = e.payload ? `[${e.agentId}] ${e.type}: ${e.payload}` : `[${e.agentId}] ${e.type}`;
    (e.type === "error" ? console.error : console.log)(line);
  });

  // A provider failure during *planning* throws straight out of submit() — before any task exists
  // — and used to surface as an unhandled rejection with a full stack trace, which is not how any
  // other error in this file is reported.
  let runFailed = false;
  try {
    if (goal) await engine.submit(goal);
    else if (resume) await engine.resume(); // continue unfinished tasks with their stored conversations
  } catch (err) {
    runFailed = true;
    console.error(`niti: ${err instanceof Error ? err.message : err}`);
  }
  unsubscribe();

  console.log("\n--- tasks ---");
  for (const t of engine.orch.all) console.log(`${t.id} [${t.status}] ${t.assignedTo ?? "-"}: ${t.description}`);
  // Scripts need a machine-readable verdict — `niti-core "fix the test" && ./deploy.sh` used to
  // deploy after every task failed. 1 = something failed, 2 = ran out of turns / still pending.
  engine.close();
  void engine.mcp?.close?.();
  const failed = engine.orch.all.filter((t) => t.status === "failed").length;
  const unfinished = engine.orch.all.filter((t) => t.status !== "done").length;
  process.exit(runFailed || failed ? 1 : unfinished ? 2 : 0);
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
    await mcp.connect(mcpServers, (name, err) => console.error(`niti: MCP server '${name}' unavailable: ${err}`));
  }
  const db = openDb();
  return new Engine({
    configs,
    makeProvider,
    mcp,
    systemSuffix: skillText,
    interactive,
    store: new SessionStore(db),
    audit: new AuditLog(db),
    permissions: loadPermissions(),
    auto: args.includes("--auto") || options.auto,
    lsp: new LspRegistry(loadLspServers()),
    watch: options.watch,
    maxTurns: options.maxTurns,
    verify: options.verify,
    worktree: args.includes("--worktree") || options.worktree,
  });
}

// Bun's prompt() echoes. For a credential that means the key sits in the terminal in cleartext and
// then in the shell's scrollback — and in whatever terminal recording or shared session happened to
// be running. Read it with echo off when we own a TTY; fall back to the plain prompt (with a
// warning) when stdin is a pipe, where masking is neither possible nor meaningful.
async function promptSecret(label: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    console.error("niti: stdin is not a terminal — the value you type will be visible.");
    return prompt(label)?.trim() ?? "";
  }
  process.stdout.write(`${label} `);
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  try {
    for await (const chunk of stdin) {
      const text = String(chunk);
      if (text.includes("\u0003")) {
        // ctrl+c inside raw mode never reaches the default handler.
        process.stdout.write("\n");
        process.exit(130);
      }
      const end = text.search(/[\r\n]/);
      value += end === -1 ? text : text.slice(0, end);
      // Backspace/delete, so a typo is fixable rather than fatal.
      while (/[\u0008\u007f]/.test(value)) value = value.replace(/.?[\u0008\u007f]/, "");
      if (end !== -1) break;
    }
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
  process.stdout.write("\n");
  return value.trim();
}

function surfaceStartupError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  // ENOENT only. Matching /agents\.yaml/ swallowed every *validation* error too — a one-character
  // typo in the config was reported as "no agents configured. Run init", and following that advice
  // overwrote the roster the user was trying to fix.
  if (/ENOENT/.test(msg)) die(`no agents configured. Run 'niti-core init' to set up providers and roles.`);
  die(msg);
}

// One shutdown path for every long-lived mode. Engine.close() and McpManager.close() existed but
// were never called anywhere, so Ctrl-C orphaned every LSP and MCP child process.
function onShutdown(engine?: Engine, server?: { stop: () => void }): void {
  let closing = false;
  const shutdown = () => {
    if (closing) process.exit(130); // second Ctrl-C: stop waiting, just go
    closing = true;
    try {
      server?.stop();
      engine?.close();
      void engine?.mcp?.close?.();
    } finally {
      process.exit(130); // 128 + SIGINT, the shell convention
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
  const key = await promptSecret(`API key for ${entry!.label}:`);
  if (!key) die("no key entered");
  setCredential({ provider, type: "api", key: key! });
  console.log(`Saved ${entry!.label} key.`);
}

// Minimal terminal onboarding (the rich version lives in the Go TUI). Add credentials → assign
// models to custom roles → pick the orchestrator → write .niti/agents.yaml.
async function runInit(): Promise<void> {
  console.log("niti-core init — add providers, assign models to roles, pick an orchestrator.\n");
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
    roles.push({ id, provider, model, role, systemPrompt: `You are the ${role}. Implement your assigned tasks directly and efficiently — you have a limited number of tool calls, so spend them on the task rather than exploring around it. Stay inside the project.`, allowedTools });
    console.log(`  ✓ ${role} → ${provider}/${model}`);
    if ((prompt("Assign another model to a role? (y = another / Enter = start):")?.trim().toLowerCase() ?? "") !== "y") break;
  }
  if (!roles.length) die("no roles assigned");

  console.log("\nRoles: " + roles.map((r, i) => `${i + 1}. ${r.role} (${r.id})`).join("   "));
  const pick = prompt("Which model looks over everything and decides the chronology (the orchestrator)? [1]:")?.trim();
  const idx = Math.max(0, Math.min(roles.length - 1, (Number(pick) || 1) - 1));
  roles.forEach((r, i) => (r.lead = i === idx));

  saveAgents(roles);
  console.log(`\nSaved ${roles.length} agents to .niti/agents.yaml. Start with:  niti`);
}

function openBrowser(url: string): void {
  // `start` is a cmd.exe builtin, not an executable — spawning it directly fails on Windows. It
  // has to be run *through* cmd, and the empty "" is the title argument `start` would otherwise
  // eat the URL as. (tui/internal/session already gets this right; this is the copy that didn't.)
  const argv =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* headless — the URL is printed above */
  }
}
