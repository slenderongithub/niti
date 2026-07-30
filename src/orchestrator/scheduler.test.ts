import { test, expect } from "bun:test";
import { schedule, detectCycle, type OrchestrationEvent } from "./scheduler.ts";
import { MessageBus, type AgentMessage } from "../messaging/message-bus.ts";
import type { TaskNode } from "./task.ts";
import type { Agent } from "../agent/agent.ts";

function node(p: Partial<TaskNode> & { id: string; role: string; description: string }): TaskNode {
  return { status: "pending", dependsOn: [], handoffTo: [], ...p };
}

interface FakeOpts {
  fail?: boolean;
  output?: string;
  active?: { n: number; max: number };
}

function fakeAgent(id: string, role: string, order: string[], opts: FakeOpts = {}): Agent {
  const a: any = {
    config: { id, role },
    output: "",
    async run(_prompt: string) {
      order.push(id);
      if (opts.active) {
        opts.active.n++;
        opts.active.max = Math.max(opts.active.max, opts.active.n);
        await new Promise((r) => setTimeout(r, 10));
        opts.active.n--;
      }
      a.output = opts.output ?? `${id} output`;
      return opts.fail ? "failed" : "done";
    },
    async ask(_p: string) {
      return "integration summary";
    },
    async respond() {
      return "resp";
    },
  };
  return a as Agent;
}

test("detectCycle finds a back-edge and clears an acyclic graph", () => {
  const cyclic = [node({ id: "t1", role: "a", description: "", dependsOn: ["t2"] }), node({ id: "t2", role: "b", description: "", dependsOn: ["t1"] })];
  expect(detectCycle(cyclic)).toBeDefined();
  const acyclic = [node({ id: "t1", role: "a", description: "" }), node({ id: "t2", role: "b", description: "", dependsOn: ["t1"] })];
  expect(detectCycle(acyclic)).toBeUndefined();
});

test("schedule rejects a dependency cycle with a clear error", async () => {
  const tasks = [node({ id: "t1", role: "a", description: "", dependsOn: ["t2"] }), node({ id: "t2", role: "a", description: "", dependsOn: ["t1"] })];
  await expect(schedule(tasks, [fakeAgent("a", "A", [])])).rejects.toThrow(/cycle/);
});

test("schedule runs tasks in dependency order", async () => {
  const order: string[] = [];
  const tasks = [
    node({ id: "t1", role: "fe", description: "design" }),
    node({ id: "t2", role: "be", description: "api", dependsOn: ["t1"] }),
  ];
  await schedule(tasks, [fakeAgent("fe", "FE", order), fakeAgent("be", "BE", order)]);
  expect(order).toEqual(["fe", "be"]);
  expect(tasks.every((t) => t.status === "done")).toBe(true);
});

test("independent tasks run concurrently (two agents active at once)", async () => {
  const order: string[] = [];
  const active = { n: 0, max: 0 };
  const tasks = [node({ id: "t1", role: "fe", description: "a" }), node({ id: "t2", role: "be", description: "b" })];
  await schedule(tasks, [fakeAgent("fe", "FE", order, { active }), fakeAgent("be", "BE", order, { active })]);
  expect(active.max).toBe(2);
});

test("a completed task hands its output to downstream teammates as a message", async () => {
  const order: string[] = [];
  const mb = new MessageBus();
  mb.register("fe");
  mb.register("be");
  const seen: AgentMessage[] = [];
  mb.subscribe((m) => seen.push(m));
  const tasks = [
    node({ id: "t1", role: "fe", description: "design", handoffTo: ["be"], output: "the mockups" }),
    node({ id: "t2", role: "be", description: "api", dependsOn: ["t1"] }),
  ];
  await schedule(tasks, [fakeAgent("fe", "FE", order, { output: "the mockups" }), fakeAgent("be", "BE", order)], { messageBus: mb });
  const artifact = seen.find((m) => m.kind === "artifact");
  expect(artifact?.from).toBe("fe");
  expect(artifact?.to).toBe("be");
  expect(artifact?.body).toBe("the mockups");
});

test("a task whose prerequisite failed is skipped, not run", async () => {
  const order: string[] = [];
  const tasks = [
    node({ id: "t1", role: "fe", description: "design" }),
    node({ id: "t2", role: "be", description: "api", dependsOn: ["t1"] }),
  ];
  await schedule(tasks, [fakeAgent("fe", "FE", order, { fail: true }), fakeAgent("be", "BE", order)]);
  expect(tasks[0]!.status).toBe("failed");
  expect(tasks[1]!.status).toBe("failed");
  expect(order).toEqual(["fe"]); // be never ran
});

test("schedule keeps messaging open (allowAll) — an agent not wired by dependsOn/handoffTo can still be reached", async () => {
  // Coordination is intentionally NOT restricted to the plan's declared edges: the planner can't
  // anticipate every mid-task question (that's the point of ask_agent), so any registered teammate
  // must remain reachable. Only the MAX_PER_PAIR rate cap (tested in message-bus.test.ts) applies.
  const order: string[] = [];
  const mb = new MessageBus();
  mb.register("frontend");
  mb.register("backend");
  mb.register("qa"); // unrelated to this plan's dependsOn/handoffTo graph
  const tasks = [
    node({ id: "t1", role: "frontend", description: "design" }),
    node({ id: "t2", role: "backend", description: "api", dependsOn: ["t1"] }),
    node({ id: "t3", role: "qa", description: "unrelated" }),
  ];
  await schedule(tasks, [fakeAgent("frontend", "FE", order), fakeAgent("backend", "BE", order), fakeAgent("qa", "QA", order)], { messageBus: mb });

  expect(mb.post({ from: "frontend", to: "backend", kind: "question", subject: "x", body: "" }).ok).toBe(true);
  expect(mb.post({ from: "qa", to: "frontend", kind: "question", subject: "x", body: "" }).ok).toBe(true); // still reachable
});

test("cancellation stops a retry loop instead of launching another exhausted attempt", async () => {
  const order: string[] = [];
  let calls = 0;
  const agent: any = {
    config: { id: "a", role: "A" },
    output: "",
    async run() {
      calls++;
      order.push("a");
      return "exhausted";
    },
  };
  const tasks = [node({ id: "t1", role: "a", description: "x" })];
  await schedule(tasks, [agent], { shouldStop: () => calls >= 1 }); // stop as soon as the first attempt exhausts
  expect(calls).toBe(1); // no retry launched after cancellation
  expect(tasks[0]!.status).toBe("failed");
});

test("the lead runs an integrate pass and completion is reported", async () => {
  const order: string[] = [];
  const events: OrchestrationEvent[] = [];
  const lead = fakeAgent("orchestrator", "Orchestrator", order);
  const tasks = [node({ id: "t1", role: "fe", description: "x" })];
  await schedule(tasks, [fakeAgent("fe", "FE", order)], { lead, onOrchestration: (e) => events.push(e) });
  const integrate = events.find((e) => e.type === "integrate");
  const complete = events.find((e) => e.type === "complete");
  expect(integrate).toMatchObject({ type: "integrate", summary: "integration summary" });
  expect(complete).toMatchObject({ type: "complete", completed: 1, total: 1 });
});

test("a cancelled run skips the integrate pass (no extra unabortable model call) but still reports complete", async () => {
  const order: string[] = [];
  const events: OrchestrationEvent[] = [];
  let asked = false;
  const lead: any = { config: { id: "orchestrator", role: "Orchestrator" }, output: "", async run() { return "done"; }, async ask() { asked = true; return "should not run"; } };
  const tasks = [node({ id: "t1", role: "fe", description: "x" })];
  await schedule(tasks, [fakeAgent("fe", "FE", order)], { lead, onOrchestration: (e) => events.push(e), shouldStop: () => true });
  expect(asked).toBe(false);
  expect(events.find((e) => e.type === "integrate")).toBeUndefined();
  expect(events.find((e) => e.type === "complete")).toBeDefined();
});
