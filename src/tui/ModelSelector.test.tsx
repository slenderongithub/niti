import { test, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { ModelSelector } from "./ModelSelector.tsx";
import type { AgentConfig } from "../agent/agent.ts";

const agents: AgentConfig[] = [
  { id: "architect", provider: "anthropic", model: "claude-opus-4-8", role: "Architect", systemPrompt: "s", lead: true },
];

test("single agent goes straight to the supply-method step (API key / Local / Sign in)", () => {
  const { lastFrame } = render(
    <ModelSelector agents={agents} onPick={() => undefined} onCancel={() => {}} />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("how do you want to connect");
  expect(frame).toContain("API key");
  expect(frame).toContain("Local");
  expect(frame).toContain("Sign in");
});
