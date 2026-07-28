import { test, expect } from "bun:test";
import { Orchestrator } from "./orchestrator.ts";
import { Bus } from "../events/bus.ts";
import { Agent, type AgentConfig } from "../agent/agent.ts";
import { parseTaskList, runWorker } from "./runner.ts";
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

test("parseTaskList extracts a JSON string array, ignoring prose and non-strings", () => {
  expect(parseTaskList('Sure! ["a","b"]')).toEqual(["a", "b"]);
  expect(parseTaskList("no array here")).toEqual([]);
  expect(parseTaskList('[1,"b",true,"c"]')).toEqual(["b", "c"]);
});

test("clear() drops all tasks but keeps id numbering moving forward", () => {
  const orch = new Orchestrator();
  orch.addTask("a");
  orch.addTask("b");
  orch.clear();
  expect(orch.all).toHaveLength(0);
  const t = orch.addTask("c");
  expect(t.id).toBe("t3"); // ids keep counting up, not reused
});

test("two agents drain the shared queue with no double-claims", async () => {
  const bus = new Bus();
  const orch = new Orchestrator();
  for (let i = 0; i < 6; i++) orch.addTask(`task ${i}`);

  const a = makeAgent("a", bus);
  const b = makeAgent("b", bus);
  await Promise.all([runWorker(a, orch, bus), runWorker(b, orch, bus)]);

  const tasks = orch.all;
  expect(tasks.every((t) => t.status === "done")).toBe(true);
  expect(tasks.every((t) => t.assignedTo === "a" || t.assignedTo === "b")).toBe(true);

  // Both agents actually worked — proves concurrent draining, not one agent grabbing all.
  const byA = tasks.filter((t) => t.assignedTo === "a").length;
  expect(byA).toBeGreaterThan(0);
  expect(byA).toBeLessThan(6);
});
