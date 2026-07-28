import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Task } from "./orchestrator/task.ts";

const DEFAULT = ".amux/session.json";

// Persist the task list so `amux resume` can reload prior work.
// ponytail: tasks only — per-agent conversation history isn't saved (would be large); add if resume needs it.
export function saveTasks(tasks: readonly Task[], path = DEFAULT): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ tasks }, null, 2));
}

export function loadTasks(path = DEFAULT): Task[] {
  if (!existsSync(path)) return [];
  const data = JSON.parse(readFileSync(path, "utf8")) as { tasks?: Task[] };
  return Array.isArray(data.tasks) ? data.tasks : [];
}
