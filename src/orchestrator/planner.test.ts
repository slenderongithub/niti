import { test, expect } from "bun:test";
import { extractJson, normalizePlan, makePlan, replan, type RoleInfo, type PlannerAgent } from "./planner.ts";

const roles: RoleInfo[] = [
  { id: "frontend", role: "Frontend Designer" },
  { id: "backend", role: "Backend Engineer" },
];

function fakeLead(replies: string[]): PlannerAgent {
  let i = 0;
  return { config: { id: "orchestrator" }, ask: async () => replies[Math.min(i++, replies.length - 1)]! };
}

test("extractJson pulls a JSON array out of prose and code fences", () => {
  const raw = 'Sure! Here is the plan:\n```json\n[{"description":"x","role":"frontend"}]\n```\nDone.';
  expect(extractJson(raw)).toEqual([{ description: "x", role: "frontend" }]);
});

test("extractJson returns undefined on non-JSON", () => {
  expect(extractJson("no json here")).toBeUndefined();
});

test("extractJson survives brackets inside string values and lead-in prose", () => {
  const withStrBrackets = '[{"description":"return arr[i] then close ]","role":"backend"}]';
  expect(extractJson(withStrBrackets)).toEqual([{ description: "return arr[i] then close ]", role: "backend" }]);
  const withProse = 'Here is the plan [as requested]: [{"description":"x","role":"dev"}]';
  expect(extractJson(withProse)).toEqual([{ description: "x", role: "dev" }]);
});

test("normalizePlan maps role names to ids, assigns stable ids, remaps and de-self deps", () => {
  const raw = [
    { id: "a", description: "design the UI", role: "Frontend Designer", handoffTo: ["Backend Engineer"] },
    { id: "b", description: "build the API", role: "backend", dependsOn: ["a", "b"] },
  ];
  const plan = normalizePlan("goal", raw as any, roles);
  expect(plan.tasks[0]).toMatchObject({ id: "t1", role: "frontend", handoffTo: ["backend"], dependsOn: [] });
  expect(plan.tasks[1]).toMatchObject({ id: "t2", role: "backend", dependsOn: ["t1"] }); // 'a'→t1, self 'b' dropped
});

test("normalizePlan falls back to the first role for an unknown assignee", () => {
  const plan = normalizePlan("goal", [{ description: "x", role: "nobody" }] as any, roles);
  expect(plan.tasks[0]!.role).toBe("frontend");
});

test("normalizePlan keeps a dependency when a model id collides with a positional id", () => {
  // Model labels its first task "t2"; the second depends on "t2" (meaning that first task).
  const raw = [
    { id: "t2", description: "design UI", role: "frontend" },
    { id: "impl", description: "build", role: "backend", dependsOn: ["t2"] },
  ];
  const plan = normalizePlan("goal", raw as any, roles);
  expect(plan.tasks[0]!.id).toBe("t1"); // "t2" → positional t1
  expect(plan.tasks[1]!.dependsOn).toEqual(["t1"]); // dep resolves to the design task, not dropped
});

test("normalizePlan drops a dependency that references a duplicate/ambiguous model-supplied id instead of mis-binding it", () => {
  // Two tasks both use the model-supplied id "x". A dependsOn:["x"] reference is now ambiguous —
  // it must be dropped, not silently resolved to whichever task's mapping happened to win.
  const raw = [
    { id: "x", description: "task one", role: "frontend", dependsOn: ["x"] }, // self-ref, should drop regardless
    { id: "x", description: "task two", role: "backend", dependsOn: [] },
  ];
  const plan = normalizePlan("goal", raw as any, roles);
  expect(plan.tasks[0]!.dependsOn).toEqual([]); // NOT ["t2"] — must not fabricate a dependency
});

test("normalizePlan drops an unknown handoffTo target instead of redirecting it to agent 0", () => {
  const plan = normalizePlan("goal", [{ description: "x", role: "frontend", handoffTo: ["qa-bot", "Backend Engineer"] }] as any, roles);
  expect(plan.tasks[0]!.handoffTo).toEqual(["backend"]); // qa-bot dropped, real role kept
});

test("makePlan accepts a valid plan on the first try", async () => {
  const lead = fakeLead(['[{"description":"design","role":"frontend"},{"description":"api","role":"backend","dependsOn":[]}]']);
  const plan = await makePlan(lead, "build a store", roles);
  expect(plan.tasks.length).toBe(2);
  expect(plan.tasks.map((t) => t.role)).toEqual(["frontend", "backend"]);
});

test("makePlan retries after invalid JSON then succeeds", async () => {
  const lead = fakeLead(["garbage, no json", '[{"description":"just do it","role":"backend"}]']);
  const plan = await makePlan(lead, "goal", roles);
  expect(plan.tasks.length).toBe(1);
  expect(plan.tasks[0]!.role).toBe("backend");
});

test("makePlan falls back to a single whole-goal task after repeated invalid output", async () => {
  const lead = fakeLead(["nope"]);
  const plan = await makePlan(lead, "the whole goal", roles);
  expect(plan.tasks.length).toBe(1);
  expect(plan.tasks[0]).toMatchObject({ id: "t1", description: "the whole goal", role: "orchestrator" });
});

test("replan returns a parsed action from the lead", async () => {
  const lead = fakeLead(['{"action":"retry","description":"try again with more context"}']);
  const failed = { id: "t1", role: "backend", description: "build the API" } as any;
  const plan = await replan(lead, { goal: "build a store", roles, board: "t1 [failed] backend: build the API", failed, error: "connection refused" });
  expect(plan).toMatchObject({ action: "retry", description: "try again with more context" });
});

test("replan falls back to accept after repeated invalid output", async () => {
  const lead = fakeLead(["not json"]);
  const failed = { id: "t1", role: "backend", description: "x" } as any;
  const plan = await replan(lead, { goal: "goal", roles, board: "", failed, error: "boom" });
  expect(plan).toEqual({ action: "accept" });
});

test("a greeting routes to a reply and a question to an answer — neither becomes tasks", async () => {
  const hi = await makePlan(fakeLead(['{"reply":"Hi! What should we build?"}']), "hi", roles);
  expect(hi.reply).toBe("Hi! What should we build?");
  expect(hi.tasks).toEqual([]);
  const q = await makePlan(fakeLead(['{"question":"Where is auth handled?"}']), "where's auth?", roles);
  expect(q.question).toBe("Where is auth handled?");
  expect(q.tasks).toEqual([]);
});

test("the planner sees recent exchanges, so a follow-up can refer back", async () => {
  let seen = "";
  const lead: PlannerAgent = { config: { id: "orchestrator" }, ask: async (p) => ((seen = p), '[{"description":"add tests","role":"backend"}]') };
  await makePlan(lead, "now add tests for it", roles, [{ goal: "build a cart", outcome: "Built src/cart.ts with total()" }]);
  expect(seen).toContain("build a cart");
  expect(seen).toContain("Built src/cart.ts");
  expect(seen).toContain("now add tests for it");
  expect(seen).toContain("never invent work"); // the old prompt forced 2-6 tasks out of anything
});

test("a follow-up is planned against the unfinished board, so it adjusts the plan instead of replacing it blind", async () => {
  let seen = "";
  const lead: PlannerAgent = { config: { id: "orchestrator" }, ask: async (p) => ((seen = p), '[{"description":"b","role":"backend"}]') };
  await makePlan(lead, "skip the first one", roles, [], ["t1 (frontend, failed): build the header", "t2 (backend, pending): add the API"]);
  expect(seen).toContain("Unfinished tasks from the current plan");
  expect(seen).toContain("t2 (backend, pending): add the API");
  expect(seen).toContain("keep the tasks the user still wants");
});

const team = [
  { id: "frontend", role: "Frontend", description: "Owns the UI" },
  { id: "backend", role: "Backend", description: "Owns the server and API" },
];
const localLead = (replies: string[], seen: string[] = []) => {
  let i = 0;
  return { config: { id: "backend", provider: "local" }, ask: async (p: string) => (seen.push(p), replies[Math.min(i++, replies.length - 1)]!) };
};

test("a local lead plans in lines: one per teammate, built into parallel parts and an integration task", async () => {
  const seen: string[] = [];
  const goal = "make me a stunning coffee shop landing page for Bean There, end-to-end deployment ready";
  const plan = await makePlan(localLead(["work", "**frontend**: create index.html and styles.css\n- backend: create server.js and package.json with a start script"], seen) as never, goal, team);
  expect(plan.fallback).toBeUndefined();
  expect(plan.tasks.map((t) => [t.id, t.assignedTo, t.dependsOn])).toEqual([["t1", "frontend", []], ["t2", "backend", []], ["t3", "backend", ["t1", "t2"]]]);
  expect(plan.tasks[0]!.description).toContain("Bean There"); // each part carries the whole request
  expect(seen[1]).toContain("<id>: <their task>");
});

test("a local lead routes chat and questions in one line", async () => {
  expect((await makePlan(localLead(["chat: Hey! What are we building?"]) as never, "hi", team)).reply).toBe("Hey! What are we building?");
  expect((await makePlan(localLead(["question: where is the menu data?"]) as never, "where's the menu data", team)).question).toBe("where is the menu data?");
  // An answer in no known form is read by the message's shape.
  expect((await makePlan(localLead(["Sure thing!"]) as never, "hello", team)).reply).toBeDefined();
});

test("a local lead that can't split the work: the goal is split by role, never all on the lead", async () => {
  const goal = "make me a stunning coffee shop landing page, end-to-end deployment ready";
  const plan = await makePlan(localLead(["work", "I will start by designing the layout. Then the server."]) as never, goal, team);
  expect(plan.fallback).toContain("split by role");
  expect(plan.tasks.map((t) => t.assignedTo)).toEqual(["frontend", "backend", "backend"]);
  expect(plan.tasks[0]!.description).toContain("the pages and their look");
  expect(plan.tasks[1]!.description).toContain("package.json with a start script");
  // A page with no server or deployment asked for doesn't get one invented.
  expect((await makePlan(localLead(["work", "?"]) as never, "make a landing page", team)).tasks.map((t) => t.assignedTo)).toEqual(["frontend"]);
});

test("chat-only teammates never get work that changes files", async () => {
  const roles = [...team, { id: "reviewer", role: "Frontend helper", ready: false }];
  const seen: string[] = [];
  await makePlan(localLead(["work", "frontend: index.html\nbackend: server.js"], seen) as never, "build a site with an api", roles);
  expect(seen[1]).not.toContain("reviewer"); // not offered work at all
  const { keepOffChatOnly } = await import("./planner.ts");
  const t = (role: string, description: string) => ({ id: "t1", description, status: "pending" as const, role, assignedTo: role, dependsOn: [], handoffTo: [] });
  const plan = keepOffChatOnly({ goal: "g", tasks: [t("reviewer", "Create the stylesheet for the page"), t("reviewer", "Review the server code")] }, roles);
  expect(plan.tasks.map((x) => x.assignedTo)).toEqual(["frontend", "reviewer"]);
});

test("a plan that falls back says why", async () => {
  const lead = { config: { id: "lead" }, ask: async () => "Sure! Here is my plan: first I will…" };
  // (a cloud lead: its fallback is the same role split, which for a one-person team is the goal)
  const plan = await makePlan(lead as never, "build it", [{ id: "lead", role: "Lead" }]);
  expect(plan.tasks.length).toBe(1);
  expect(plan.fallback).toContain("expected");
});
