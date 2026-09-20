// A working checklist the agent owns for the length of one task.
//
// niti plans at the DAG level — the lead decomposes a goal into tasks and the scheduler sequences
// them — but inside a single task an agent had no plan at all. On anything with more than a couple
// of steps that shows up as drift: it does step one, the tool results push the original instruction
// further up the context, and by turn eight it is polishing step one instead of starting step three.
// The turn cap then ends the task with most of it never attempted, reported as "done".
//
// The fix is not a smarter model, it is writing the plan down somewhere that survives. The list is
// re-injected near the end of the conversation on every change, so "what am I doing" is always
// recent context rather than something to reconstruct from a transcript.
//
// ponytail: whole-list replace, no per-item ids or partial updates. The model reliably re-sends
// four items; reconciling a patch against a list it half-remembers is the failure mode this exists
// to prevent.

export type TodoStatus = "pending" | "doing" | "done";

export interface TodoItem {
  text: string;
  status: TodoStatus;
}

const STATUS: TodoStatus[] = ["pending", "doing", "done"];
const MAX_ITEMS = 20; // a task needing more than this wanted to be several tasks
const MAX_TEXT = 120;

// Tolerant by design: this is model output, and rejecting a whole list over one bad status field
// would cost a turn to re-send something already good enough to act on.
export function parseTodos(input: unknown): TodoItem[] {
  if (!Array.isArray(input)) return [];
  const out: TodoItem[] = [];
  for (const raw of input) {
    if (out.length >= MAX_ITEMS) break;
    // Accept a bare string as well as {text, status} — models emit both, and a plain list of steps
    // is a perfectly clear plan.
    if (typeof raw === "string") {
      if (raw.trim()) out.push({ text: raw.trim().slice(0, MAX_TEXT), status: "pending" });
      continue;
    }
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const text = String(r.text ?? r.step ?? r.task ?? r.title ?? "").trim();
    if (!text) continue;
    const given = String(r.status ?? "pending").toLowerCase();
    // "in_progress"/"in progress"/"active" all mean doing; anything unrecognized means pending,
    // which is the safe reading — it keeps the item on the list rather than retiring it.
    const status: TodoStatus = STATUS.includes(given as TodoStatus)
      ? (given as TodoStatus)
      : /progress|active|current|wip/.test(given)
        ? "doing"
        : /complete|finish|✓/.test(given)
          ? "done"
          : "pending";
    out.push({ text: text.slice(0, MAX_TEXT), status });
  }
  return out;
}

const MARK: Record<TodoStatus, string> = { pending: "[ ]", doing: "[~]", done: "[x]" };

export function renderTodos(items: TodoItem[]): string {
  return items.map((i) => `${MARK[i.status]} ${i.text}`).join("\n");
}

// What goes back to the model after a todo call. Naming what is left, explicitly, is the point:
// a bare "ok" invites the model to treat the bookkeeping as the accomplishment and stop.
export function todoAck(items: TodoItem[]): string {
  if (items.length === 0) return "plan cleared";
  const left = items.filter((i) => i.status !== "done").length;
  return left === 0
    ? `${renderTodos(items)}\n\nEvery step is marked done — finish by verifying the work, then say so.`
    : `${renderTodos(items)}\n\n${left} step(s) still open. Keep going.`;
}
