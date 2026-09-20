import { test, expect, setSystemTime } from "bun:test";
import { LockRegistry } from "./locks.ts";
import { SHELL_TIMEOUT_MS } from "../tools/tools.ts";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a lock cannot expire while a command is still inside its timeout window", async () => {
  // shell holds one lock for up to SHELL_TIMEOUT_MS. With no liveness check at all — the worst case
  // for this registry — a second writer must still wait out the whole window before it can reclaim.
  const t0 = Date.now();
  setSystemTime(new Date(t0));
  try {
    const locks = new LockRegistry();
    await locks.acquire("*shell*", "builder");
    setSystemTime(new Date(t0 + SHELL_TIMEOUT_MS)); // the command is at its very last second
    let second = false;
    const waiting = locks.acquire("*shell*", "rival").then(() => (second = true));
    await sleep(150);
    expect(second).toBe(false);
    setSystemTime(new Date(t0 + SHELL_TIMEOUT_MS + 10_001)); // killed and released long ago: abandoned
    await waiting;
    expect(second).toBe(true);
  } finally {
    setSystemTime();
  }
});

test("a live holder keeps its lock, and the status line still shows it, past staleMs", async () => {
  const locks = new LockRegistry(undefined, 20, (holder) => holder === "builder");
  await locks.acquire("*shell*", "builder");
  await sleep(40); // well past staleMs
  expect(locks.byHolder().get("builder")).toEqual(["*shell*"]);
  let second = false;
  const waiting = locks.acquire("*shell*", "rival").then(() => (second = true));
  await sleep(150);
  expect(second).toBe(false); // alive, so not reclaimed however long it has held it
  locks.release("*shell*", "builder");
  await waiting;
  expect(second).toBe(true);
});
