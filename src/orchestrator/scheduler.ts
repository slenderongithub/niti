import type { Agent } from "../agent/agent.ts";
import type { Bus } from "../events/bus.ts";
import type { TaskNode } from "./task.ts";
import type { MessageBus } from "../messaging/message-bus.ts";
import type { Turn } from "../providers/provider.ts";
import { replan, normalizePlan, type RoleInfo } from "./planner.ts";

// Orchestration lifecycle events — a higher-level stream than per-agent AgentEvents. The server
// forwards these over SSE so the TUI/dashboard can draw DAG progress and a completion percentage.
export type OrchestrationEvent =
  | { type: "plan"; goal: string; tasks: { id: string; description: string; role: string; dependsOn: string[] }[]; time: number }
  | { type: "task_ready"; taskId: string; role: string; time: number }
  | { type: "task_started"; taskId: string; role: string; time: number }
  | { type: "task_done"; taskId: string; role: string; ok: boolean; completed: number; total: number; time: number }
  | { type: "handoff"; taskId: string; from: string; to: string[]; time: number }
  | { type: "replan"; taskId: string; role: string; action: "retry" | "redirect" | "inject" | "accept"; reason?: string; time: number }
  | { type: "review"; taskId: string; reviewer: string; phase: "requested" | "approved" | "changes_requested"; time: number }
  | { type: "integrate"; summary: string; time: number }
  | { type: "complete"; completed: number; total: number; cancelled?: boolean; time: number };

export interface SchedulerDeps {
  bus?: Bus;
  messageBus?: MessageBus;
  onOrchestration?: (e: OrchestrationEvent) => void;
  lead?: Agent; // runs the final integrate/review pass
  goal?: string; // surfaced on the "plan" event for the dashboard
  shouldStop?: () => boolean; // graceful cancel — stop launching new tasks; in-flight ones finish
  priorTurns?: (taskId: string) => Turn[]; // resume: stored conversation to seed a task's first attempt with
}

const DEP_CONTEXT_MAX = 4000; // per-prerequisite ceiling on inherited output (see depContext)
// Retries have to outlast a real rate-limit window, not just a blip. The old 3 attempts at
// 500ms/1s/1.5s spent under 5 seconds before giving up — against a provider quota that resets over
// a minute (a free-tier key shared by two agents, say) that never had a chance, so the task failed,
// its dependents were skipped as prerequisite-failed, and the run collapsed within seconds of the
// first 429. 5 attempts on an exponential curve spends ~60s instead. Safe to wait that long because
// the scheduler runs tasks concurrently (one per idle agent): a stalled lane doesn't block the rest.
const MAX_ATTEMPTS = 5; // same-agent retries (with backoff) before a task is marked failed
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 30_000;
const MAX_REPLAN_ATTEMPTS = 1; // recovery attempts asking the lead to replan a task before giving up on it
const MAX_REVIEW_ROUNDS = 2; // review→revise cycles before a persistently-rejected task is marked failed
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// DFS cycle check. Returns the offending cycle path (ids) if any, else undefined — so the caller
// can reject a plan with a clear, specific error rather than deadlocking the scheduler.
export function detectCycle(tasks: TaskNode[]): string[] | undefined {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 0 | 1 | 2>(); // 0=unseen 1=in-stack 2=done
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    const t = byId.get(id);
    if (!t) return undefined; // unknown dep — treated as satisfied elsewhere, not a cycle
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id]; // back-edge → cycle
    if (state.get(id) === 2) return undefined;
    state.set(id, 1);
    stack.push(id);
    for (const dep of t.dependsOn) {
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 2);
    return undefined;
  };

  for (const t of tasks) {
    const found = visit(t.id);
    if (found) return found;
  }
  return undefined;
}

// Recovery path for a task that exhausted its retries: ask the lead how to proceed, then act on the
// decision. Only "retry"/"redirect" can rescue this task's own dependents (they keep referencing its
// id, reset to "pending" so the ready-queue picks it back up); "inject" adds freestanding remediation
// tasks alongside it — the original task stays failed. Returns true iff the task itself was rescued.
async function attemptReplan(
  t: TaskNode,
  error: string,
  tasks: TaskNode[],
  byId: Map<string, TaskNode>,
  agentsById: Map<string, Agent>,
  deps: SchedulerDeps,
): Promise<boolean> {
  const { lead, goal = "", bus } = deps;
  if (!lead) return false;
  t.replans = (t.replans ?? 0) + 1;
  const roles: RoleInfo[] = [...agentsById.values()].map((a) => ({ id: a.config.id, role: a.config.role }));
  const board = tasks.map((x) => `${x.id} [${x.status}] ${x.assignedTo ?? x.role}: ${x.description}`).join("\n");
  const plan = await replan(lead, { goal, roles, board, failed: t, error });
  deps.onOrchestration?.({ type: "replan", taskId: t.id, role: t.role, action: plan.action, reason: plan.reason, time: Date.now() });
  bus?.publish({ agentId: lead.config.id, type: "thought", payload: `replan ${t.id}: ${plan.action}${plan.reason ? ` — ${plan.reason}` : ""}`, time: Date.now() });

  if (plan.action === "retry") {
    t.description = plan.description ?? t.description;
    t.attempts = 0;
    t.status = "pending";
    t.assignedTo = undefined;
    return true;
  }
  if (plan.action === "redirect") {
    if (!plan.role || !agentsById.has(plan.role)) return false; // unknown target — decline, don't silently default
    t.role = plan.role;
    t.description = plan.description ?? t.description;
    t.attempts = 0;
    t.status = "pending";
    t.assignedTo = undefined;
    return true;
  }
  if (plan.action === "inject" && plan.tasks?.length) {
    // Resolve the remediation batch as a self-consistent little plan (own t1..tn ids/deps), then
    // remap those ids so they can't collide with anything already in the DAG.
    const sub = normalizePlan(goal, plan.tasks, roles);
    const idMap = new Map<string, string>(sub.tasks.map((s, i) => [s.id, `${t.id}-r${t.replans}-${i + 1}`]));
    const injected: TaskNode[] = sub.tasks.map((s) => ({
      ...s,
      id: idMap.get(s.id)!,
      dependsOn: s.dependsOn.map((d) => idMap.get(d)).filter((d): d is string => Boolean(d)),
    }));
    if (detectCycle([...tasks, ...injected])) {
      bus?.publish({ agentId: lead.config.id, type: "warning", payload: `replan for ${t.id} would create a cycle — discarded`, time: Date.now() });
      return false;
    }
    for (const nt of injected) {
      tasks.push(nt);
      byId.set(nt.id, nt);
    }
    // Re-emit the plan so both clients redraw the DAG with the new nodes. The TUI's existing
    // `case "plan"` handles it as-is; without this the board silently omitted the injected work.
    deps.onOrchestration?.({
      type: "plan",
      goal,
      tasks: tasks.map((t) => ({ id: t.id, description: t.description, role: t.role, dependsOn: t.dependsOn })),
      time: Date.now(),
    });
  }
  return false; // "inject" and "accept" both leave the original task failed
}

// Gate a "done" task on review, when its assignee's role has a `reviewer:` configured (agents.yaml)
// and that reviewer isn't itself — an opt-in check, invisible when no reviewer is set. The reviewer
// gets the full agentic loop via reviewer.run() (so it can `shell` a git diff, read files, or call
// LSP diagnostics through its own allowedTools) rather than a bespoke tool-free call. Feedback is
// posted through the existing "review" MessageKind — already agent-invokable as a tool, previously
// just advisory; this is what turns it into an actual gate. Returns the reviewer's final feedback if
// the task is still rejected after MAX_REVIEW_ROUNDS (caller flips status to "failed"), else undefined.
async function runReviewGate(t: TaskNode, prompt: string, runner: Agent, agentsById: Map<string, Agent>, deps: SchedulerDeps): Promise<string | undefined> {
  const reviewer = runner.config.reviewer ? agentsById.get(runner.config.reviewer) : undefined;
  if (!reviewer || reviewer.config.id === t.assignedTo) return undefined;
  const { bus, messageBus, onOrchestration: emit } = deps;

  for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
    emit?.({ type: "review", taskId: t.id, reviewer: reviewer.config.id, phase: "requested", time: Date.now() });
    // Capped the same as dependency context, for consistency — the reviewer's own prompt already
    // directs it to verify independently (git diff/read_file/diagnostics) rather than trust this
    // self-reported summary as ground truth, so truncating it loses narrative, not correctness.
    const review = await reviewer.runDetailed(
      `Review the work for task ${t.id}: ${t.description}${t.acceptance ? `\nAcceptance: ${t.acceptance}` : ""}\n\n` +
        `Reported output:\n${(t.output ?? "").slice(0, DEP_CONTEXT_MAX)}\n\nInspect the actual changes (shell "git diff", read_file, diagnostics tools) as needed. ` +
        `End with exactly one line: "VERDICT: approve" or "VERDICT: changes_requested" followed by why.`,
      { taskId: t.id },
    );
    const feedback = review.text; // this run's text, not whatever the reviewer's own task loop last wrote
    // Fail CLOSED: only an explicit approval approves. The old test was "not literally
    // changes_requested", so a garbled, empty, or clobbered verdict passed the gate.
    const approved = review.outcome === "done" && /VERDICT:\s*approve/i.test(feedback);
    messageBus?.post({ from: reviewer.config.id, to: t.assignedTo!, kind: "review", subject: `review of ${t.id}`, body: feedback, refs: [t.id] });
    emit?.({ type: "review", taskId: t.id, reviewer: reviewer.config.id, phase: approved ? "approved" : "changes_requested", time: Date.now() });
    if (approved) return undefined;
    if (round === MAX_REVIEW_ROUNDS) return feedback || "changes requested (no reviewer feedback given)";

    bus?.publish({ agentId: t.assignedTo!, type: "thought", payload: `revising ${t.id} after review feedback`, time: Date.now() });
    const revised = await runner.runDetailed(`${prompt}\n\nA reviewer requested changes:\n${feedback}\n\nAddress this feedback.`, { taskId: t.id });
    t.output = revised.text;
    if (revised.outcome !== "done") return revised.error || "revision attempt failed";
  }
  return undefined; // unreachable — every loop path above returns
}

// Execute a task DAG: run tasks in dependency order, independent tasks concurrently (one per
// agent at a time), deliver each task's output to its dependents (as context) and handoffTo
// teammates (as artifact messages), then run an orchestrator integrate pass. Rejects cycles.
export async function schedule(tasks: TaskNode[], agents: Agent[], deps: SchedulerDeps = {}): Promise<void> {
  const { bus, messageBus, onOrchestration: emit, lead, goal = "" } = deps;
  const cycle = detectCycle(tasks);
  if (cycle) throw new Error(`dependency cycle: ${cycle.join(" -> ")}`);

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const agentsById = new Map(agents.map((a) => [a.config.id, a]));
  // Read live, not captured once: a replan's "inject" action can grow `tasks` mid-run, and progress
  // totals should reflect that.
  const settled = () => tasks.filter((t) => t.status === "done" || t.status === "failed").length;

  emit?.({ type: "plan", goal, tasks: tasks.map((t) => ({ id: t.id, description: t.description, role: t.role, dependsOn: t.dependsOn })), time: Date.now() });
  messageBus?.resetCaps();
  // Coordination is intentionally open within a run — the planner can't anticipate every question
  // an agent will need mid-task (e.g. "what's the API shape?"), so any registered teammate may
  // reach any other; MAX_PER_PAIR is the abuse/loop guard, not per-plan edge authorization.
  messageBus?.allowAll();

  const depsDone = (t: TaskNode) => t.dependsOn.every((d) => (byId.get(d)?.status ?? "done") === "done");
  const depFailed = (t: TaskNode) => t.dependsOn.some((d) => byId.get(d)?.status === "failed");

  const runTask = async (t: TaskNode): Promise<void> => {
    // Per-task, as MAX_PER_PAIR's own comment always claimed. It was reset once for the whole
    // plan, so a 6-task run shared one 10-message budget across every ask_agent, handoff and
    // review — and once spent, later handoffs were dropped.
    messageBus?.resetCaps();
    let runner = agentsById.get(t.role);
    if (!runner) {
      t.status = "failed";
      bus?.publish({ agentId: t.role, type: "error", payload: `no agent '${t.role}' for ${t.id}`, time: Date.now() });
      emit?.({ type: "task_done", taskId: t.id, role: t.role, ok: false, completed: settled(), total: tasks.length, time: Date.now() });
      return;
    }
    t.status = "in_progress";
    t.assignedTo = t.role;
    emit?.({ type: "task_started", taskId: t.id, role: t.role, time: Date.now() });
    bus?.publish({ agentId: t.role, type: "thought", payload: `starting ${t.id}: ${t.description}`, time: Date.now() });

    const depsWithOutput = t.dependsOn.map((id) => byId.get(id)).filter((d): d is TaskNode => Boolean(d?.output));
    // A shared pool across ALL dependencies, not a flat cap per dependency — a diamond task with 3
    // verbose prerequisites used to send up to 3x DEP_CONTEXT_MAX total, unbounded by dependency
    // COUNT even though each one was individually capped. A single-dependency task is unaffected
    // (DEP_CONTEXT_MAX / 1 = DEP_CONTEXT_MAX, identical to before this change).
    // ponytail: a flat char pool, not a token budget; the 300-char floor guards a pathological
    // high-fan-in task from getting near-zero context per dependency, not a real budget guarantee.
    const perDepCap = depsWithOutput.length ? Math.max(300, Math.floor(DEP_CONTEXT_MAX / depsWithOutput.length)) : DEP_CONTEXT_MAX;
    const depContext = depsWithOutput
      .map((d) => `--- Output from ${d.assignedTo} ("${d.description}") ---\n${(d.output ?? "").slice(0, perDepCap)}`)
      .join("\n\n");
    const accept = t.acceptance ? `\n\nAcceptance criterion: ${t.acceptance}` : "";
    const prompt = `${t.description}${accept}${depContext ? `\n\nContext from completed prerequisites:\n${depContext}` : ""}`;

    // Seeded once, for the first attempt only: a retry's own turns are already in the store, so
    // re-reading them would replay the attempt that just failed back into the context window.
    let result = await runner.runDetailed(prompt, { taskId: t.id, priorTurns: deps.priorTurns?.(t.id) });
    // A retry is NEW work (a fresh billed model call), not the original call finishing — so it
    // must honor cancellation too, or "stop launching new work" is broken for exhausted tasks.
    while (result.outcome === "exhausted" && (t.attempts ?? 0) < MAX_ATTEMPTS && !(deps.shouldStop?.() ?? false)) {
      t.attempts = (t.attempts ?? 0) + 1;
      // Actually fail over. The whole point of a multi-provider team is that Anthropic's 429
      // doesn't stall the run — but this loop re-ran the *same* exhausted agent three times while
      // publishing "failover", so an idle Gemini agent was never tried and the UI said otherwise.
      const alt = agents.find(
        (a) => a.config.id !== runner!.config.id && !running.has(a.config.id) && !a.config.lead && !a.nearLimit?.(),
      );
      if (alt) {
        runner = alt;
        t.role = alt.config.id;
        t.assignedTo = alt.config.id;
        bus?.publish({ agentId: alt.config.id, type: "failover", payload: `${t.id} failed over to ${alt.config.id} (attempt ${t.attempts}/${MAX_ATTEMPTS})`, time: Date.now() });
      } else {
        // No idle teammate — a same-agent retry is a retry, not a failover. Say so.
        bus?.publish({ agentId: t.role, type: "warning", payload: `${t.role} exhausted — retry ${t.attempts}/${MAX_ATTEMPTS} of ${t.id}`, time: Date.now() });
      }
      // 2s, 4s, 8s, 16s, 30s. ponytail: one flat curve for every provider, not a Retry-After read —
      // anthropic/openai surface a reset time on `rateLimit`, Gemini's SDK surfaces nothing, and the
      // 429s that motivated this were Gemini's. Wire result.rateLimit.resetAt in here if that changes.
      await sleep(Math.min(BACKOFF_BASE_MS * 2 ** (t.attempts - 1), BACKOFF_CAP_MS));
      result = await runner.runDetailed(prompt, { taskId: t.id });
    }

    t.output = result.text;
    t.status = result.outcome === "done" ? "done" : "failed";
    let failureReason = result.outcome === "done" ? "" : result.error;

    if (t.status === "done") {
      const rejection = await runReviewGate(t, prompt, runner, agentsById, deps);
      if (rejection) {
        t.status = "failed";
        failureReason = rejection;
      }
    }
    // Give the lead one shot at recovering before the failure cascades to dependents — whether the
    // failure came from the run itself or from a rejected review. Skipped on cancel — like the
    // integrate pass, a replan is a fresh, unabortable model call. attemptReplan itself flips status
    // back to "pending" on a successful retry/redirect; otherwise t.status is already "failed".
    if (t.status === "failed" && (t.replans ?? 0) < MAX_REPLAN_ATTEMPTS && !(deps.shouldStop?.() ?? false)) {
      await attemptReplan(t, failureReason, tasks, byId, agentsById, deps);
    }
    // A recovered task isn't finished — no task_done event, and it stays out of the handoff block below.
    if (t.status === "done" || t.status === "failed") {
      emit?.({ type: "task_done", taskId: t.id, role: t.role, ok: t.status === "done", completed: settled(), total: tasks.length, time: Date.now() });
    }

    if (t.status === "done" && t.handoffTo?.length && messageBus) {
      // The result was discarded, so a handoff refused by the rate cap vanished — while the
      // `handoff` event fired anyway and the dashboard animated an edge for a message nobody got.
      // The downstream agent then started without its prerequisite's artifact and no one was told.
      const delivered: string[] = [];
      for (const to of t.handoffTo) {
        const r = messageBus.post({ from: t.assignedTo!, to, kind: "artifact", subject: `output of ${t.id}: ${t.description.slice(0, 60)}`, body: t.output ?? "", refs: [t.id] });
        if (r.ok) delivered.push(to);
        else bus?.publish({ agentId: t.assignedTo!, type: "warning", payload: `handoff to ${to} not delivered: ${r.reason}`, time: Date.now() });
      }
      if (delivered.length) emit?.({ type: "handoff", taskId: t.id, from: t.assignedTo!, to: delivered, time: Date.now() });
    }
  };

  const running = new Map<string, Promise<void>>(); // agentId → in-flight task
  for (;;) {
    const stop = deps.shouldStop?.() ?? false;

    // Any task whose dependency failed can never become ready — fail it (skipped) so we don't hang.
    for (const t of tasks) {
      if (t.status === "pending" && depFailed(t)) {
        t.status = "failed";
        bus?.publish({ agentId: t.role, type: "error", payload: `${t.id} skipped — a prerequisite failed`, time: Date.now() });
        emit?.({ type: "task_done", taskId: t.id, role: t.role, ok: false, completed: settled(), total: tasks.length, time: Date.now() });
      }
    }

    // Start ready tasks on idle agents (one task per agent at a time). When cancelling, we stop
    // launching new work but let in-flight tasks finish.
    if (!stop)
      for (const t of tasks) {
        if (t.status !== "pending" || !depsDone(t) || running.has(t.role)) continue;
        emit?.({ type: "task_ready", taskId: t.id, role: t.role, time: Date.now() });
        // Captured up front: a "redirect" replan can change t.role while this task is in flight, and
        // the slot must be freed under the role it was claimed under, not whatever role it ends on.
        const startRole = t.role;
        const p = runTask(t).finally(() => running.delete(startRole));
        running.set(startRole, p);
      }

    if (running.size === 0) {
      // Nothing running and nothing startable. If pending tasks remain they're unreachable — fail
      // them. But NOT on cancel: the user stopping a run has not made those tasks fail, and marking
      // them failed is what made a cancelled run report every remaining task as an error.
      if (!(deps.shouldStop?.() ?? false)) {
        for (const t of tasks.filter((t) => t.status === "pending")) {
          t.status = "failed";
          emit?.({ type: "task_done", taskId: t.id, role: t.role, ok: false, completed: settled(), total: tasks.length, time: Date.now() });
        }
      }
      break;
    }
    await Promise.race(running.values());
  }

  // Integrate: the orchestrator reviews the outputs and compiles a summary. Skipped on cancel —
  // it's a fresh, unabortable model call, and a cancelled run shouldn't pay for one more.
  if (lead && !(deps.shouldStop?.() ?? false)) {
    try {
      const board = tasks.map((t) => `${t.id} [${t.status}] ${t.assignedTo}: ${t.description}`).join("\n");
      const outputs = tasks
        .filter((t) => t.output)
        .map((t) => `### ${t.id} — ${t.description} (${t.assignedTo})\n${t.output}`)
        .join("\n\n");
      const summary = await lead.ask(
        `As the orchestrator, review the finished project.\n\nTasks:\n${board}\n\nOutputs:\n${outputs}\n\n` +
          `Summarize what was built, how the pieces fit together, and any gaps or follow-ups (3-6 sentences).`,
      );
      bus?.publish({ agentId: lead.config.id, type: "message", payload: summary, time: Date.now() });
      emit?.({ type: "integrate", summary, time: Date.now() });
    } catch (err) {
      bus?.publish({ agentId: lead.config.id, type: "error", payload: `integrate failed: ${err instanceof Error ? err.message : err}`, time: Date.now() });
    }
  }

  // completed = tasks that actually finished, not "everything that stopped moving" — settled()
  // counts failures too, so a cancelled or half-failed run used to report 100%.
  emit?.({
    type: "complete",
    completed: tasks.filter((t) => t.status === "done").length,
    total: tasks.length,
    cancelled: deps.shouldStop?.() ?? false,
    time: Date.now(),
  });
}
