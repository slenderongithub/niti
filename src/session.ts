import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { Task } from "./orchestrator/task.ts";
import type { Turn } from "./providers/provider.ts";
import type { SessionStore } from "./store/session-store.ts";

const DEFAULT = ".amux/session.json";

// The task board stays JSON (small, human-readable, hand-editable); conversation history lives in
// SQLite (store/), because it's large, append-heavy, and queried by session rather than read whole.
export function saveTasks(tasks: readonly Task[], path = DEFAULT): void {
  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename: a crash or SIGKILL mid-write used to leave a truncated file that bricked
  // both `resume` and server startup. rename(2) is atomic within a filesystem, so a reader sees
  // either the old file or the new one, never half of one.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ tasks }, null, 2));
  renameSync(tmp, path);
}

export function loadTasks(path = DEFAULT): Task[] {
  if (!existsSync(path)) return [];
  // Same posture as the auth store: a corrupt file must not brick the CLI. The next save heals it.
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { tasks?: Task[] };
    return Array.isArray(data.tasks) ? data.tasks : [];
  } catch {
    console.error(`amux: ignoring unreadable ${path}`);
    return [];
  }
}

// What an agent is seeded with when a task is resumed, so it continues rather than starting over.
//
// Two bounds, both learned the hard way. (1) Only the resuming agent's own sessions: a task that
// failed over between agents has sessions from each, and replaying all of them fed one model
// another model's first-person transcript as if it were its own. (2) Only the most recent one:
// every prior attempt concatenated meant a task retried four times resumed with four full
// transcripts, which is how a resume overflows the context window before it has done anything.
// ponytail: last-session-only, not a token budget — upgrade if resumes need deeper history.
export function resumeConversation(store: SessionStore, taskId: string, agentId?: string): Turn[] {
  const sessions = store.listSessions({ taskId }).filter((s) => !agentId || s.agentId === agentId);
  const latest = sessions.at(-1);
  return latest ? store.loadTurns(latest.id) : [];
}
