import { test, expect } from "bun:test";
import { EventHub } from "./events.ts";

test("missedSince reports events that fell out of the replay buffer, and only those", () => {
  const hub = new EventHub();
  for (let i = 0; i < 2100; i++) hub.publish({ kind: "theme", theme: String(i) }); // buffer keeps the newest 2000
  expect(hub.replay(0)[0]!.seq).toBe(101);
  expect(hub.missedSince(50)).toBe(50); // seqs 51..100 are gone
  expect(hub.missedSince(100)).toBe(0); // 101 is the next one and still buffered
  expect(hub.missedSince(0)).toBe(0); // a fresh client asked for "whatever is buffered"
  expect(hub.missedSince(2100)).toBe(0);
});

test("live-only events reach subscribers but never crowd the replay buffer, or count as missed", () => {
  const hub = new EventHub();
  const seen: number[] = [];
  hub.subscribe((e) => seen.push(e.seq));
  hub.publish({ kind: "theme", theme: "plan" });
  for (let i = 0; i < 5000; i++) hub.publish({ kind: "theme", theme: "token" }, false); // a long streamed reply
  hub.publish({ kind: "theme", theme: "done" });
  expect(seen).toHaveLength(5002); // live clients got all of it
  expect(hub.replay(0).map((e) => (e as { theme: string }).theme)).toEqual(["plan", "done"]); // the run survives
  expect(hub.missedSince(1)).toBe(0); // the gap is live-only events, not lost history
});
