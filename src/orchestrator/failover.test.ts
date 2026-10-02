import { test, expect } from "bun:test";
import { Bus } from "../events/bus.ts";
import { Agent, rateLimitWait, type AgentConfig } from "../agent/agent.ts";
import type { Provider } from "../providers/provider.ts";

const cfg: AgentConfig = { id: "a", provider: "anthropic", model: "x", role: "r", systemPrompt: "s", allowedTools: [] };

test("agent.run classifies a 429 as exhaustion", async () => {
  const rateLimited: Provider = {
    async send() {
      // retry-after 0: Agent.send still makes its full set of retries, just without the wait
      throw Object.assign(new Error("rate limit"), { status: 429, headers: { "retry-after": "0" } });
    },
  };
  const outcome = await new Agent(cfg, rateLimited, new Bus()).run("do it");
  expect(outcome).toBe("exhausted"); // a 429 that outlasts the retries is still exhaustion
});

test("a transient 429 is waited out inside the call, not turned into a failed task", async () => {
  let n = 0;
  const flaky: Provider = {
    async send() {
      if (n++ < 2) throw Object.assign(new Error("Too Many Requests"), { status: 429, headers: { "retry-after": "0" } });
      return { text: "done", toolCalls: [] };
    },
  };
  const bus = new Bus();
  const warnings: string[] = [];
  bus.subscribe((e) => e.type === "warning" && warnings.push(e.payload));
  expect(await new Agent(cfg, flaky, bus).run("do it")).toBe("done");
  expect(warnings.filter((w) => w.includes("rate-limiting")).length).toBe(2); // the user sees why it paused
});

test("rateLimitWait honours the provider's hint and gives up after the last step", () => {
  expect(rateLimitWait(Object.assign(new Error("x"), { status: 429, headers: { "retry-after": "7" } }), 0)).toBe(7000);
  expect(rateLimitWait(new Error('{"error":{"code":429,"details":[{"retryDelay":"17s"}]}}'), 0)).toBe(17_000);
  expect(rateLimitWait(Object.assign(new Error("x"), { status: 429 }), 1)).toBe(10_000);
  expect(rateLimitWait(Object.assign(new Error("x"), { status: 429 }), 4)).toBeUndefined();
  expect(rateLimitWait(Object.assign(new Error("bad request"), { status: 400 }), 0)).toBeUndefined();
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
