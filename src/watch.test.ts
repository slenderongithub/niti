import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchProject, isIgnored } from "./watch.ts";

// fs.watch delivers asynchronously and coalesces; poll for the expectation instead of sleeping
// a fixed amount and hoping.
// Comfortably longer than watch.ts's SELF_WRITE_TTL_MS (2s): a poll budget equal to the window
// it races is how this suite went red on CI and stayed green locally.
const LIVE = { timeout: 40_000 };

// Bun's fs.watch on Linux sometimes drops one of two writes made back to back in one folder (bun
// 1.3.10: 16/20 delivered where node 22 delivers 20/20, same script) — that, not niti, is what kept
// turning CI and the v0.4.4 release job red. These tests check what niti reports and filters, not
// that the runtime delivers every event, so a write that has to be seen is repeated until it is —
// the same thing armed() does for its probe.
async function deliver(root: string, rel: string, seen: string[], ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    writeFileSync(join(root, rel), String(Date.now()));
    if (await until(() => seen.includes(rel), 250)) return true;
  }
  return seen.includes(rel);
}

async function until(pred: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

// A recursive watch ARMS asynchronously: fs.watch() returns before macOS has registered the
// FSEvents stream (and before Linux has finished walking the tree adding inotify marks). A write
// in that window produces no event at all — not a late one — so no amount of polling rescues it,
// which is exactly how "noise directories never fire" went red under full-suite parallelism while
// passing every time on its own. Touch a throwaway probe until one comes back, and only then let
// the test write the file it is actually asserting on.
async function armed(root: string, seen: string[]): Promise<void> {
  const probe = "watcher-probe.tmp";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    writeFileSync(join(root, probe), String(Date.now()));
    if (await until(() => seen.includes(probe), 200)) {
      seen.length = 0; // drop the probe's own events; assertions below look for specific names
      return;
    }
  }
  throw new Error("fs.watch never delivered an event — no recursive watch on this platform?");
}

test("a change inside the project is reported", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-watch-"));
  const seen: string[] = [];
  const w = watchProject(root, (p) => seen.push(p));
  await armed(root, seen);

  expect(await deliver(root, "note.txt", seen)).toBe(true);
  w.close();
}, LIVE);

test("noise directories never fire", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-watch-"));
  const seen: string[] = [];
  const w = watchProject(root, (p) => seen.push(p));
  await armed(root, seen);

  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "node_modules", "junk.js"), "x");
  expect(await deliver(root, "real.txt", seen)).toBe(true); // fires, so we know the watcher was live
  expect(seen.some((p) => p.includes("node_modules"))).toBe(false);
  w.close();
}, LIVE);

test("an agent's own write is not reported back as an external change", async () => {
  // Two sequential real fs.watch round trips, each with an `until()` budget matching
  // SELF_WRITE_TTL_MS — worst case that's close to bun's 5s default per-test timeout with zero
  // headroom, which is what actually sent this test red on CI (not the suppression logic itself:
  // it passes locally every time). Recursive fs.watch is slower to set up and deliver on CI's
  // Linux runners than on a local dev machine, so give the full test room for both round trips.
  const root = mkdtempSync(join(tmpdir(), "niti-watch-"));
  const seen: string[] = [];
  const w = watchProject(root, (p) => seen.push(p));
  await armed(root, seen);

  // Establish that the watcher is live and delivering *before* testing suppression. Writing both
  // files back to back instead made this depend on two rapid writes producing two distinct fs
  // events — Linux coalesces them, so the only event was the suppressed one and the test hung
  // waiting for a second that was never coming.
  expect(await deliver(root, "theirs.txt", seen)).toBe(true);

  w.markSelfWrite("mine.txt");
  writeFileSync(join(root, "mine.txt"), "agent wrote this");
  // Give the notification a chance to arrive and be suppressed. A pass here means either it was
  // filtered or it hasn't landed yet; the following write proves the watcher is still delivering,
  // so "hasn't landed yet" cannot silently carry the assertion.
  expect(await deliver(root, "after.txt", seen)).toBe(true);
  expect(seen).not.toContain("mine.txt");
  w.close();
}, LIVE);

test("an agent's new file does not report its folder as changed either", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-watch-"));
  const seen: string[] = [];
  const w = watchProject(root, (p) => seen.push(p));
  await armed(root, seen);

  w.markSelfWrite("./src/new.ts");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "new.ts"), "agent wrote this");
  expect(await deliver(root, "after.txt", seen)).toBe(true); // proves delivery, as above
  expect(seen.filter((p) => p.startsWith("src"))).toEqual([]);
  w.close();
}, LIVE);

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

// The Linux case bun's recursive watch got wrong: a folder created after watching began, with a file
// written into it straight away (what npm install, a scaffolder or a git checkout does).
test("a file in a folder created after the watch started is reported, and so is what follows", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-watch-"));
  const seen: string[] = [];
  const w = watchProject(root, (p) => seen.push(p));
  await armed(root, seen);

  mkdirSync(join(root, "pages"));
  expect(await deliver(root, "pages/home.ts", seen)).toBe(true);
  expect(await deliver(root, "after.txt", seen)).toBe(true);
  expect(await deliver(root, "pages/later.ts", seen)).toBe(true); // and the new folder stays watched
  w.close();
}, LIVE);
