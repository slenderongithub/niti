import type { Task, TaskNode } from "./task.ts";

// Shared task queue. claimTask is synchronous → atomic under Node's single-threaded event loop.
// ponytail: no mutex needed — a synchronous find-then-mark can't be interleaved by another agent.
export class Orchestrator {
  private tasks: Task[] = [];
  private nextId = 1;
  // The goal whose plan is sitting on the board unexecuted, set by a PLAN-mode run. runProject
  // reads it so that switching to BUILD and sending the same goal runs *this* DAG instead of
  // paying for a second planning call that may well come back with a different one. Cleared by
  // load()/clear() and consumed on use — it describes this exact board, nothing else.
  plannedGoal?: string;

  addTask(description: string): Task {
    const t: Task = { id: `t${this.nextId++}`, description, status: "pending" };
    this.tasks.push(t);
    return t;
  }

  // Restore a saved task list (resume); continues id numbering past the highest existing id.
  load(tasks: Task[]): void {
    // The same array, not a copy. The scheduler appends replan-injected remediation tasks to the
    // array it was handed; with a copy here those nodes existed only inside the scheduler, so they
    // never reached orch.all — meaning they were never persisted to session.json, never resumable,
    // and never drawn on the board while the user watched an agent work on them.
    this.tasks = tasks;
    this.plannedGoal = undefined; // a board replaced wholesale is no longer the plan someone approved
    this.nextId = Math.max(0, ...tasks.map((t) => Number(t.id.replace(/\D/g, "")) || 0)) + 1;
  }

  // The live board as DAG nodes — the same array, never a copy, so replan-injected tasks the
  // scheduler appends land on the board the UI and session.json read (see load()). Only call this
  // for a board that is genuinely made of planner output; takeApprovedPlan checks that first.
  nodes(): TaskNode[] {
    return this.tasks as TaskNode[];
  }

  // /clear — drop all tasks so the next submission starts a fresh board. IDs keep counting up.
  clear(): void {
    this.tasks = [];
    this.plannedGoal = undefined;
  }

  // Returns the next pending task this agent may claim, marked in_progress, or undefined.
  // A task this agent just failed is off-limits until its backoff passes — otherwise a failing
  // agent immediately reclaims its own requeued task before any other agent's loop gets a turn,
  // which defeats the point of failover. A *different* agent can claim it right away (no reason
  // to make a healthy agent wait out another agent's cooldown).
  claimTask(agentId: string): Task | undefined {
    const now = Date.now();
    const t = this.tasks.find(
      (t) => t.status === "pending" && (t.lastFailedBy !== agentId || (t.availableAt ?? 0) <= now),
    );
    if (!t) return undefined;
    t.status = "in_progress";
    t.assignedTo = agentId;
    return t;
  }

  complete(task: Task, ok: boolean): void {
    task.status = ok ? "done" : "failed";
  }

  // Failover: return the task to the pool so another agent claims it. Bumps the attempt counter
  // and imposes a short backoff (so a transient rate limit has a moment to clear) plus a
  // same-agent exclusion (via claimTask) so the failing agent doesn't just grab it right back.
  requeue(task: Task, agentId: string): void {
    task.status = "pending";
    task.assignedTo = undefined;
    task.attempts = (task.attempts ?? 0) + 1;
    task.lastFailedBy = agentId;
    task.availableAt = Date.now() + Math.min(task.attempts * 500, 3000);
  }

  // User-triggered reassignment of a not-yet-started task to a different agent. Only "pending"
  // tasks qualify — an in_progress task already has a live agent working it, and interrupting that
  // is a different, unbuilt feature (failover via requeue() handles the failure case, not a user
  // changing their mind mid-task). The scheduler reads t.role to decide who picks up a pending task
  // (scheduler.ts's readiness loop), so changing it here is sufficient to redirect it.
  reassign(taskId: string, role: string): string | undefined {
    const t = this.tasks.find((t) => t.id === taskId);
    if (!t) return `no such task: ${taskId}`;
    if (t.status !== "pending") return `only pending tasks can be reassigned (${taskId} is ${t.status})`;
    t.role = role;
    return undefined;
  }

  // True while any task is still pending or being worked (so workers wait for possible failovers).
  hasUnfinished(): boolean {
    return this.tasks.some((t) => t.status === "pending" || t.status === "in_progress");
  }

  get all(): readonly Task[] {
    return this.tasks;
  }
}
