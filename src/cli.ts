#!/usr/bin/env bun
// amux — run multiple AI agents on one project.
//   amux                     → interactive session (type tasks, watch, repeat; /model, /graph)
//   amux "<task>"            → run one task and exit
//   amux resume              → reopen the last session's tasks
//   amux keys set <provider> → store a BYOK key in the OS keychain
//   amux login copilot       → sign in with a GitHub Copilot subscription
import { Agent } from "./agent/agent.ts";
import { makeProvider } from "./providers/factory.ts";
import { Bus } from "./events/bus.ts";
import { Orchestrator } from "./orchestrator/orchestrator.ts";
import { LockRegistry } from "./orchestrator/locks.ts";
import { runProject } from "./orchestrator/runner.ts";
import { loadAgents, loadMcpServers } from "./config/config.ts";
import { McpManager } from "./mcp/mcp.ts";
import { setKey } from "./keystore/keystore.ts";
import { startDeviceFlow, pollForToken } from "./providers/copilot.ts";
import { ApprovalQueue } from "./approval.ts";
import { UsageTracker } from "./usage.ts";
import { loadSkills, skillsPrompt } from "./skills/skills.ts";
import { saveTasks, loadTasks } from "./session.ts";
import { renderTui } from "./tui/App.tsx";

const args = process.argv.slice(2);

if (args[0] === "keys") {
  if (args[1] === "set" && args[2]) {
    const provider = args[2];
    const key = prompt(`Enter API key for ${provider}:`)?.trim();
    if (!key) {
      console.error("no key entered");
      process.exit(1);
    }
    setKey(provider, key);
    console.log(`Stored ${provider} key in the OS keychain.`);
    process.exit(0);
  }
  console.error("usage: amux keys set <provider>");
  process.exit(1);
}

if (args[0] === "login") {
  if (args[1] !== "copilot") {
    console.error("usage: amux login copilot");
    process.exit(1);
  }
  const dc = await startDeviceFlow();
  console.log(`\nOpen ${dc.verification_uri} and enter code: ${dc.user_code}\n\nWaiting for authorization…`);
  const token = await pollForToken(dc.device_code, dc.interval);
  setKey("github-copilot", token);
  console.log("Signed in to GitHub Copilot. Select it in /model (provider: GitHub Copilot).");
  process.exit(0);
}

const bus = new Bus();
const orch = new Orchestrator();
const approvals = new ApprovalQueue();
const usage = new UsageTracker();
const locks = new LockRegistry(bus);
const resume = args[0] === "resume";
const goal = resume ? "" : args.join(" ").trim();

if (resume) orch.load(loadTasks()); // reload prior tasks

// Config load + provider setup can fail on purpose (bad .amux/agents.yaml, missing API key).
// Surface those as a clean one-line message, not an uncaught stack trace.
// Interactive mode gates shell/write_file behind the approval prompt; one-shot auto-runs (scripting).
const skillText = skillsPrompt(loadSkills()); // surface skills to every agent's system prompt

// Connect MCP servers (a failing server is skipped, never fatal).
const mcpServers = loadMcpServers();
let mcp: McpManager | undefined;
if (mcpServers.length) {
  mcp = new McpManager();
  await mcp.connect(mcpServers, (name, err) => console.error(`amux: MCP server '${name}' unavailable: ${err}`));
}

let agents: Agent[];
try {
  agents = loadAgents().map(
    (c) =>
      new Agent({ ...c, systemPrompt: c.systemPrompt + skillText }, makeProvider(c), bus, {
        root: process.cwd(),
        approve: goal ? undefined : (tool, input, forceAsk) => approvals.request(c.id, tool, input, forceAsk),
        mcp,
        usageTracker: usage,
        locks,
      }),
  );
} catch (err) {
  console.error(`amux: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
const configs = agents.map((a) => a.config);
for (const c of configs) for (const tool of c.autoApprove ?? []) approvals.grant(c.id, tool); // agents.yaml pre-approval rules

if (goal) {
  // One-shot: run the task, print a summary, exit.
  const app = renderTui(bus, orch, configs, undefined, undefined, undefined, usage, locks);
  await runProject(goal, agents, orch, bus);
  saveTasks(orch.all);
  await new Promise((r) => setTimeout(r, 300)); // let the poll timer paint final task states
  app.unmount();
  console.log("\n--- tasks ---");
  for (const t of orch.all) {
    console.log(`${t.id} [${t.status}] ${t.assignedTo ?? "-"}: ${t.description}`);
  }
} else if (!process.stdin.isTTY) {
  // Interactive input needs a terminal (raw mode). In a pipe/CI, guide instead of crashing.
  console.error('amux: interactive mode needs a terminal. Pass a task instead:  amux "your task"');
  process.exit(1);
} else {
  // Interactive: type a task, watch it run, type another. `/model` switches models. Ctrl-C exits.
  const pickModel = (agentId: string, provider: string, model: string, baseURL?: string): string | undefined => {
    const agent = agents.find((a) => a.config.id === agentId);
    if (!agent) return `no such agent: ${agentId}`;
    try {
      const p = makeProvider({ ...agent.config, provider, model, baseURL }); // throws on missing key/login → shown in selector
      agent.reconfigure(provider, model, p, baseURL);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  const onSubmit = async (text: string) => {
    await runProject(text, agents, orch, bus);
    saveTasks(orch.all); // persist after each run so `amux resume` can pick up
  };
  const app = renderTui(bus, orch, configs, onSubmit, pickModel, approvals, usage, locks);
  await app.waitUntilExit();
}
