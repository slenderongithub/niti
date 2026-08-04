import type { Agent } from "../agent/agent.ts";
import type { Bus } from "../events/bus.ts";
import type { Orchestrator } from "./orchestrator.ts";
import type { MessageBus } from "../messaging/message-bus.ts";
import type { Turn } from "../providers/provider.ts";
import type { TaskNode } from "./task.ts";
import type { OrchestrationEvent } from "./scheduler.ts";
import { makePlan, type RoleInfo } from "./planner.ts";
import { schedule } from "./scheduler.ts";


const MAX_ATTEMPTS = 3; // failover retries before a task is marked failed

// Flat-queue worker loop: claim → execute → complete, until all work is finished. Runs concurrently.

export interface RunnerDeps {
  messageBus?: MessageBus; // wire hand-off/agent-to-agent messages into the event stream
  onOrchestration?: (e: OrchestrationEvent) => void; // DAG lifecycle events for the TUI/dashboard
  shouldStop?: () => boolean; // graceful cancel signal, forwarded to the scheduler
  priorTurns?: (taskId: string) => Turn[]; // resume: stored conversation to seed each task with
  planOnly?: boolean; // build and publish the DAG, then stop — nothing is executed
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

  // PLAN mode: publish the same "plan" event the scheduler would have, then stop. The tasks stay
  // loaded in the orchestrator, so switching to BUILD and re-submitting picks up from a known DAG.
  if (deps.planOnly) {
    deps.onOrchestration?.({
      type: "plan",
      goal: prompt,
      tasks: plan.tasks.map((t) => ({ id: t.id, description: t.description, role: t.role, dependsOn: t.dependsOn })),
      time: Date.now(),
    });
    bus.publish({ agentId: lead.config.id, type: "thought", payload: `plan ready (${plan.tasks.length} tasks) — switch to BUILD to run it`, time: Date.now() });
    return;
  }

  try {
    await schedule(plan.tasks, agents, { bus, messageBus: deps.messageBus, onOrchestration: deps.onOrchestration, shouldStop: deps.shouldStop, priorTurns: deps.priorTurns, lead, goal: prompt });
  } catch (err) {
    // e.g. a dependency cycle — surface it, don't crash the session.
    bus.publish({ agentId: lead.config.id, type: "error", payload: `scheduling failed: ${err instanceof Error ? err.message : err}`, time: Date.now() });
  }
}

// Resume: re-schedule the tasks a previous run left unfinished, with no planning pass (the DAG
// already exists) and each agent seeded with that task's stored conversation via deps.priorTurns.
// Mutates the loaded Task objects in place so the orchestrator/UI keep seeing live status.
export async function resumeProject(agents: Agent[], orch: Orchestrator, bus: Bus, deps: RunnerDeps = {}): Promise<void> {
  const lead = agents.find((a) => a.config.lead) ?? agents[0];
  if (!lead) throw new Error("no agents configured");
  const unfinished = orch.all.filter((t) => t.status !== "done");
  if (!unfinished.length) {
    bus.publish({ agentId: lead.config.id, type: "thought", payload: "nothing to resume — all tasks are done", time: Date.now() });
    return;
  }

  const nodes: TaskNode[] = unfinished.map((t) => {
    t.status = "pending"; // in_progress/failed from the interrupted run → runnable again
    const node = t as TaskNode;
    if (!node.role) node.role = t.assignedTo ?? lead.config.id;
    if (!node.dependsOn) node.dependsOn = [];
    return node;
  });
  bus.publish({ agentId: lead.config.id, type: "thought", payload: `resuming ${nodes.length} unfinished task(s)`, time: Date.now() });

  try {
    await schedule(nodes, agents, { bus, messageBus: deps.messageBus, onOrchestration: deps.onOrchestration, shouldStop: deps.shouldStop, priorTurns: deps.priorTurns, lead, goal: "(resumed session)" });
  } catch (err) {
    bus.publish({ agentId: lead.config.id, type: "error", payload: `resume failed: ${err instanceof Error ? err.message : err}`, time: Date.now() });
  }
}

// Exposed for testing the flat concurrency/claim path without a planning call.
