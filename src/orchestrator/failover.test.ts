import { test, expect } from "bun:test";
import { Orchestrator } from "./orchestrator.ts";
import { Bus } from "../events/bus.ts";
import { Agent, type AgentConfig } from "../agent/agent.ts";
import { runWorker } from "./runner.ts";
import type { Provider } from "../providers/provider.ts";

const cfg: AgentConfig = { id: "a", provider: "anthropic", model: "x", role: "r", systemPrompt: "s", allowedTools: [] };

test("agent.run classifies a 429 as exhaustion", async () => {
  const rateLimited: Provider = {
    async send() {
      throw Object.assign(new Error("rate limit"), { status: 429 });
    },
  };
  const outcome = await new Agent(cfg, rateLimited, new Bus()).run("do it");
  expect(outcome).toBe("exhausted");
});

test("an exhausted task is requeued and retried, then failed after the attempt cap", async () => {
  const bus = new Bus();
  const orch = new Orchestrator();
  orch.addTask("build the thing");

  let failovers = 0;
  bus.subscribe((e) => {
    if (e.type === "failover") failovers++;
  });

  const alwaysExhausts: Provider = {
    async send() {
      throw Object.assign(new Error("overloaded"), { status: 529 });
    },
  };
  await runWorker(new Agent(cfg, alwaysExhausts, bus), orch, bus);

  const task = orch.all[0]!;
  expect(task.status).toBe("failed"); // gave up after the cap
  expect(task.attempts).toBe(3); // requeued 3 times
  expect(failovers).toBe(3); // one failover event per reassignment
});

test("a healthy agent completes a task requeued by an exhausted one", async () => {
  const bus = new Bus();
  const orch = new Orchestrator();
  const task = orch.addTask("ship it");

  const exhausted = new Agent(cfg, { async send() { throw Object.assign(new Error("rl"), { status: 429 }); } }, bus);
  const healthy = new Agent({ ...cfg, id: "b" }, { async send() { return { text: "ok", toolCalls: [] }; } }, bus);

  // A exhausts and requeues; B then claims the requeued task and finishes it.
  expect(await exhausted.run(task.description)).toBe("exhausted");
  orch.requeue(orch.claimTask("a")!, "a");
  expect(task.status).toBe("pending");

  const claimed = orch.claimTask("b")!;
  expect(await healthy.run(claimed.description)).toBe("done");
  orch.complete(claimed, true);
  expect(task.status).toBe("done");
  expect(task.attempts).toBe(1);
});

test("regression: the failing agent cannot immediately reclaim its own requeued task", () => {
  const orch = new Orchestrator();
  const task = orch.addTask("do it");
  orch.claimTask("a");
  orch.requeue(task, "a");

  // The exact bug from production: agent A's own next poll must NOT get the task back —
  // it should go to a different agent if one is available.
  expect(orch.claimTask("a")).toBeUndefined();
  expect(orch.claimTask("b")).toBe(task); // a different agent claims it immediately, no backoff wait
});

test("a lone agent can eventually reclaim its own task once the backoff passes", async () => {
  const orch = new Orchestrator();
  const task = orch.addTask("do it");
  orch.claimTask("a");
  orch.requeue(task, "a"); // backoff is attempts(1) * 500ms = 500ms

  expect(orch.claimTask("a")).toBeUndefined(); // too soon
  await new Promise((r) => setTimeout(r, 550));
  expect(orch.claimTask("a")).toBe(task); // backoff elapsed, no other agent exists
});
