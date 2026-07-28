export type TaskStatus = "pending" | "in_progress" | "done" | "failed";

export interface Task {
  id: string;
  description: string;
  assignedTo?: string;
  status: TaskStatus;
  attempts?: number; // bumped on each failover requeue
  lastFailedBy?: string; // agent id that most recently failed this task (avoid immediate self-reclaim)
  availableAt?: number; // epoch ms — claimTask ignores this task until then (backoff after failover)
}
