import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchProject, isIgnored } from "./watch.ts";

// fs.watch delivers asynchronously and coalesces; poll for the expectation instead of sleeping
// a fixed amount and hoping.
async function until(pred: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

test("a change inside the project is reported", async () => {
  const root = mkdtempSync(join(tmpdir(), "amux-watch-"));
  const seen: string[] = [];
  const w = watchProject(root, (p) => seen.push(p));

  writeFileSync(join(root, "note.txt"), "hello");
  expect(await until(() => seen.includes("note.txt"))).toBe(true);
  w.close();
});

test("noise directories never fire", async () => {
  const root = mkdtempSync(join(tmpdir(), "amux-watch-"));
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
  const root = mkdtempSync(join(tmpdir(), "amux-watch-"));
  const seen: string[] = [];
  const w = watchProject(root, (p) => seen.push(p));

  w.markSelfWrite("mine.txt");
  writeFileSync(join(root, "mine.txt"), "agent wrote this");
  writeFileSync(join(root, "theirs.txt"), "a human wrote this");

  expect(await until(() => seen.includes("theirs.txt"))).toBe(true);
  expect(seen).not.toContain("mine.txt");
  w.close();
});

test("isIgnored matches on any path segment", () => {
  expect(isIgnored(".git/HEAD")).toBe(true);
  expect(isIgnored("src/node_modules/x/index.js")).toBe(true);
  expect(isIgnored(".amux/amux.db")).toBe(true);
  expect(isIgnored("src/agent/agent.ts")).toBe(false);
  expect(isIgnored("gitignore.md")).toBe(false); // segment match, not substring
});

test("close() stops further reports", async () => {
  const root = mkdtempSync(join(tmpdir(), "amux-watch-"));
  const seen: string[] = [];
  const w = watchProject(root, (p) => seen.push(p));
  w.close();

  writeFileSync(join(root, "after.txt"), "x");
  await new Promise((r) => setTimeout(r, 200));
  expect(seen).toEqual([]);
});
