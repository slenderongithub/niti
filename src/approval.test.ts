import { test, expect } from "bun:test";
import { ApprovalQueue } from "./approval.ts";

test("request resolves when answered", async () => {
  const q = new ApprovalQueue();
  const p = q.request("a", "shell", { command: "ls" });
  expect(q.current()?.tool).toBe("shell");
  q.answer(true);
  expect(await p).toBe(true);
  expect(q.current()).toBeUndefined();
});

test("deny resolves false", async () => {
  const q = new ApprovalQueue();
  const p = q.request("a", "write_file", { path: "x" });
  q.answer(false);
  expect(await p).toBe(false);
});

test("scope 'agent' auto-approves the same agent+tool again, but not a different tool", async () => {
  const q = new ApprovalQueue();
  const p1 = q.request("a", "shell", {});
  q.answer(true, "agent");
  expect(await p1).toBe(true);

  const p2 = q.request("a", "shell", {}); // same agent+tool → resolves immediately, no queue entry
  expect(q.current()).toBeUndefined();
  expect(await p2).toBe(true);

  const p3 = q.request("a", "write_file", {}); // different tool → still prompts
  expect(q.current()?.tool).toBe("write_file");
  q.answer(true);
  expect(await p3).toBe(true);

  const p4 = q.request("b", "shell", {}); // different agent → still prompts
  expect(q.current()?.tool).toBe("shell");
  q.answer(false);
  expect(await p4).toBe(false);
});

test("grant() pre-seeds a scope without going through a prompt (agents.yaml autoApprove)", async () => {
  const q = new ApprovalQueue();
  q.grant("a", "read_file");
  expect(await q.request("a", "read_file", {})).toBe(true);
  expect(q.current()).toBeUndefined();
});

test("forceAsk always queues, even with a matching grant (dangerous commands)", async () => {
  const q = new ApprovalQueue();
  q.grant("a", "shell");
  const p = q.request("a", "shell", { command: "rm -rf /" }, true);
  expect(q.current()?.tool).toBe("shell"); // queued despite the standing grant
  q.answer(false);
  expect(await p).toBe(false);
});

test("scope 'path' narrows the grant to the request's parent directory (Bun.Glob)", async () => {
  const q = new ApprovalQueue();
  const p1 = q.request("a", "write_file", { path: "src/components/auth/Login.tsx" });
  q.answer(true, "path");
  expect(await p1).toBe(true);

  // same directory → auto-approved
  expect(await q.request("a", "write_file", { path: "src/components/auth/SignUp.tsx" })).toBe(true);
  expect(q.current()).toBeUndefined();

  // sibling directory → still prompts
  const p2 = q.request("a", "write_file", { path: "src/api/routes.ts" });
  expect(q.current()?.tool).toBe("write_file");
  q.answer(false);
  expect(await p2).toBe(false);
});

test("batch: currentBatch appears at 3+ queued and clears on approveAll", async () => {
  const q = new ApprovalQueue();
  const p1 = q.request("a", "write_file", { path: "a.ts" });
  const p2 = q.request("a", "write_file", { path: "b.ts" });
  expect(q.currentBatch()).toBeUndefined(); // only 2 so far

  const p3 = q.request("b", "shell", { command: "npm test" });
  expect(q.currentBatch()?.length).toBe(3);

  q.approveAll();
  expect(await p1).toBe(true);
  expect(await p2).toBe(true);
  expect(await p3).toBe(true);
  expect(q.currentBatch()).toBeUndefined();
  expect(q.current()).toBeUndefined();
});

test("batch: approveAgent resolves only that agent's requests, leaving the rest queued", async () => {
  const q = new ApprovalQueue();
  const p1 = q.request("a", "write_file", { path: "a.ts" });
  const p2 = q.request("b", "write_file", { path: "b.ts" });
  const p3 = q.request("a", "shell", { command: "npm test" });
  expect(q.currentBatch()?.length).toBe(3);

  q.approveAgent("a");
  expect(await p1).toBe(true);
  expect(await p3).toBe(true);
  expect(q.current()?.agentId).toBe("b"); // b's request is still pending
  q.answer(false);
  expect(await p2).toBe(false);
});

test("batch: denyAll resolves every queued request false", async () => {
  const q = new ApprovalQueue();
  const ps = [
    q.request("a", "write_file", { path: "a.ts" }),
    q.request("b", "write_file", { path: "b.ts" }),
    q.request("c", "shell", { command: "npm test" }),
  ];
  q.denyAll();
  expect(await Promise.all(ps)).toEqual([false, false, false]);
});
