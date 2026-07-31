import { watch, type FSWatcher } from "node:fs";
import { sep } from "node:path";

// Watch the project for edits made outside amux (a human in their editor, a git checkout, a
// formatter). Emits paths only — nothing is stuffed into any agent's context automatically, which
// would quietly inflate every prompt; a human or the next planning pass decides what a change means.

// Directories whose churn is never interesting.
// ponytail: a fixed list instead of parsing .gitignore, and no debounce — one event per fs
// notification. Add debouncing/gitignore parsing if watcher noise ever becomes a real problem.
const IGNORED_SEGMENTS = new Set([".git", "node_modules", ".amux", "dist", "build", ".next", "target", "vendor"]);

// How long an agent's own write suppresses the echo it causes. Long enough for the fs notification
// to arrive, short enough that a human editing the same file right after still registers.
const SELF_WRITE_TTL_MS = 2_000;

export function isIgnored(relPath: string): boolean {
  return relPath.split(sep).some((segment) => IGNORED_SEGMENTS.has(segment));
}

export interface ProjectWatcher {
  markSelfWrite(relPath: string): void; // called just before an agent writes, so it doesn't hear its own echo
  close(): void;
}

export function watchProject(root: string, onChange: (relPath: string) => void): ProjectWatcher {
  const selfWrites = new Map<string, number>();
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = String(filename);
      if (isIgnored(rel)) return;
      const at = selfWrites.get(rel);
      if (at !== undefined && Date.now() - at < SELF_WRITE_TTL_MS) return; // our own write, echoing back
      onChange(rel);
    });
  } catch {
    // No recursive watch on this platform/filesystem: file watching is a nice-to-have, never a
    // reason to fail startup. markSelfWrite/close stay valid no-ops.
  }
  return {
    markSelfWrite(relPath: string) {
      const now = Date.now();
      selfWrites.set(relPath, now);
      for (const [path, at] of selfWrites) if (now - at > SELF_WRITE_TTL_MS) selfWrites.delete(path); // bounded without a timer
    },
    close() {
      watcher?.close();
    },
  };
}
