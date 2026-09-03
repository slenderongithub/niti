import { test, expect } from "bun:test";
import { Orchestrator } from "./orchestrator.ts";
import { Bus } from "../events/bus.ts";
import { Agent, type AgentConfig } from "../agent/agent.ts";
import type { Provider } from "../providers/provider.ts";
import { runProject, takeApprovedPlan } from "./runner.ts";

// Stub provider: small delay forces the two workers to interleave, no network, no tool calls.
const stub: Provider = {
  async send() {
    await new Promise((r) => setTimeout(r, 5));
    return { text: "ok", toolCalls: [] };
  },
};

function makeAgent(id: string, bus: Bus): Agent {
  const cfg: AgentConfig = { id, provider: "anthropic", model: "x", role: "r", systemPrompt: "s" };
  return new Agent(cfg, stub, bus);
}

test("clear() drops all tasks but keeps id numbering moving forward", () => {
  const orch = new Orchestrator();
  orch.addTask("a");
  orch.addTask("b");
  orch.clear();
  expect(orch.all).toHaveLength(0);
  const t = orch.addTask("c");
  expect(t.id).toBe("t3"); // ids keep counting up, not reused
});

test("claimTask hands one task to one agent, and requeue excludes the agent that failed it", () => {
  // Orchestrator owns the shared board. This used to be covered only through runner.ts's `worker`,
  // which nothing in production called — so the coverage certified a code path that never ran.
  const orch = new Orchestrator();
  const t1 = orch.addTask("a");
  orch.addTask("b");

  const first = orch.claimTask("agent-1");
  expect(first?.id).toBe(t1.id);
  expect(orch.claimTask("agent-2")?.id).not.toBe(t1.id); // no double-claim

  orch.requeue(first!, "agent-1");
  expect(orch.claimTask("agent-1")).toBeUndefined(); // the failing agent cannot grab it straight back
  const t = orch.all.find((x) => x.id === t1.id)!;
  expect(t.status).toBe("pending");
  expect(t.attempts).toBe(1);
});

// --- PLAN mode → BUILD runs the reviewed DAG, not a second planning call -------------------

// A lead whose every ask() returns a fixed two-task plan, counting how often it was asked.
function countingLead(bus: Bus, calls: { n: number }): Agent {
  const provider: Provider = {
    async send() {
      calls.n++;
      return { text: '[{"description":"first","role":"lead"},{"description":"second","role":"lead","dependsOn":["1"]}]', toolCalls: [] };
    },
  };
  return new Agent({ id: "lead", provider: "anthropic", model: "x", role: "Lead", systemPrompt: "s", lead: true }, provider, bus);
}

test("PLAN mode tags the board, and BUILD on the same goal runs it without re-planning", async () => {
  const bus = new Bus();
  const calls = { n: 0 };
  const orch = new Orchestrator();
  const lead = countingLead(bus, calls);

  await runProject("ship the thing", [lead], orch, bus, { planOnly: true });
  expect(orch.all).toHaveLength(2);
  expect(orch.all.every((t) => t.status === "pending")).toBe(true);
  const planningCalls = calls.n;
  expect(planningCalls).toBeGreaterThan(0);

  await runProject("ship the thing", [lead], orch, bus, {});
  // Every task ran, and the planner was never asked a second time — the extra calls are the
  // tasks themselves plus the integrate pass, not another makePlan.
  expect(orch.all.every((t) => t.status === "done")).toBe(true);
  expect(takeApprovedPlan(orch, "ship the thing")).toBeUndefined(); // consumed, one-shot
});

test("takeApprovedPlan only claims an untouched board planned for that exact goal", () => {
  const orch = new Orchestrator();
  orch.load([{ id: "t1", description: "a", status: "pending", role: "lead", dependsOn: [] }]);
  expect(takeApprovedPlan(orch, "goal")).toBeUndefined(); // load() clears the tag

  orch.plannedGoal = "goal";
  expect(takeApprovedPlan(orch, "different goal")).toBeUndefined(); // wrong goal → plan afresh

  orch.plannedGoal = "goal";
  orch.all[0]!.status = "done";
  expect(takeApprovedPlan(orch, "goal")).toBeUndefined(); // already ran → not a virgin plan

  orch.all[0]!.status = "pending";
  expect(takeApprovedPlan(orch, "goal")).toHaveLength(1);
  expect(orch.plannedGoal).toBeUndefined();
});
