import { test, expect } from "bun:test";
import { Bus } from "../events/bus.ts";
import { Agent, type AgentConfig } from "../agent/agent.ts";
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

// Note: cross-agent failover itself is covered in scheduler.test.ts, against `schedule` — the path
// that actually ships. These tests used to drive runner.ts's `worker`, which no production code
// ever called, so they certified a feature that shipped differently.

test("a context-window overflow is NOT exhaustion — retrying it is guaranteed to fail identically", async () => {
  // Exhaustion means "retryable": the scheduler reruns the same prompt on the same model. A 429 is
  // transient and worth that; an oversized prompt is deterministic, so it burned four identical
  // billed calls on the way to a replan that could have shortened the task on attempt one.
  const overflowed: Provider = {
    async send() {
      throw new Error("400 this model's maximum context length is 128000 tokens, however you requested 190000");
    },
  };
  expect(await new Agent(cfg, overflowed, new Bus()).run("do it")).toBe("failed");
});
