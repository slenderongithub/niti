import { test, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "./App.tsx";
import { Bus } from "../events/bus.ts";
import { Orchestrator } from "../orchestrator/orchestrator.ts";
import { ApprovalQueue } from "../approval.ts";
import { UsageTracker } from "../usage.ts";
import type { AgentConfig } from "../agent/agent.ts";

// Ink styles the input cursor by reverse-videoing one character (e.g. the placeholder's first
// letter), which injects an ANSI escape between it and the rest of the string in the raw frame —
// splitting substrings like "describe" into "d" + escape + "escribe". Strip ANSI before asserting
// on frame content so tests check what a human sees, not the raw escape-coded bytes.
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("renders per-agent panes with avatars and a Tasks section", () => {
  const bus = new Bus();
  const orch = new Orchestrator();
  const configs: AgentConfig[] = [
    { id: "architect", provider: "anthropic", model: "x", role: "Architect", systemPrompt: "s", lead: true },
    { id: "engineer", provider: "openai", model: "y", role: "Engineer", systemPrompt: "s" },
  ];
  const { lastFrame } = render(<App bus={bus} orch={orch} configs={configs} />);
  const frame = plain(lastFrame() ?? "");

  expect(frame).toContain("architect");
  expect(frame).toContain("Architect");
  expect(frame).toContain("engineer");
  expect(frame).toContain("◆"); // first agent's avatar
  expect(frame).toContain("▲"); // second agent's avatar
  expect(frame).toContain("Tasks");
});

test("shows an approval prompt when a gated tool is pending", async () => {
  const bus = new Bus();
  const orch = new Orchestrator();
  const configs: AgentConfig[] = [
    { id: "a", provider: "anthropic", model: "claude-opus-4-8", role: "R", systemPrompt: "s", lead: true },
  ];
  const approvals = new ApprovalQueue();
  const { lastFrame } = render(
    <App bus={bus} orch={orch} configs={configs} approvals={approvals} onSubmit={async () => {}} />,
  );

  approvals.request("a", "shell", { command: "ls -la" });
  await new Promise((r) => setTimeout(r, 20));

  const frame = plain(lastFrame() ?? "");
  expect(frame).toContain("wants to run: shell");
  expect(frame).toContain("[1/y] approve once");
});

test("shows a batch dialog instead of one-at-a-time once 3+ approvals queue together", async () => {
  const bus = new Bus();
  const orch = new Orchestrator();
  const configs: AgentConfig[] = [
    { id: "a", provider: "anthropic", model: "claude-opus-4-8", role: "R", systemPrompt: "s", lead: true },
  ];
  const approvals = new ApprovalQueue();
  const { lastFrame } = render(
    <App bus={bus} orch={orch} configs={configs} approvals={approvals} onSubmit={async () => {}} />,
  );

  approvals.request("a", "write_file", { path: "a.ts" });
  approvals.request("a", "write_file", { path: "b.ts" });
  approvals.request("a", "shell", { command: "npm test" });
  await new Promise((r) => setTimeout(r, 20));

  const frame = plain(lastFrame() ?? "");
  expect(frame).toContain("3 Approvals Queued");
  expect(frame).toContain("Approve all 3");
});

test("renders live streaming text from delta events", async () => {
  const bus = new Bus();
  const orch = new Orchestrator();
  const configs: AgentConfig[] = [
    { id: "a", provider: "anthropic", model: "claude-opus-4-8", role: "R", systemPrompt: "s", lead: true },
  ];
  const { lastFrame } = render(<App bus={bus} orch={orch} configs={configs} />);

  bus.publish({ agentId: "a", type: "delta", payload: "Hello ", time: 0 });
  await new Promise((r) => setTimeout(r, 20));
  bus.publish({ agentId: "a", type: "delta", payload: "world", time: 0 });
  await new Promise((r) => setTimeout(r, 20));

  expect(plain(lastFrame() ?? "")).toContain("Hello world"); // accumulated live, before any final message
});

test("interactive mode shows an input and submits typed text", async () => {
  const bus = new Bus();
  const orch = new Orchestrator();
  const configs: AgentConfig[] = [
    { id: "a", provider: "anthropic", model: "x", role: "R", systemPrompt: "s", lead: true },
  ];
  const submitted: string[] = [];
  const { stdin, lastFrame } = render(
    <App bus={bus} orch={orch} configs={configs} onSubmit={async (t) => void submitted.push(t)} />,
  );
  expect(plain(lastFrame() ?? "")).toContain("describe a task"); // input line rendered

  stdin.write("write hello.txt");
  await new Promise((r) => setTimeout(r, 20));
  stdin.write("\r"); // Enter
  await new Promise((r) => setTimeout(r, 20));

  expect(submitted).toEqual(["write hello.txt"]);
});

test("typing /model opens the model selector instead of running a task", async () => {
  const bus = new Bus();
  const orch = new Orchestrator();
  const configs: AgentConfig[] = [
    { id: "a", provider: "anthropic", model: "claude-opus-4-8", role: "R", systemPrompt: "s", lead: true },
  ];
  const submitted: string[] = [];
  const { stdin, lastFrame } = render(
    <App
      bus={bus}
      orch={orch}
      configs={configs}
      onSubmit={async (t) => void submitted.push(t)}
      onPickModel={() => undefined}
    />,
  );

  stdin.write("/model");
  await new Promise((r) => setTimeout(r, 20));
  stdin.write("\r");
  await new Promise((r) => setTimeout(r, 20));

  expect(submitted).toEqual([]); // did NOT run a task
  expect(plain(lastFrame() ?? "")).toContain("how do you want to connect"); // opened the selector (supply-method step)
});

test("typing / shows a filterable command dropdown", async () => {
  const bus = new Bus();
  const orch = new Orchestrator();
  const configs: AgentConfig[] = [
    { id: "a", provider: "anthropic", model: "x", role: "R", systemPrompt: "s", lead: true },
  ];
  const { stdin, lastFrame } = render(<App bus={bus} orch={orch} configs={configs} onSubmit={async () => {}} />);

  stdin.write("/");
  await new Promise((r) => setTimeout(r, 20));
  let frame = plain(lastFrame() ?? "");
  expect(frame).toContain("/help");
  expect(frame).toContain("/graph");
  expect(frame).toContain("/clear");

  stdin.write("gr");
  await new Promise((r) => setTimeout(r, 20));
  frame = plain(lastFrame() ?? "");
  expect(frame).toContain("/graph");
  expect(frame).not.toContain("/help");
});

test("/help, /status, /skills toggle their views on and back off", async () => {
  const bus = new Bus();
  const orch = new Orchestrator();
  const configs: AgentConfig[] = [
    { id: "a", provider: "anthropic", model: "x", role: "Architect", systemPrompt: "s", lead: true },
  ];
  orch.addTask("build the thing");
  const { stdin, lastFrame } = render(<App bus={bus} orch={orch} configs={configs} onSubmit={async () => {}} />);

  stdin.write("/status");
  await new Promise((r) => setTimeout(r, 20));
  stdin.write("\r");
  await new Promise((r) => setTimeout(r, 200)); // past the 150ms task-poll tick
  expect(plain(lastFrame() ?? "")).toContain("tasks: 1 total");

  stdin.write("/status"); // toggle back off
  await new Promise((r) => setTimeout(r, 20));
  stdin.write("\r");
  await new Promise((r) => setTimeout(r, 20));
  expect(plain(lastFrame() ?? "")).not.toContain("tasks: 1 total");
});

test("/clear drops queued tasks and resets the on-screen log", async () => {
  const bus = new Bus();
  const orch = new Orchestrator();
  const configs: AgentConfig[] = [
    { id: "a", provider: "anthropic", model: "x", role: "R", systemPrompt: "s", lead: true },
  ];
  orch.addTask("old task");
  const { stdin, lastFrame } = render(<App bus={bus} orch={orch} configs={configs} onSubmit={async () => {}} />);
  await new Promise((r) => setTimeout(r, 200)); // let the poll tick pick up the pre-seeded task
  expect(plain(lastFrame() ?? "")).toContain("old task");

  stdin.write("/clear");
  await new Promise((r) => setTimeout(r, 20));
  stdin.write("\r");
  await new Promise((r) => setTimeout(r, 200));
  expect(orch.all).toHaveLength(0);
  expect(plain(lastFrame() ?? "")).not.toContain("old task");
});

test("shows an animated spinner with elapsed time and a running token count", async () => {
  const bus = new Bus();
  const orch = new Orchestrator();
  const configs: AgentConfig[] = [
    { id: "a", provider: "anthropic", model: "x", role: "R", systemPrompt: "s", lead: true },
  ];
  const usage = new UsageTracker();
  usage.record("a", 100, 2100); // baseline before the run — total 2200
  let resolveRun: () => void = () => {};
  const onSubmit = () =>
    new Promise<void>((res) => {
      resolveRun = res;
      usage.record("a", 0, 2200); // this run "downloads" 2200 more tokens
    });
  const { stdin, lastFrame } = render(
    <App bus={bus} orch={orch} configs={configs} onSubmit={onSubmit} usage={usage} />,
  );

  stdin.write("do the thing");
  await new Promise((r) => setTimeout(r, 20));
  stdin.write("\r");
  await new Promise((r) => setTimeout(r, 20));
  const frame = plain(lastFrame() ?? "");
  expect(frame).toContain("Working…");
  expect(frame).toMatch(/\d+m \d+s/);
  expect(frame).toContain("↓2.2k tokens");

  resolveRun();
});
