import { test, expect } from "bun:test";
import { schedule as realSchedule, detectCycle, type OrchestrationEvent } from "./scheduler.ts";
import { MessageBus, type AgentMessage } from "../messaging/message-bus.ts";
import type { TaskNode } from "./task.ts";
import type { Agent } from "../agent/agent.ts";

// The fakes in this file implement run(); the scheduler calls runDetailed(), which returns the
// text belonging to that specific call rather than reading the agent's shared `output`. One
// adapter here beats bolting the method onto every fake below.
function detailed(a: any): any {
  if (!a.runDetailed) {
    a.runDetailed = async (prompt: string) => {
      const outcome = await a.run(prompt);
      return { outcome, text: a.output ?? "", error: outcome === "done" ? "" : (a.error ?? "") };
    };
  }
  return a;
}
const schedule: typeof realSchedule = (tasks, agents, deps) => realSchedule(tasks, agents.map(detailed), deps);

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
    error: "",
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

test("a failed task is rescued by a retry replan from the lead", async () => {
  const events: OrchestrationEvent[] = [];
  let calls = 0;
  const fe: any = {
    config: { id: "fe", role: "FE" },
    output: "",
    error: "boom",
    async run() {
      calls++;
      if (calls === 1) return "failed";
      fe.output = "fixed";
      return "done";
    },
  };
  const lead: any = {
    config: { id: "orchestrator", role: "Orchestrator" },
    output: "",
    async run() {
      return "done";
    },
    async ask(prompt: string) {
      return prompt.includes("recover") ? '{"action":"retry"}' : "integration summary";
    },
  };
  const tasks = [node({ id: "t1", role: "fe", description: "x" })];
  await schedule(tasks, [fe], { lead, onOrchestration: (e) => events.push(e) });
  expect(calls).toBe(2);
  expect(tasks[0]!.status).toBe("done");
  expect(events.some((e) => e.type === "replan" && e.action === "retry")).toBe(true);
});

test("a redirect replan frees the original agent's slot instead of orphaning it", async () => {
  // Regression test: t.role mutates mid-flight on redirect. If the running-map key isn't captured
  // before the mutation, the original agent's slot is never freed and the scheduler spins forever
  // (an already-settled promise still satisfies Promise.race, so this hangs rather than crashing).
  const order: string[] = [];
  let feCalls = 0;
  const fe: any = {
    config: { id: "fe", role: "FE" },
    output: "",
    error: "boom",
    async run() {
      feCalls++;
      order.push("fe");
      return "failed";
    },
  };
  const be: any = {
    config: { id: "be", role: "BE" },
    output: "",
    async run() {
      order.push("be");
      be.output = "rescued";
      return "done";
    },
  };
  const lead: any = {
    config: { id: "orchestrator", role: "Orchestrator" },
    output: "",
    async run() {
      return "done";
    },
    async ask(prompt: string) {
      return prompt.includes("recover") ? '{"action":"redirect","role":"be"}' : "integration summary";
    },
  };
  const tasks = [node({ id: "t1", role: "fe", description: "x" })];
  await schedule(tasks, [fe, be], { lead });
  expect(feCalls).toBe(1);
  expect(order).toEqual(["fe", "be"]);
  expect(tasks[0]!.status).toBe("done");
  expect(tasks[0]!.role).toBe("be");
});

test("an inject replan that would create a cycle is discarded, not applied", async () => {
  const fe: any = {
    config: { id: "fe", role: "FE" },
    output: "",
    error: "boom",
    async run() {
      return "failed";
    },
  };
  const lead: any = {
    config: { id: "orchestrator", role: "Orchestrator" },
    output: "",
    async run() {
      return "done";
    },
    async ask(prompt: string) {
      if (!prompt.includes("recover")) return "integration summary";
      return JSON.stringify({
        action: "inject",
        tasks: [
          { id: "a", description: "fix a", role: "fe", dependsOn: ["b"] },
          { id: "b", description: "fix b", role: "fe", dependsOn: ["a"] },
        ],
      });
    },
  };
  const tasks = [node({ id: "t1", role: "fe", description: "x" })];
  await schedule(tasks, [fe], { lead });
  expect(tasks.length).toBe(1); // the cyclic injected batch never made it into the DAG
  expect(tasks[0]!.status).toBe("failed");
});

test("a configured reviewer approves a completed task before it's marked done, posting feedback over the message bus", async () => {
  const events: OrchestrationEvent[] = [];
  const mb = new MessageBus();
  mb.register("fe");
  mb.register("qa");
  const seen: AgentMessage[] = [];
  mb.subscribe((m) => seen.push(m));
  const fe: any = {
    config: { id: "fe", role: "FE", reviewer: "qa" },
    output: "",
    async run() {
      fe.output = "built it";
      return "done";
    },
  };
  const qa: any = {
    config: { id: "qa", role: "QA" },
    output: "",
    async run() {
      qa.output = "VERDICT: approve looks good";
      return "done";
    },
  };
  const tasks = [node({ id: "t1", role: "fe", description: "x" })];
  await schedule(tasks, [fe, qa], { messageBus: mb, onOrchestration: (e) => events.push(e) });
  expect(tasks[0]!.status).toBe("done");
  expect(events.filter((e) => e.type === "review").map((e: any) => e.phase)).toEqual(["requested", "approved"]);
  expect(seen.find((m) => m.kind === "review")).toMatchObject({ from: "qa", to: "fe" });
});

test("a reviewer's change request triggers one revision before approval", async () => {
  let feCalls = 0;
  let qaCalls = 0;
  const fe: any = {
    config: { id: "fe", role: "FE", reviewer: "qa" },
    output: "",
    async run() {
      feCalls++;
      fe.output = feCalls === 1 ? "first draft" : "revised";
      return "done";
    },
  };
  const qa: any = {
    config: { id: "qa", role: "QA" },
    output: "",
    async run() {
      qaCalls++;
      qa.output = qaCalls === 1 ? "VERDICT: changes_requested needs tests" : "VERDICT: approve";
      return "done";
    },
  };
  const tasks = [node({ id: "t1", role: "fe", description: "x" })];
  await schedule(tasks, [fe, qa]);
  expect(feCalls).toBe(2);
  expect(qaCalls).toBe(2);
  expect(tasks[0]!.status).toBe("done");
  expect(tasks[0]!.output).toBe("revised");
});

test("a persistently rejected task is marked failed after the review round cap", async () => {
  const fe: any = {
    config: { id: "fe", role: "FE", reviewer: "qa" },
    output: "",
    error: "",
    async run() {
      fe.output = "not good enough";
      return "done";
    },
  };
  const qa: any = {
    config: { id: "qa", role: "QA" },
    output: "",
    async run() {
      qa.output = "VERDICT: changes_requested still broken";
      return "done";
    },
  };
  const tasks = [node({ id: "t1", role: "fe", description: "x" })];
  await schedule(tasks, [fe, qa]);
  expect(tasks[0]!.status).toBe("failed");
});

test("a reviewer configured as its own assignee is a no-op (self-review is skipped)", async () => {
  const events: OrchestrationEvent[] = [];
  const fe: any = {
    config: { id: "fe", role: "FE", reviewer: "fe" },
    output: "",
    async run() {
      fe.output = "built it";
      return "done";
    },
  };
  const tasks = [node({ id: "t1", role: "fe", description: "x" })];
  await schedule(tasks, [fe], { onOrchestration: (e) => events.push(e) });
  expect(tasks[0]!.status).toBe("done");
  expect(events.some((e) => e.type === "review")).toBe(false);
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

test("the review gate fails closed: no explicit approval means the task is not accepted", async () => {
  const order: string[] = [];
  const fe = fakeAgent("fe", "FE", order, { output: "built it" });
  (fe as any).config.reviewer = "qa";
  // A reviewer whose text never contains a verdict — a clobbered, garbled or empty review. The old
  // test was "not literally changes_requested", so this passed the gate and shipped broken work.
  const qa: any = { config: { id: "qa", role: "QA" }, output: "some unrelated task output", async run() { return "done"; } };
  const tasks = [node({ id: "t1", role: "fe", description: "build" })];
  await schedule(tasks, [fe, qa]);
  expect(tasks[0]!.status).toBe("failed");
});

test("an explicit approval passes the gate", async () => {
  const order: string[] = [];
  const fe = fakeAgent("fe", "FE", order, { output: "built it" });
  (fe as any).config.reviewer = "qa";
  const qa: any = { config: { id: "qa", role: "QA" }, output: "looks right\nVERDICT: approve", async run() { return "done"; } };
  const tasks = [node({ id: "t1", role: "fe", description: "build" })];
  await schedule(tasks, [fe, qa]);
  expect(tasks[0]!.status).toBe("done");
});

test("an exhausted task fails over to a different agent, not the same one again", async () => {
  const tried: string[] = [];
  const a: any = { config: { id: "a", role: "A" }, output: "", async run() { tried.push("a"); return "exhausted"; } };
  const b: any = { config: { id: "b", role: "B" }, output: "b did it", async run() { tried.push("b"); return "done"; } };
  const tasks = [node({ id: "t1", role: "a", description: "x" })];
  await schedule(tasks, [a, b]);
  expect(tried).toEqual(["a", "b"]); // the idle teammate was actually tried
  expect(tasks[0]!.status).toBe("done");
  expect(tasks[0]!.assignedTo).toBe("b");
});
