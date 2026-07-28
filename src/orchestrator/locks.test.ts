import { test, expect } from "bun:test";
import { LockRegistry } from "./locks.ts";
import { Bus } from "../events/bus.ts";

test("acquire grants immediately when free, and is reentrant for the same holder", async () => {
  const locks = new LockRegistry();
  await locks.acquire("a.ts", "eng");
  await locks.acquire("a.ts", "eng");
  expect(locks.byHolder().get("eng")).toEqual(["a.ts"]);
});

test("acquire blocks a second holder until the first releases", async () => {
  const locks = new LockRegistry();
  await locks.acquire("a.ts", "architect");
  let granted = false;
  const waiting = locks.acquire("a.ts", "engineer").then(() => (granted = true));

  await new Promise((r) => setTimeout(r, 30));
  expect(granted).toBe(false);

  locks.release("a.ts", "architect");
  await waiting;
  expect(granted).toBe(true);
  expect(locks.byHolder().get("engineer")).toEqual(["a.ts"]);
});

test("a lock older than staleMs is reclaimed automatically, with a bus warning", async () => {
  const events: string[] = [];
  const bus = new Bus();
  bus.subscribe((e) => events.push(e.payload));
  const locks = new LockRegistry(bus, 20); // 20ms "stale" threshold for the test

  await locks.acquire("a.ts", "architect");
  await new Promise((r) => setTimeout(r, 30));
  await locks.acquire("a.ts", "engineer"); // stale — reclaimed without blocking

  expect(locks.byHolder().get("engineer")).toEqual(["a.ts"]);
  expect(events.some((p) => p.includes("stale lock reclaimed"))).toBe(true);
});

test("release is a no-op for a holder that doesn't own the lock", async () => {
  const locks = new LockRegistry();
  await locks.acquire("a.ts", "architect");
  locks.release("a.ts", "someone-else");
  expect(locks.byHolder().get("architect")).toEqual(["a.ts"]);
});
