import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Task } from "./orchestrator/task.ts";
import type { Turn } from "./providers/provider.ts";
import type { SessionStore } from "./store/session-store.ts";

const DEFAULT = ".amux/session.json";

// The task board stays JSON (small, human-readable, hand-editable); conversation history lives in
// SQLite (store/), because it's large, append-heavy, and queried by session rather than read whole.
export function saveTasks(tasks: readonly Task[], path = DEFAULT): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ tasks }, null, 2));
}

export function loadTasks(path = DEFAULT): Task[] {
  if (!existsSync(path)) return [];
  const data = JSON.parse(readFileSync(path, "utf8")) as { tasks?: Task[] };
  return Array.isArray(data.tasks) ? data.tasks : [];
}

// Every stored session for a task, oldest first, flattened into one conversation — what an agent
// gets seeded with when a task is resumed, so it continues rather than starting over.
export function resumeConversation(store: SessionStore, taskId: string): Turn[] {
  return store.listSessions({ taskId }).flatMap((s) => store.loadTurns(s.id));
}
