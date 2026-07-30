import { z } from "zod";
import type { TaskNode } from "./task.ts";
import { summarizeError } from "../providers/provider.ts";

// The orchestrator turns a goal into a DAG of role-assigned tasks. This replaces the old one-shot
// flat fan-out: tasks carry dependencies (dependsOn) and hand-offs (handoffTo) so work is sequenced
// (e.g. UI design before the frontend that consumes it) and outputs flow to the right downstream role.

export interface Plan {
  goal: string;
  tasks: TaskNode[];
}

// Minimal shape the planner needs — Agent satisfies it, and tests can pass a fake.
export interface PlannerAgent {
  config: { id: string; role?: string };
  ask(prompt: string): Promise<string>;
}

export interface RoleInfo {
  id: string;
  role: string;
  description?: string;
}

const RawTask = z.object({
  id: z.string().optional(),
  description: z.string().min(1),
  role: z.string().min(1),
  dependsOn: z.array(z.string()).optional(),
  handoffTo: z.array(z.string()).optional(),
  acceptance: z.string().optional(),
});
const RawPlan = z.union([z.array(RawTask), z.object({ tasks: z.array(RawTask) })]);

const MAX_PLAN_ATTEMPTS = 3;

// Pull the first parseable JSON array or object out of a model response (tolerant of prose, code
// fences, and brackets that appear inside string values or in lead-in prose). Bracket counting
// skips string literals; if a candidate start doesn't parse, we advance to the next bracket.
export function extractJson(raw: string): unknown {
  const s = raw.replace(/```(?:json)?/gi, "");
  for (let start = 0; start < s.length; start++) {
    const open = s[start];
    if (open !== "[" && open !== "{") continue;
    const close = open === "[" ? "]" : "}";
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(s.slice(start, i + 1));
          } catch {
            break; // this start position isn't valid JSON — try the next bracket
          }
        }
      }
    }
  }
  return undefined;
}

// Coerce a validated-but-messy plan into a clean DAG: stable ids, roles mapped to real agent ids,
// dependsOn/handoffTo pointing only at things that exist, and self-deps removed.
export function normalizePlan(
  goal: string,
  rawTasks: z.infer<typeof RawTask>[],
  roles: RoleInfo[],
): Plan {
  const ids = new Set(roles.map((r) => r.id));
  const byRoleName = new Map(roles.map((r) => [r.role.toLowerCase(), r.id] as const));
  const fallbackRole = roles[0]?.id ?? "agent";

  // Two separate namespaces so a model-supplied id like "t2" can't clobber a positional id: original
  // ids win, positional t1..tn ids are a fallback. (A single shared map would collide and drop deps.)
  // A model-supplied id reused across multiple tasks is ambiguous — track it separately and treat
  // any reference to it as unresolved (dropped) rather than silently binding to whichever task's
  // `.set()` happened to run last, which would fabricate a wrong dependency.
  const originalToNew = new Map<string, string>();
  const ambiguousIds = new Set<string>();
  rawTasks.forEach((t, i) => {
    if (!t.id) return;
    if (originalToNew.has(t.id)) ambiguousIds.add(t.id);
    else originalToNew.set(t.id, `t${i + 1}`);
  });
  const generatedIds = new Set(rawTasks.map((_, i) => `t${i + 1}`));
  const resolveDep = (d: string, self: string): string | undefined => {
    if (ambiguousIds.has(d)) return undefined; // reused id — can't tell which task was meant, drop
    const mapped = originalToNew.get(d) ?? (generatedIds.has(d) ? d : undefined);
    return mapped && mapped !== self ? mapped : undefined; // drop unknown/self deps
  };

  // Role owner: fall back to the first agent for an unknown assignee (a task must run somewhere).
  const resolveRole = (role: string): string => (ids.has(role) ? role : byRoleName.get(role.toLowerCase()) ?? fallbackRole);
  // Hand-off targets: DROP unknown teammates rather than redirect them to agent 0 (unsolicited).
  const resolveKnownRole = (role: string): string | undefined => (ids.has(role) ? role : byRoleName.get(role.toLowerCase()));

  const tasks: TaskNode[] = rawTasks.map((t, i) => {
    const id = `t${i + 1}`;
    const owner = resolveRole(t.role);
    const dependsOn = (t.dependsOn ?? [])
      .map((d) => resolveDep(d, id))
      .filter((d): d is string => Boolean(d));
    const handoffTo = (t.handoffTo ?? [])
      .map(resolveKnownRole)
      .filter((h): h is string => Boolean(h) && h !== owner);
    return {
      id,
      description: t.description,
      status: "pending",
      role: owner,
      assignedTo: owner,
      dependsOn: [...new Set(dependsOn)],
      handoffTo: [...new Set(handoffTo)],
      acceptance: t.acceptance,
    };
  });
  return { goal, tasks };
}

function plannerPrompt(goal: string, roles: RoleInfo[], correction?: string): string {
  const roster = roles
    .map((r) => `  - id "${r.id}" — role: ${r.role}${r.description ? ` (${r.description})` : ""}`)
    .join("\n");
  return (
    `You are the orchestrator of a team of AI coding agents. Break the goal into a small DAG of ` +
    `concrete tasks (2-6). Assign each task to exactly one teammate by their id. Sequence work with ` +
    `"dependsOn" (task ids that must finish first) so prerequisites run before consumers — e.g. UI/` +
    `design tasks before the frontend that uses them. Use "handoffTo" to name teammate ids that should ` +
    `receive a task's output.\n\n` +
    `Teammates:\n${roster}\n\n` +
    `Goal: ${goal}\n\n` +
    `Return ONLY JSON: an array of {"id","description","role","dependsOn","handoffTo","acceptance"}. ` +
    `"role" MUST be one of the ids above. No prose.` +
    (correction ? `\n\nYour previous reply was invalid: ${correction}. Return valid JSON only.` : "")
  );
}

// Ask the orchestrator agent for a plan, validating + normalizing. Retries on invalid JSON, then
// falls back to a single task (the whole goal on the lead) — a bad planner never crashes the run.
export async function makePlan(lead: PlannerAgent, goal: string, roles: RoleInfo[]): Promise<Plan> {
  let correction: string | undefined;
  for (let attempt = 0; attempt < MAX_PLAN_ATTEMPTS; attempt++) {
    let raw: string;
    try {
      raw = await lead.ask(plannerPrompt(goal, roles, correction));
    } catch (err) {
      correction = summarizeError(err);
      continue;
    }
    const json = extractJson(raw);
    const parsed = RawPlan.safeParse(json);
    if (!parsed.success) {
      correction = "expected an array of task objects";
      continue;
    }
    const rawTasks = Array.isArray(parsed.data) ? parsed.data : parsed.data.tasks;
    if (!rawTasks.length) {
      correction = "the task array was empty";
      continue;
    }
    return normalizePlan(goal, rawTasks, roles);
  }
  // Fallback: one task, whole goal, on the lead.
  const role = lead.config.id;
  return {
    goal,
    tasks: [{ id: "t1", description: goal, status: "pending", role, assignedTo: role, dependsOn: [], handoffTo: [] }],
  };
}
