import { test, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { GraphView } from "./GraphView.tsx";
import type { AgentConfig } from "../../src/agent/agent.ts";
import type { Task } from "../../src/orchestrator/task.ts";

const configs: AgentConfig[] = [
  { id: "architect", provider: "anthropic", model: "claude-opus-4-8", role: "Architect", systemPrompt: "s", lead: true },
  { id: "engineer", provider: "openai", model: "gpt-4o", role: "Engineer", systemPrompt: "s" },
];

test("renders agent→task tree with a failover marker and unassigned pending", () => {
  const tasks: Task[] = [
    { id: "t1", description: "add health route", status: "done", assignedTo: "architect" },
    { id: "t2", description: "write tests", status: "done", assignedTo: "engineer", attempts: 2 },
    { id: "t3", description: "docs", status: "pending" },
  ];
  const { lastFrame } = render(<GraphView configs={configs} tasks={tasks} />);
  const frame = (lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, ""); // strip ANSI so assertions don't depend on chalk's color level
  expect(frame).toContain("architect");
  expect(frame).toContain("t1 [done]");
  expect(frame).toContain("⚡×2"); // failover on t2
  expect(frame).toContain("pending (unassigned)");
  expect(frame).toContain("t3");
});

test("a running task shows a spinner glyph next to its status badge", () => {
  const tasks: Task[] = [{ id: "t1", description: "build the api", status: "in_progress", assignedTo: "architect" }];
  const { lastFrame } = render(<GraphView configs={configs} tasks={tasks} />);
  const frame = (lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, ""); // strip ANSI so assertions don't depend on chalk's color level
  expect(frame).toContain("[in_progress]");
  expect(frame).toMatch(/\[in_progress\] [⠋⠙⠹⠸⠼⠦⠧⠇⠏]/);
});
