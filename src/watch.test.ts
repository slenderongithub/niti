import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchProject, isIgnored } from "./watch.ts";

// fs.watch delivers asynchronously and coalesces; poll for the expectation instead of sleeping
// a fixed amount and hoping.
// Comfortably longer than watch.ts's SELF_WRITE_TTL_MS (2s): a poll budget equal to the window
// it races is how this suite went red on CI and stayed green locally.
async function until(pred: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

test("a change inside the project is reported", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-watch-"));
  const seen: string[] = [];
  const w = watchProject(root, (p) => seen.push(p));

  writeFileSync(join(root, "note.txt"), "hello");
  expect(await until(() => seen.includes("note.txt"))).toBe(true);
  w.close();
});

test("noise directories never fire", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-watch-"));
  const seen: string[] = [];
  const w = watchProject(root, (p) => seen.push(p));

  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "node_modules", "junk.js"), "x");
  writeFileSync(join(root, "real.txt"), "x"); // fires, so we know the watcher was live

  expect(await until(() => seen.includes("real.txt"))).toBe(true);
  expect(seen.some((p) => p.includes("node_modules"))).toBe(false);
  w.close();
});

test("an agent's own write is not reported back as an external change", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-watch-"));
  const seen: string[] = [];
  const w = watchProject(root, (p) => seen.push(p));

  // Establish that the watcher is live and delivering *before* testing suppression. Writing both
  // files back to back instead made this depend on two rapid writes producing two distinct fs
  // events — Linux coalesces them, so the only event was the suppressed one and the test hung
  // waiting for a second that was never coming.
  writeFileSync(join(root, "theirs.txt"), "a human wrote this");
  expect(await until(() => seen.includes("theirs.txt"))).toBe(true);

  w.markSelfWrite("mine.txt");
  writeFileSync(join(root, "mine.txt"), "agent wrote this");
  // Give the notification a chance to arrive and be suppressed. A pass here means either it was
  // filtered or it hasn't landed yet; the following write proves the watcher is still delivering,
  // so "hasn't landed yet" cannot silently carry the assertion.
  writeFileSync(join(root, "after.txt"), "another human write");
  expect(await until(() => seen.includes("after.txt"))).toBe(true);
  expect(seen).not.toContain("mine.txt");
  w.close();
});

test("isIgnored matches on any path segment", () => {
  expect(isIgnored(".git/HEAD")).toBe(true);
  expect(isIgnored("src/node_modules/x/index.js")).toBe(true);
  expect(isIgnored(".niti/niti.db")).toBe(true);
  expect(isIgnored("src/agent/agent.ts")).toBe(false);
  expect(isIgnored("gitignore.md")).toBe(false); // segment match, not substring
});

test("close() stops further reports", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-watch-"));
  const seen: string[] = [];
  const w = watchProject(root, (p) => seen.push(p));
  w.close();

  writeFileSync(join(root, "after.txt"), "x");
  await new Promise((r) => setTimeout(r, 200));
  expect(seen).toEqual([]);
});
