import { lstatSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { normalizePath } from "./permissions.ts";

// Watch the project for edits made outside niti (a human in their editor, a git checkout, a
// formatter). Emits paths only — nothing is stuffed into any agent's context automatically, which
// would quietly inflate every prompt; a human or the next planning pass decides what a change means.

// Directories whose churn is never interesting.
// ponytail: a fixed list instead of parsing .gitignore, and no debounce — one event per fs
// notification. Add debouncing/gitignore parsing if watcher noise ever becomes a real problem.
const IGNORED_SEGMENTS = new Set([".git", "node_modules", ".niti", "dist", "build", ".next", "target", "vendor"]);

// How long an agent's own write suppresses the echo it causes. Long enough for the fs notification
// to arrive, short enough that a human editing the same file right after still registers.
const SELF_WRITE_TTL_MS = 2_000;

export function isIgnored(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((segment) => IGNORED_SEGMENTS.has(segment));
}

export interface ProjectWatcher {
  markSelfWrite(relPath: string): void; // called just before an agent writes, so it doesn't hear its own echo
  close(): void;
}

export function watchProject(root: string, onChange: (relPath: string) => void): ProjectWatcher {
  const selfWrites = new Map<string, number>();
  const report = (rel: string) => {
    if (!rel || isIgnored(rel)) return;
    const at = selfWrites.get(rel);
    if (at !== undefined && Date.now() - at < SELF_WRITE_TTL_MS) return; // our own write, echoing back
    onChange(rel);
  };
  const watchers: FSWatcher[] = [];
  try {
    if (process.platform === "linux") watchTree(root, report, watchers);
    else
      watchers.push(
        watch(root, { recursive: true }, (_event, filename) => {
          // fs.watch reports "src\\a.ts" on Windows; markSelfWrite keys on "/"
          if (filename) report(normalizePath(String(filename)));
        }),
      );
  } catch {
    // No recursive watch on this platform/filesystem: file watching is a nice-to-have, never a
    // reason to fail startup. markSelfWrite/close stay valid no-ops.
  }
  return {
    markSelfWrite(relPath: string) {
      const now = Date.now();
      // Normalized on the way in, because the caller passes the model's own spelling of the path
      // ("./src/a.ts", "src/../src/a.ts") while fs.watch reports a clean relative one. Any mismatch
      // meant the agent's own write was announced back to it as an external change.
      // Its folders too: creating src/a.ts also changes src, and macOS reports that as its own
      // event — which read as "changed outside niti: src" every time an agent made a file.
      for (let p = normalizePath(relPath); p && p !== "."; p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") selfWrites.set(p, now);
      for (const [path, at] of selfWrites) if (now - at > SELF_WRITE_TTL_MS) selfWrites.delete(path); // bounded without a timer
    },
    close() {
      for (const w of watchers) w.close();
    },
  };
}

// Linux: one plain watch per folder, added as folders appear. Bun's recursive watch there never
// watches a folder created after it started — edits inside one were never reported — and a write
// right after such a folder appeared was dropped too (reproduced on bun 1.3.10; node gets it right).
// Doing it here also means node_modules and the other noise folders are never watched at all,
// instead of being watched and filtered, which on a big project is thousands of inotify watches.
// ponytail: capped at MAX_WATCHED_DIRS; past that, deeper new folders go unwatched.
const MAX_WATCHED_DIRS = 4000;
function watchTree(root: string, report: (rel: string) => void, watchers: FSWatcher[]): void {
  const watched = new Set<string>();
  const add = (rel: string, announce: boolean) => {
    if (watched.has(rel) || watched.size >= MAX_WATCHED_DIRS || (rel && isIgnored(rel))) return;
    let entries;
    try {
      watchers.push(
        watch(join(root, rel), (_event, name) => {
          if (!name) return;
          const child = rel ? `${rel}/${name}` : String(name);
          report(child);
          try {
            if (lstatSync(join(root, child)).isDirectory()) add(child, true); // lstat: never follow a link out of the project
          } catch {
            /* gone again already */
          }
        }),
      );
      watched.add(rel);
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return; // unreadable or vanished — skip it, as the recursive watch would
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      // A folder that just appeared may already hold files written before its watch existed.
      if (announce && !e.isDirectory()) report(child);
      if (e.isDirectory()) add(child, announce);
    }
  };
  add("", false);
}
