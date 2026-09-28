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
