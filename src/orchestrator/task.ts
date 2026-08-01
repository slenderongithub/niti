export type TaskStatus = "pending" | "in_progress" | "done" | "failed";

export interface Task {
  id: string;
  description: string;
  assignedTo?: string;
  status: TaskStatus;
  attempts?: number; // bumped on each failover requeue
  lastFailedBy?: string; // agent id that most recently failed this task (avoid immediate self-reclaim)
  availableAt?: number; // epoch ms — claimTask ignores this task until then (backoff after failover)
  replans?: number; // bumped each time the lead is asked to replan this task after it exhausts retries
  // --- DAG fields (set by the planner; absent for a flat single-task fallback) ---
  role?: string; // agent id that should own this task
  dependsOn?: string[]; // task ids that must complete before this one is ready
  handoffTo?: string[]; // agent ids that receive this task's output as a message when it completes
  acceptance?: string; // short done-criterion the agent should satisfy
  output?: string; // final assistant text — fed to dependents and handoff messages
}

// A fully-specified DAG node. The planner emits these (role + dependsOn always present);
// the scheduler consumes them. Task keeps those fields optional so the flat/legacy path and
// session persistence still type-check.
export interface TaskNode extends Task {
  role: string;
  dependsOn: string[];
}
