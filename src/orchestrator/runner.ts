import type { Agent } from "../agent/agent.ts";
import type { Bus } from "../events/bus.ts";
import type { Orchestrator } from "./orchestrator.ts";
import type { MessageBus } from "../messaging/message-bus.ts";
import type { Turn } from "../providers/provider.ts";
import type { TaskNode } from "./task.ts";
import type { OrchestrationEvent } from "./scheduler.ts";
import { makePlan, type Exchange, type RoleInfo } from "./planner.ts";
import { schedule, planEvent } from "./scheduler.ts";


export interface RunnerDeps {
  messageBus?: MessageBus; // wire hand-off/agent-to-agent messages into the event stream
  onOrchestration?: (e: OrchestrationEvent) => void; // DAG lifecycle events for the TUI/dashboard
  shouldStop?: () => boolean; // graceful cancel signal, forwarded to the scheduler
  priorTurns?: (taskId: string) => Turn[]; // resume: stored conversation to seed each task with
  planOnly?: boolean; // build and publish the DAG, then stop — nothing is executed
  history?: Exchange[]; // recent exchanges, so a follow-up message can refer back to them
}

// What a message turned into: a direct reply, an answered question, or a run of tasks. The engine
// keeps it as conversation memory; `text` is the reply/answer (work summaries arrive via events).
export type RunResult = { kind: "reply" | "answer" | "work"; text?: string };

// The DAG a PLAN-mode run left on the board for this exact goal, if it is still untouched —
// meaning BUILD should execute it rather than pay for a second planning call. Anything else
// (a different goal, an empty board, a task that has already run, a board that didn't come from
// the planner) returns undefined and the caller plans normally. One-shot: consuming it means a
// later re-submit of the same text plans afresh, which is what someone re-sending a finished run
// expects.
export function takeApprovedPlan(orch: Orchestrator, goal: string): TaskNode[] | undefined {
  if (orch.plannedGoal !== goal) return undefined;
  const board = orch.all;
  if (!board.length) return undefined;
  if (!board.every((t) => t.status === "pending" && t.role && Array.isArray(t.dependsOn))) return undefined;
  orch.plannedGoal = undefined;
  return orch.nodes(); // the live array — see Orchestrator.nodes()
}

// The orchestrator: the agent marked lead, else the first on the roster.
function leadOf(agents: Agent[]): Agent {
  const lead = agents.find((a) => a.config.lead) ?? agents[0];
  if (!lead) throw new Error("no agents configured");
  return lead;
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
): Promise<RunResult> {
  const lead = leadOf(agents);
  // Each local model's one-time check, before the plan: it says which teammates can build. One at a
  // time — two models that don't fit together take turns anyway.
  for (const a of agents) await a.checkModel().catch(() => {});
  // A teammate on a local model its check found can't call tools is "chat only": it gets answers and
  // reviews, never a task that changes files.
  const roles: RoleInfo[] = agents.map((a) => ({ id: a.config.id, role: a.config.role, description: a.config.systemPrompt.slice(0, 140), ...(a.localProbe()?.verdict === "chat-only" ? { ready: false } : {}) }));
  // The plan is made by the lead — unless it's a local model that couldn't split work in its check,
  // and a teammate could.
  const canPlan = (a: Agent) => a.localProbe()?.planMode !== "none";
  const planner = canPlan(lead) ? lead : (agents.find((a) => a !== lead && canPlan(a) && a.localProbe()?.verdict !== "chat-only") ?? lead);

  // BUILD on a plan the user just read in PLAN mode: run that DAG. Planning again would bill a
  // second orchestrator call and could hand back a different plan than the one they approved.
  let tasks = deps.planOnly ? undefined : takeApprovedPlan(orch, prompt);
  if (tasks) {
    bus.publish({ agentId: lead.config.id, type: "thought", payload: `running the plan you reviewed (${tasks.length} tasks) — no second planning call`, time: Date.now() });
  } else {
    bus.publish({ agentId: lead.config.id, type: "thought", payload: `thinking about: ${prompt}`, time: Date.now() });
    const unfinished = orch.all.filter((t) => t.status !== "done").map((t) => `${t.id} (${t.assignedTo ?? "?"}, ${t.status}): ${t.description}`);
    if (planner !== lead) bus.publish({ agentId: planner.config.id, type: "thought", payload: `planning for ${lead.config.id} (its model couldn't split work in its check)`, time: Date.now() });
    const plan = await makePlan(planner, prompt, roles, deps.history, unfinished);
    // Not work: say it and stop. "hi" used to be forced into 2-6 invented tasks here.
    if (plan.reply !== undefined) {
      bus.publish({ agentId: lead.config.id, type: "message", payload: plan.reply, time: Date.now() });
      return { kind: "reply", text: plan.reply };
    }
    if (plan.question !== undefined) {
      const answer = await lead.answer(plan.question);
      bus.publish({ agentId: lead.config.id, type: "message", payload: answer, time: Date.now() });
      return { kind: "answer", text: answer };
    }
    if (plan.fallback) {
      bus.publish({ agentId: lead.config.id, type: "warning", protocol: "plan_fallback", payload: `plan fell back (${plan.fallback}) — ${plan.tasks.length > 1 ? `split by role into ${plan.tasks.length} tasks` : `one task on ${plan.tasks[0]?.assignedTo ?? lead.config.id}`}`, time: Date.now() });
    }
    orch.load(plan.tasks); // shares the Task objects — scheduler mutates them, orch/UI/resume see updates
    for (const t of plan.tasks) {
      bus.publish({ agentId: lead.config.id, type: "thought", payload: `queued ${t.id} → ${t.assignedTo}: ${t.description}`, time: Date.now() });
    }
    tasks = plan.tasks;

    // PLAN mode: publish the same "plan" event the scheduler would have, then stop. The board is
    // tagged with this goal, so sending it again in BUILD mode (or /resume) executes exactly this
    // DAG — no re-planning, no second bill.
    if (deps.planOnly) {
      orch.plannedGoal = prompt;
      deps.onOrchestration?.(planEvent(prompt, tasks));
      bus.publish({ agentId: lead.config.id, type: "thought", payload: `plan ready (${tasks.length} tasks) — switch to BUILD and send the same goal to run it (or /resume)`, time: Date.now() });
      return { kind: "work" };
    }
  }

  try {
    await schedule(tasks, agents, { bus, messageBus: deps.messageBus, onOrchestration: deps.onOrchestration, shouldStop: deps.shouldStop, priorTurns: deps.priorTurns, lead, goal: prompt });
  } catch (err) {
    // e.g. a dependency cycle — surface it, don't crash the session.
    bus.publish({ agentId: lead.config.id, type: "error", payload: `scheduling failed: ${err instanceof Error ? err.message : err}`, time: Date.now() });
  }
  return { kind: "work" };
}

// Resume: re-schedule the tasks a previous run left unfinished, with no planning pass (the DAG
// already exists) and each agent seeded with that task's stored conversation via deps.priorTurns.
// Mutates the loaded Task objects in place so the orchestrator/UI keep seeing live status.
export async function resumeProject(agents: Agent[], orch: Orchestrator, bus: Bus, deps: RunnerDeps = {}): Promise<void> {
  const lead = leadOf(agents);
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
