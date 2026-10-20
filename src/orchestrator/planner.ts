import { z } from "zod";
import { profileFor } from "../agent/profile.ts";
import type { TaskNode } from "./task.ts";
import { summarizeError } from "../providers/provider.ts";

// The orchestrator turns a goal into a DAG of role-assigned tasks. This replaces the old one-shot
// flat fan-out: tasks carry dependencies (dependsOn) and hand-offs (handoffTo) so work is sequenced
// (e.g. UI design before the frontend that consumes it) and outputs flow to the right downstream role.

interface Plan {
  goal: string;
  tasks: TaskNode[];
  // Not every message is work. The planner routes it: a greeting or chat gets `reply` (said back
  // as-is), a question about the code gets `question` (answered by the lead with read-only tools),
  // and only a request to change something gets `tasks`. Exactly one of the three is set.
  reply?: string;
  question?: string;
  // Set when no usable plan came back and the fallback was used: why (the last parse error or the
  // provider's error), so the run can say so instead of silently putting everything on the lead.
  fallback?: string;
}

// One earlier exchange, so a follow-up ("now add tests") can refer back to what "it" was.
export interface Exchange {
  goal: string;
  outcome: string;
}

// Minimal shape the planner needs — Agent satisfies it, and tests can pass a fake.
export interface PlannerAgent {
  config: { id: string; role?: string };
  ask(prompt: string, opts?: { json?: boolean; plan?: boolean }): Promise<string>;
}

export interface RoleInfo {
  id: string;
  role: string;
  description?: string;
  // false for a teammate on a local model its check found can't call tools ("chat only"): it gets
  // answers and reviews, never a task that changes files. Unset means ready.
  ready?: boolean;
}

const RawTask = z.object({
  id: z.string().optional(),
  description: z.string().min(1),
  role: z.string().min(1),
  dependsOn: z.array(z.string()).optional(),
  handoffTo: z.array(z.string()).optional(),
  acceptance: z.string().optional(),
});
const RawPlan = z.union([
  z.array(RawTask),
  z.object({ tasks: z.array(RawTask) }),
  z.object({ reply: z.string().min(1) }),
  z.object({ question: z.string().min(1) }),
]);

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

// The last few exchanges, oldest first, bounded so a long session can't grow every planning call.
function historyBlock(history: Exchange[]): string {
  if (!history.length) return "";
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const lines = history.slice(-6).map((h) => `  - user: ${clip(h.goal, 300)}\n    result: ${clip(h.outcome, 400)}`);
  return `Recent conversation (oldest first) — the new message may refer back to it:\n${lines.join("\n")}\n\n`;
}

// Tasks a previous plan left unfinished. A follow-up ("skip the first one", "also add tests") is
// about them, so the planner sees them and folds them into the new plan instead of the new message
// silently replacing a detailed plan with a one-line one.
function boardBlock(unfinished: string[]): string {
  if (!unfinished.length) return "";
  return (
    `Unfinished tasks from the current plan:\n${unfinished.slice(0, 12).map((t) => `  - ${t}`).join("\n")}\n` +
    `If the message is work, your plan replaces this board: keep the tasks the user still wants (restated in full), ` +
    `apply what the message changes, and drop only what it says to drop.\n\n`
  );
}

// The "split only independent work" rule: across 180 agent configurations, multi-agent setups gained
// on parallelisable tasks and lost 39-70% on sequential ones (Google, "Towards a Science of Scaling
// Agent Systems", 2025), and a single agent beat a fixed pipeline on bug fixing and multi-file
// coding (ECER 2026). See docs/research/2026-10-merged.md.
function plannerPrompt(goal: string, roles: RoleInfo[], correction?: string, history: Exchange[] = [], unfinished: string[] = []): string {
  const roster = roles
    .map((r) => `  - id "${r.id}" — role: ${r.role}${r.description ? ` (${r.description})` : ""}${r.ready === false ? " — answers and reviews only: never give it a task that changes files" : ""}`)
    .join("\n");
  return (
    `You are the orchestrator of a team of AI coding agents, talking with the user. First decide what ` +
    `the user's message is:\n` +
    `- a greeting, thanks, or small talk → reply to it briefly and do no work: {"reply": "..."}\n` +
    `- a question that needs no changes (about this project, its code, or anything else) → ` +
    `{"question": "<the question, restated so it stands alone>"}; the lead will look at the code and answer\n` +
    `- a request to build, change, fix or run something → plan it.\n\n` +
    `To plan: break the work into a small DAG of concrete tasks (1-6 — one is fine for a small change; ` +
    `never invent work the user did not ask for). Split only work that can go ahead independently, on ` +
    `different files or parts of the project. A chain where each step needs what the previous one ` +
    `found — locate a bug, fix it, test the fix — is ONE task for one teammate: handing a half-understood ` +
    `problem to another agent loses what was learned and costs more. When unsure, use fewer tasks. ` +
    `Assign each task to exactly one teammate by their id. ` +
    `Sequence work with "dependsOn" (task ids that must finish first) so prerequisites run before ` +
    `consumers — e.g. UI/design tasks before the frontend that uses them. Use "handoffTo" to name ` +
    `teammate ids that should receive a task's output.\n\n` +
    `Teammates:\n${roster}\n\n` +
    historyBlock(history) +
    boardBlock(unfinished) +
    `User's message: ${goal}\n\n` +
    `Return ONLY JSON — {"reply": ...}, {"question": ...}, or an array of ` +
    `{"id","description","role","dependsOn","handoffTo","acceptance"} where "role" MUST be one of the ids above. No prose.` +
    (correction ? `\n\nYour previous reply was invalid: ${correction}. Return valid JSON only.` : "")
  );
}

// Words that say which kind of teammate a task is for, by the role names people give them: the role
// pattern, then the words of a task (or a goal) that belong to it.
const ROLE_WORDS: [RegExp, RegExp][] = [
  [/front|ui|design|web|client/i, /\b(html|css|style|styling|layout|page|component|ui|button|form|landing|responsive|tailwind|react|view|screen|frontend)\b/i],
  [/back|api|server|data|infra/i, /\b(api|server|endpoint|route|database|db|schema|model|backend|auth|express|fastapi|sql|json data|storage)\b/i],
  [/test|qa|quality/i, /\b(test|tests|testing|spec|coverage|qa)\b/i],
  [/devops|ops|deploy|build|ci/i, /\b(deploy|docker|ci|pipeline|build script|release)\b/i],
  [/doc|writer/i, /\b(readme|docs|documentation)\b/i],
];

// "frontend: build index.html…" lines → { frontend: "build index.html…" }. Tolerates bullets, bold,
// backticks, quotes and numbering. A teammate given "-" or "none" gets nothing.
export function parsePlanLines(text: string, ids: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^[\s>*\-•\d.)]*/, "").replace(/\*\*/g, "").replace(/`/g, "").trim();
    const m = /^([\w-]+)\s*[:—–-]\s*(.+)$/.exec(line);
    if (!m) continue;
    const id = ids.find((x) => x.toLowerCase() === m[1]!.toLowerCase());
    const task = m[2]!.trim().replace(/^["']|["']$/g, "");
    if (id && !out[id] && task && !/^(-|none|nothing|n\/a)\.?$/i.test(task)) out[id] = task;
  }
  return out;
}

// What kind of message it is, said by a small model in one line (the local planner's first stage).
// A reply that fits none of the forms is read by its shape: a greeting is chat, a question mark a
// question, anything else work — the cost of mistaking chat for work is one small task, the cost of
// the reverse is doing nothing.
export function parseRoute(text: string, goal: string): { kind: "work" } | { kind: "question"; question: string } | { kind: "chat"; reply: string } {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^[\s>*\-•`"]*/, "").replace(/\*\*/g, "").trim();
    const m = /^(work|question|chat)\b\s*[:—–-]?\s*(.*)$/i.exec(line);
    if (!m) continue;
    const kind = m[1]!.toLowerCase();
    const rest = m[2]!.trim().replace(/^["']|["']$/g, "");
    if (kind === "work") return { kind: "work" };
    if (kind === "question") return { kind: "question", question: rest || goal };
    return { kind: "chat", reply: rest || "Hi! What should we build?" };
  }
  if (/^\s*(hi|hello|hey|thanks|thank you|good (morning|evening|night))\b[\s!.]*$/i.test(goal)) return { kind: "chat", reply: "Hi! What should we build?" };
  if (goal.trim().endsWith("?") && !/\b(can you|could you|would you|please)\b/i.test(goal)) return { kind: "question", question: goal };
  return { kind: "work" };
}

// The parts of a goal each kind of teammate takes when a small lead couldn't split it (the
// deterministic plan) — by the words in the goal, so a page-only request doesn't invent a server.
const GOAL_UI = /\b(html|css|style|styling|page|pages|site|website|landing|ui|frontend|front-end|app|component|design|layout|screen|dashboard|portfolio)\b/i;
const GOAL_SERVER = /\b(api|server|endpoint|route|database|db|backend|back-end|auth|full[- ]?stack|end[- ]to[- ]end|login|form submissions?|orders?)\b/i;
const GOAL_DEPLOY = /\b(deploy|deployment|deployable|production|host|hosting|ship|launch|live|end[- ]to[- ]end)\b/i;
const kindOf = (r: RoleInfo): number => ROLE_WORDS.findIndex(([role]) => role.test(`${r.role} ${r.id}`));

export function rolePlan(goal: string, roles: RoleInfo[], leadId: string): TaskNode[] {
  const ready = roles.filter((r) => r.ready !== false);
  const deploy = GOAL_DEPLOY.test(goal);
  const hasDevops = ready.some((r) => kindOf(r) === 3);
  const parts: { id: string; part: string }[] = [];
  for (const r of ready) {
    const k = kindOf(r);
    let part = "";
    if (k === 0 && GOAL_UI.test(goal)) part = "the pages and their look: the HTML, a stylesheet with the design, and any client-side JavaScript";
    else if (k === 1 && (GOAL_SERVER.test(goal) || (deploy && !hasDevops)))
      part = "the server side: a small server the site runs on" + (GOAL_SERVER.test(goal) ? " with the API and data it needs" : "") + (deploy && !hasDevops ? ", a package.json with a start script, and a README with how to run and deploy it" : "");
    else if (k === 2 && ROLE_WORDS[2]![1].test(goal)) part = "tests for what the team builds";
    else if (k === 3 && deploy) part = "making it deployable: a start script, the server or config it needs, and a README with how to run and deploy it";
    else if (k === 4 && ROLE_WORDS[4]![1].test(goal)) part = "the README and docs";
    if (part) parts.push({ id: r.id, part });
  }
  // The lead keeps what nobody's role covers — unless it's a chat-only teammate itself.
  const owner = roles.some((r) => r.id === leadId && r.ready === false) ? (ready[0]?.id ?? leadId) : leadId;
  if (parts.length === 0) return [{ id: "t1", description: goal, status: "pending", role: owner, assignedTo: owner, dependsOn: [], handoffTo: [] }];
  return withIntegration(
    parts.map((p, i) => ({ id: `t${i + 1}`, description: `${goal}\n\nYour part: ${p.part}. Teammates do the rest.`, status: "pending", role: p.id, assignedTo: p.id, dependsOn: [], handoffTo: [] })),
    owner,
  );
}

// Two or more parts built side by side by small models rarely fit on the first try (a stylesheet the
// page links under another name, a fetch to a route the server doesn't have). A last task checks the
// seams and fixes them — real work with tools, unlike the integrate pass, which only summarises.
function withIntegration(tasks: TaskNode[], owner: string): TaskNode[] {
  if (tasks.length < 2) return tasks;
  const id = `t${tasks.length + 1}`;
  return [
    ...tasks,
    {
      id,
      description:
        "Check that the parts your teammates built fit together, and fix what doesn't: every file a page links (stylesheets, scripts, images) exists under that name, " +
        "the page's requests match the server's routes, and the run steps in the README work.",
      status: "pending",
      role: owner,
      assignedTo: owner,
      dependsOn: tasks.map((t) => t.id),
      handoffTo: [],
    },
  ];
}

const routePrompt = (goal: string, history: Exchange[]) =>
  `Read the user's message and answer with ONE line, in one of these forms:\n` +
  `work\nquestion: <the question, restated so it stands alone>\nchat: <your short, friendly reply>\n\n` +
  `"work" = they want something built, changed, fixed or run. "question" = they want to know something and nothing needs to change. "chat" = a greeting, thanks or small talk.\n\n` +
  historyBlock(history) +
  `User's message: ${goal}\n\nYour line:`;

const linesPrompt = (goal: string, ready: RoleInfo[], history: Exchange[], unfinished: string[], correction?: string) =>
  `You lead a small team of coding agents on this computer. Split the user's request between the teammates.\n\n` +
  `Teammates:\n${ready.map((r) => `  ${r.id} — ${r.role}${r.description ? ` (${r.description.slice(0, 80)})` : ""}`).join("\n")}\n\n` +
  `Rules:\n` +
  `- Write one line per teammate, exactly in the form  <id>: <their task>\n` +
  `- Each task names the files to create or change and what goes in them, e.g. "frontend: create index.html (hero, menu, contact) and styles.css (palette, fonts, responsive layout)".\n` +
  `- Give each teammate the part that matches their role. Write "<id>: -" for a teammate with nothing to do.\n` +
  `- Only what the user asked for: no research, review or testing tasks unless asked. If they want it deployment-ready, someone writes the server, a package.json start script and a README with run steps.\n\n` +
  historyBlock(history) +
  boardBlock(unfinished) +
  `User's request: ${goal}\n\n` +
  (correction ? `Your previous answer couldn't be used: ${correction}. Use the exact form above.\n\n` : "") +
  `Your lines:`;

// The planner for a lead on a small local model, in the stages such a model can do: say what kind of
// message it is (one line), then give each ready teammate one line of work. niti builds the task graph
// from the lines itself — parallel parts, then an integration task — instead of asking a 7B model for
// a JSON DAG it gets wrong half the time. When the lines still don't come, the deterministic role plan
// splits the goal by role: never the whole goal on the lead while the team waits.
async function makeLocalPlan(lead: PlannerAgent, goal: string, roles: RoleInfo[], history: Exchange[], unfinished: string[]): Promise<Plan> {
  const route = parseRoute(await lead.ask(routePrompt(goal, history), { plan: true }), goal);
  if (route.kind === "chat") return { goal, tasks: [], reply: route.reply };
  if (route.kind === "question") return { goal, tasks: [], question: route.question };
  const ready = roles.filter((r) => r.ready !== false);
  const leadId = ready.find((r) => r.id === lead.config.id)?.id ?? ready[0]?.id ?? lead.config.id;
  if (ready.length <= 1) return { goal, tasks: [{ id: "t1", description: goal, status: "pending", role: leadId, assignedTo: leadId, dependsOn: [], handoffTo: [] }] };
  let correction: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await lead.ask(linesPrompt(goal, ready, history, unfinished, correction), { plan: true });
    const lines = parsePlanLines(raw, ready.map((r) => r.id));
    const ids = Object.keys(lines);
    if (ids.length === 0) {
      correction = `no line started with a teammate id (${ready.map((r) => r.id).join(", ")})`;
      continue;
    }
    // Each part carries the whole request: the shop's name, the look it should have, what "done" means.
    const tasks: TaskNode[] = ready
      .filter((r) => lines[r.id])
      .map((r, i) => ({ id: `t${i + 1}`, description: `${lines[r.id]}\n\n(Part of the request: ${goal})`, status: "pending", role: r.id, assignedTo: r.id, dependsOn: [], handoffTo: [] }));
    return { goal, tasks: withIntegration(tasks, leadId) };
  }
  return { goal, tasks: rolePlan(goal, roles, leadId), fallback: `${lead.config.id} couldn't split the work (${correction}) — split by role instead` };
}

// A plan from a lead that ignored "answers and reviews only": a file-changing task on a chat-only
// teammate goes to the ready teammate whose role fits it best.
export function keepOffChatOnly(plan: Plan, roles: RoleInfo[]): Plan {
  const ready = roles.filter((r) => r.ready !== false);
  const chatOnly = new Set(roles.filter((r) => r.ready === false).map((r) => r.id));
  if (!chatOnly.size || !ready.length) return plan;
  const score = (r: RoleInfo, text: string) => ROLE_WORDS.reduce((n, [role, words]) => n + (role.test(`${r.role} ${r.id}`) && words.test(text) ? 1 : 0), 0);
  const tasks = plan.tasks.map((t) => {
    if (!chatOnly.has(t.role) || /^\s*(review|answer|explain|summari[sz]e|look at|check)\b/i.test(t.description)) return t;
    const owner = ready.map((r) => ({ id: r.id, s: score(r, t.description) })).sort((a, b) => b.s - a.s)[0]!.id;
    return { ...t, role: owner, assignedTo: owner };
  });
  return { ...plan, tasks };
}

// Ask the orchestrator agent for a plan, validating + normalizing. Retries on invalid JSON, then
// falls back to a single task (the whole goal on the lead) — a bad plan never crashes the run. A
// provider that cannot answer at all (a bad key, no network, an interrupt) is not a bad plan: it
// throws out of here, rather than handing the whole goal to the same failing model as a task.
export async function makePlan(lead: PlannerAgent, goal: string, roles: RoleInfo[], history: Exchange[] = [], unfinished: string[] = []): Promise<Plan> {
  // An Agent's config carries its provider; a bare PlannerAgent (tests) has none and plans as standard.
  const cfg = lead.config as { provider?: string; profile?: "local" | "standard" };
  const profile = profileFor({ provider: cfg.provider ?? "", profile: cfg.profile });
  const local = profile.name === "local";
  if (local) {
    try {
      return await makeLocalPlan(lead, goal, roles, history, unfinished);
    } catch (err) {
      // A lead that can't answer at all is the provider failing, not a bad plan (see below); but a
      // half-made local plan still has a deterministic answer.
      if (!/interrupted/i.test(String(err))) return { goal, tasks: rolePlan(goal, roles, lead.config.id), fallback: `the planner failed: ${summarizeError(err)}` };
      throw err;
    }
  }
  let correction: string | undefined;
  let answered = false;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_PLAN_ATTEMPTS; attempt++) {
    let raw: string;
    try {
      raw = await lead.ask(plannerPrompt(goal, roles, correction, history, unfinished), { json: true });
      answered = true;
    } catch (err) {
      lastError = err;
      correction = summarizeError(err);
      continue;
    }
    const json = extractJson(raw);
    const parsed = RawPlan.safeParse(json);
    if (!parsed.success) {
      correction = 'expected {"reply": ...}, {"question": ...}, or an array of task objects';
      continue;
    }
    const data = parsed.data;
    if (!Array.isArray(data) && "reply" in data) return { goal, tasks: [], reply: data.reply };
    if (!Array.isArray(data) && "question" in data) return { goal, tasks: [], question: data.question };
    const rawTasks = Array.isArray(data) ? data : data.tasks;
    if (!rawTasks.length) {
      correction = "the task array was empty";
      continue;
    }
    return keepOffChatOnly(normalizePlan(goal, rawTasks, roles), roles);
  }
  if (!answered) throw lastError;
  // Fallback: the goal split by role (rolePlan) — a team whose roles say nothing about the work gets
  // it as one task on the lead.
  return { fallback: correction ?? "no usable plan", goal, tasks: rolePlan(goal, roles, lead.config.id) };
}

const RawRemediation = z.object({
  action: z.enum(["retry", "redirect", "inject", "accept"]),
  description: z.string().optional(), // retry/redirect: a clearer restatement of the task
  role: z.string().optional(), // redirect: teammate id to hand the task to instead
  tasks: z.array(RawTask).optional(), // inject: freestanding remediation tasks, same shape as a plan
  reason: z.string().optional(),
});
type RemediationPlan = z.infer<typeof RawRemediation>;

const MAX_REPLAN_PLANNER_ATTEMPTS = 2; // a recovery call, not a full plan — cheaper retry budget than makePlan's

function replanPrompt(ctx: { goal: string; roles: RoleInfo[]; board: string; failed: TaskNode; error: string }, correction?: string): string {
  const roster = ctx.roles.map((r) => `  - id "${r.id}" — role: ${r.role}${r.description ? ` (${r.description})` : ""}`).join("\n");
  return (
    `You are the orchestrator of a team of AI coding agents. A task in the current plan failed. Decide how to recover.\n\n` +
    `Goal: ${ctx.goal}\n\n` +
    `Teammates:\n${roster}\n\n` +
    `Current task board:\n${ctx.board}\n\n` +
    `Failed task ${ctx.failed.id} (${ctx.failed.role}): ${ctx.failed.description}\n` +
    `Error: ${ctx.error}\n\n` +
    `Choose ONE recovery action:\n` +
    `- "retry": the same task should run again, optionally with a clearer "description".\n` +
    `- "redirect": a different teammate ("role" = their id) should attempt it instead.\n` +
    `- "inject": add new remediation "tasks" (same shape as a plan: description/role/dependsOn/handoffTo/acceptance) ` +
    `to work around the failure; the original task stays failed.\n` +
    `- "accept": no recovery is possible; let the failure stand.\n\n` +
    `Return ONLY JSON: {"action": "...", "description"?, "role"?, "tasks"?: [...], "reason"?: "why"}. No prose.` +
    (correction ? `\n\nYour previous reply was invalid: ${correction}. Return valid JSON only.` : "")
  );
}

// Ask the lead how to recover from a failed task. Never throws — a bad or missing model reply
// degrades to {action: "accept"}, which lets the failure cascade exactly as it does today.
export async function replan(
  lead: PlannerAgent,
  ctx: { goal: string; roles: RoleInfo[]; board: string; failed: TaskNode; error: string },
): Promise<RemediationPlan> {
  let correction: string | undefined;
  for (let attempt = 0; attempt < MAX_REPLAN_PLANNER_ATTEMPTS; attempt++) {
    let raw: string;
    try {
      raw = await lead.ask(replanPrompt(ctx, correction), { json: true });
    } catch (err) {
      correction = summarizeError(err);
      continue;
    }
    const parsed = RawRemediation.safeParse(extractJson(raw));
    if (!parsed.success) {
      correction = `expected {"action": "retry"|"redirect"|"inject"|"accept", ...}`;
      continue;
    }
    return parsed.data;
  }
  return { action: "accept" };
}
