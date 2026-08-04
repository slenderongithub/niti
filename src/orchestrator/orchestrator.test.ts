import { test, expect } from "bun:test";
import { Orchestrator } from "./orchestrator.ts";
import { Bus } from "../events/bus.ts";
import { Agent, type AgentConfig } from "../agent/agent.ts";
import type { Provider } from "../providers/provider.ts";

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
