import { test, expect } from "bun:test";
import { parseTodos, renderTodos, todoAck } from "./todo.ts";

test("accepts the shapes models actually emit, not just the documented one", () => {
  // A plain list of steps is a perfectly clear plan; rejecting it would cost a turn to re-send.
  expect(parseTodos(["find the file", "edit it"])).toEqual([
    { text: "find the file", status: "pending" },
    { text: "edit it", status: "pending" },
  ]);
  // Common key aliases and status spellings, all meaning the obvious thing.
  expect(parseTodos([{ step: "a", status: "in_progress" }, { task: "b", status: "completed" }])).toEqual([
    { text: "a", status: "doing" },
    { text: "b", status: "done" },
  ]);
});

test("an unrecognised status keeps the item open rather than retiring it", () => {
  // Guessing "done" from an unknown word would silently drop work off the plan.
  expect(parseTodos([{ text: "a", status: "banana" }])).toEqual([{ text: "a", status: "pending" }]);
});

test("junk entries are skipped without discarding the good ones", () => {
  expect(parseTodos([null, { text: "" }, "real step", 42])).toEqual([{ text: "real step", status: "pending" }]);
  expect(parseTodos("not a list")).toEqual([]);
});

test("the list is bounded, so a runaway plan can't fill the context", () => {
  expect(parseTodos(Array.from({ length: 50 }, (_, i) => `step ${i}`))).toHaveLength(20);
  expect(parseTodos([{ text: "x".repeat(500) }])[0]!.text.length).toBeLessThanOrEqual(120);
});

test("the acknowledgement names what is left instead of just saying ok", () => {
  // A bare "ok" invites the model to treat the bookkeeping as the accomplishment and stop.
  const ack = todoAck([{ text: "a", status: "done" }, { text: "b", status: "pending" }]);
  expect(ack).toContain("[x] a");
  expect(ack).toContain("[ ] b");
  expect(ack).toContain("1 step(s) still open");

  const finished = todoAck([{ text: "a", status: "done" }]);
  expect(finished).toContain("verifying");
});

test("renders one line per step with its state visible", () => {
  expect(renderTodos([{ text: "a", status: "doing" }])).toBe("[~] a");
});
