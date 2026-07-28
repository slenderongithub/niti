import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveTasks, loadTasks } from "./session.ts";
import { Orchestrator } from "./orchestrator/orchestrator.ts";
import type { Task } from "./orchestrator/task.ts";

test("save then load round-trips tasks", () => {
  const path = join(mkdtempSync(join(tmpdir(), "amux-sess-")), "session.json");
  const tasks: Task[] = [
    { id: "t1", description: "a", status: "done", assignedTo: "architect" },
    { id: "t2", description: "b", status: "pending", attempts: 1 },
  ];
  saveTasks(tasks, path);
  expect(loadTasks(path)).toEqual(tasks);
});

test("loadTasks returns [] for a missing file", () => {
  expect(loadTasks("/no/such/session.json")).toEqual([]);
});

test("orch.load restores tasks and continues id numbering past the highest", () => {
  const orch = new Orchestrator();
  orch.load([{ id: "t5", description: "x", status: "done" }]);
  expect(orch.all).toHaveLength(1);
  expect(orch.addTask("new").id).toBe("t6"); // continues past t5
});
