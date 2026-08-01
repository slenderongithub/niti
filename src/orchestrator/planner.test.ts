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
