import type { Task, TaskNode } from "./task.ts";

// The task board: what the planner made, as the scheduler (scheduler.ts) runs it and every client sees it.
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

  // /clear — drop all tasks so the next submission starts a fresh board, numbered from t1 again.
  clear(): void {
    this.tasks = [];
    this.plannedGoal = undefined;
    this.nextId = 1;
  }

  // User-triggered reassignment of a not-yet-started task to a different agent. Only "pending"
  // tasks qualify — an in_progress task already has a live agent working it, and interrupting that
  // is a different, unbuilt feature (the scheduler's failover handles the failure case, not a user
  // changing their mind mid-task). The scheduler reads t.role to decide who picks up a pending task
  // (scheduler.ts's readiness loop), so changing it here is sufficient to redirect it.
  reassign(taskId: string, role: string): string | undefined {
    const t = this.tasks.find((t) => t.id === taskId);
    if (!t) return `no such task: ${taskId}`;
    if (t.status !== "pending") return `only pending tasks can be reassigned (${taskId} is ${t.status})`;
    t.role = role;
    return undefined;
  }

  get all(): readonly Task[] {
    return this.tasks;
  }
}
