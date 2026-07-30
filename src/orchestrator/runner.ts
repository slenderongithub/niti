import type { Agent } from "../agent/agent.ts";
import type { Bus } from "../events/bus.ts";
import type { Orchestrator } from "./orchestrator.ts";
import type { MessageBus } from "../messaging/message-bus.ts";
import type { OrchestrationEvent } from "./scheduler.ts";
import { makePlan, type RoleInfo } from "./planner.ts";
import { schedule } from "./scheduler.ts";

// Extract the first JSON array of strings from a model response. Tolerant of prose around the JSON.
// (Kept for the legacy flat path / tests; the DAG planner lives in planner.ts.)
export function parseTaskList(raw: string): string[] {
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const v = JSON.parse(m[0]);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const MAX_ATTEMPTS = 3; // failover retries before a task is marked failed

// Flat-queue worker loop: claim → execute → complete, until all work is finished. Runs concurrently.
// Retained for the failover regression tests and any flat single-queue use; the DAG scheduler
// (scheduler.ts) is the primary path driven by runProject below.
async function worker(agent: Agent, orch: Orchestrator, bus: Bus): Promise<void> {
  const id = agent.config.id;
  for (;;) {
    const task = orch.claimTask(id);
    if (!task) {
      if (!orch.hasUnfinished()) return;
      await new Promise((r) => setTimeout(r, 30)); // ponytail: naive poll wait, fine for a handful of agents
      continue;
    }
    bus.publish({ agentId: id, type: "thought", payload: `claimed ${task.id}: ${task.description}`, time: Date.now() });
    const outcome = await agent.run(task.description);
    if (outcome === "exhausted" && (task.attempts ?? 0) < MAX_ATTEMPTS) {
      orch.requeue(task, id);
      bus.publish({ agentId: id, type: "failover", payload: `${id} exhausted — ${task.id} reassigned`, time: Date.now() });
    } else {
      orch.complete(task, outcome === "done");
    }
  }
}

export interface RunnerDeps {
  messageBus?: MessageBus; // wire hand-off/agent-to-agent messages into the event stream
  onOrchestration?: (e: OrchestrationEvent) => void; // DAG lifecycle events for the TUI/dashboard
  shouldStop?: () => boolean; // graceful cancel signal, forwarded to the scheduler
}

// Primary core loop: the orchestrator plans a DAG → tasks are scheduled in dependency order,
// independent tasks run concurrently, outputs flow to dependents/hand-offs, then the orchestrator
// integrates the results. A failed planner degrades gracefully to a single whole-goal task.
export async function runProject(
  prompt: string,
  agents: Agent[],
  orch: Orchestrator,
  bus: Bus,
  deps: RunnerDeps = {},
): Promise<void> {
  const lead = agents.find((a) => a.config.lead) ?? agents[0];
  if (!lead) throw new Error("no agents configured");

  bus.publish({ agentId: lead.config.id, type: "thought", payload: `planning: ${prompt}`, time: Date.now() });
  const roles: RoleInfo[] = agents.map((a) => ({ id: a.config.id, role: a.config.role, description: a.config.systemPrompt.slice(0, 140) }));
  const plan = await makePlan(lead, prompt, roles);

  orch.load(plan.tasks); // shares the Task objects — scheduler mutates them, orch/UI/resume see updates
  for (const t of plan.tasks) {
    bus.publish({ agentId: lead.config.id, type: "thought", payload: `queued ${t.id} → ${t.assignedTo}: ${t.description}`, time: Date.now() });
  }

  try {
    await schedule(plan.tasks, agents, { bus, messageBus: deps.messageBus, onOrchestration: deps.onOrchestration, shouldStop: deps.shouldStop, lead, goal: prompt });
  } catch (err) {
    // e.g. a dependency cycle — surface it, don't crash the session.
    bus.publish({ agentId: lead.config.id, type: "error", payload: `scheduling failed: ${err instanceof Error ? err.message : err}`, time: Date.now() });
  }
}

// Exposed for testing the flat concurrency/claim path without a planning call.
export { worker as runWorker };
