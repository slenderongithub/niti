import { test, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { UsageView } from "./UsageView.tsx";
import { UsageTracker } from "../../src/usage.ts";
import type { AgentConfig } from "../../src/agent/agent.ts";

const configs: AgentConfig[] = [
  { id: "architect", provider: "anthropic", model: "claude-opus-4-8", role: "Architect", systemPrompt: "s", lead: true },
];

test("renders per-agent tokens, totals, and rate-limit remaining", () => {
  const u = new UsageTracker();
  u.record("architect", 45000, 3000);
  u.recordRateLimit("anthropic", { remainingTokens: 12000, remainingRequests: 45 });

  const { lastFrame } = render(<UsageView configs={configs} usage={u} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Usage");
  expect(frame).toContain("architect");
  expect(frame).toContain("45,000"); // formatted input tokens
  expect(frame).toContain("48,000"); // total (in + out) row somewhere
  expect(frame).toContain("rate limit (anthropic)");
  expect(frame).toContain("45 req remaining");
  expect(frame).not.toContain("⚠"); // plenty of requests left — no warning icon
});

test("shows a warning icon when requests remaining runs low", () => {
  const u = new UsageTracker();
  u.record("architect", 45000, 3000);
  u.recordRateLimit("anthropic", { remainingTokens: 500, remainingRequests: 2 });

  const { lastFrame } = render(<UsageView configs={configs} usage={u} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("⚠");
  expect(frame).toContain("2 req remaining");
});
