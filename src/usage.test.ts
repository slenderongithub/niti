import { test, expect } from "bun:test";
import { UsageTracker } from "./usage.ts";
import { parseRateLimit } from "./providers/provider.ts";

test("UsageTracker accumulates per-agent and totals", () => {
  const u = new UsageTracker();
  u.record("a", 100, 20);
  u.record("a", 50, 10);
  u.record("b", 200, 40);

  const snap = Object.fromEntries(u.snapshot().map((s) => [s.agentId, s.usage]));
  expect(snap.a).toEqual({ inputTokens: 150, outputTokens: 30, calls: 2, lastInput: 50, cacheReadTokens: 0, cacheWriteTokens: 0 });
  expect(snap.b).toEqual({ inputTokens: 200, outputTokens: 40, calls: 1, lastInput: 200, cacheReadTokens: 0, cacheWriteTokens: 0 });
  expect(u.totals()).toEqual({ inputTokens: 350, outputTokens: 70, calls: 3, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test("UsageTracker accumulates cache read/write tokens alongside input/output", () => {
  const u = new UsageTracker();
  u.record("a", 100, 20, 900, 50);
  u.record("a", 50, 10, 400, 0);

  const snap = Object.fromEntries(u.snapshot().map((s) => [s.agentId, s.usage]));
  expect(snap.a).toMatchObject({ cacheReadTokens: 1300, cacheWriteTokens: 50 });
  expect(u.totals()).toMatchObject({ cacheReadTokens: 1300, cacheWriteTokens: 50 });
});

test("UsageTracker keeps the latest rate limit per provider", () => {
  const u = new UsageTracker();
  u.recordRateLimit("anthropic", { remainingTokens: 9000, remainingRequests: 5 });
  u.recordRateLimit("anthropic", { remainingTokens: 8000, remainingRequests: 4 }); // overwrites
  expect(u.rateLimits_()).toEqual([{ provider: "anthropic", remainingTokens: 8000, remainingRequests: 4 }]);
});

test("parseRateLimit reads the right headers per provider", () => {
  const anth = new Headers({
    "anthropic-ratelimit-tokens-remaining": "12000",
    "anthropic-ratelimit-requests-remaining": "45",
  });
  expect(parseRateLimit(anth, "anthropic")).toMatchObject({ remainingTokens: 12000, remainingRequests: 45 });

  const oai = new Headers({ "x-ratelimit-remaining-tokens": "500", "x-ratelimit-remaining-requests": "2" });
  expect(parseRateLimit(oai, "openai")).toMatchObject({ remainingTokens: 500, remainingRequests: 2 });

  expect(parseRateLimit(new Headers(), "openai")).toEqual({ remainingTokens: undefined, remainingRequests: undefined, resetAt: undefined });
});

test("lastInput is the whole prompt when the caller supplies it, so a cached window still reads as full", () => {
  const t = new UsageTracker();
  t.record("a", 500, 10, 959_500, 0, 960_000);
  expect(t.snapshot()[0]!.usage.lastInput).toBe(960_000);
  t.record("a", 700, 10); // no context given: falls back to the input count, as before
  expect(t.snapshot()[0]!.usage.lastInput).toBe(700);
});
