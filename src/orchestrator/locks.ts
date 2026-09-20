import type { Bus } from "../events/bus.ts";
import { SHELL_TIMEOUT_MS } from "../tools/tools.ts";

// An agent that dies without releasing loses its lock after this long. Tied to the longest a
// locked operation can legitimately run — shell holds SHELL_LOCK for up to SHELL_TIMEOUT_MS — plus
// headroom for the process to be killed and the release to land. A fixed 60s sat inside a 120s
// command's window, so any caller without a liveness check (see isAlive) could hand the worktree to
// a second writer while the first was still running a legitimate build.
const STALE_MS = SHELL_TIMEOUT_MS + 10_000;
const POLL_MS = 50;

interface LockEntry {
  holder: string;
  acquiredAt: number;
}

// One lock per file path, held for the duration of a write_file call. acquire() blocks (polls)
// until the path is free; a lock older than staleMs is treated as abandoned (crashed/hung agent)
// and silently reclaimed — lazy eviction on next acquire, no background sweep timer to manage.
// ponytail: in-memory, single process — fine since every agent runs inside one niti process.
export class LockRegistry {
  private locks = new Map<string, LockEntry>();

  constructor(
    private bus?: Bus,
    private staleMs = STALE_MS,
    // Liveness of a holder id. The Engine passes one backed by Agent.busy, so a live agent keeps its
    // lock however long it runs. Without one, every holder counts as gone and a lock older than
    // staleMs is reclaimed — which is why staleMs must outlast the longest locked operation.
    private isAlive?: (holder: string) => boolean,
  ) {}

  async acquire(path: string, holder: string): Promise<void> {
    let warned = false;
    for (;;) {
      const entry = this.locks.get(path);
      if (!entry || entry.holder === holder) {
        this.locks.set(path, { holder, acquiredAt: Date.now() });
        return;
      }
      // "Held for 60s" is not the same as "abandoned" — a slow shell or a long provider call is
      // exactly that, and reclaiming there handed the same file to a second writer, which is the
      // one thing this registry exists to prevent. Only reclaim from a holder that is genuinely
      // gone; if it is still alive, keep waiting however long it takes.
      const stale = Date.now() - entry.acquiredAt > this.staleMs;
      if (stale && !(this.isAlive?.(entry.holder) ?? false)) {
        this.bus?.publish({
          agentId: entry.holder,
          type: "warning",
          payload: `stale lock reclaimed: ${path} (held ${Math.round((Date.now() - entry.acquiredAt) / 1000)}s by a finished agent)`,
          time: Date.now(),
        });
        this.locks.set(path, { holder, acquiredAt: Date.now() });
        return;
      }
      if (!warned) {
        warned = true;
        this.bus?.publish({
          agentId: holder,
          type: "warning",
          payload: `blocked on ${path} (held by ${entry.holder})`,
          time: Date.now(),
        });
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  release(path: string, holder: string): void {
    if (this.locks.get(path)?.holder === holder) this.locks.delete(path);
  }

  // For the TUI status line: holder → paths it currently holds.
  byHolder(): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const [path, entry] of this.locks) {
      // A lock past staleMs is only abandoned if its holder is gone; a live agent on a long build
      // still holds it, and the status line should say so.
      if (Date.now() - entry.acquiredAt > this.staleMs && !(this.isAlive?.(entry.holder) ?? false)) continue;
      m.set(entry.holder, [...(m.get(entry.holder) ?? []), path]);
    }
    return m;
  }
}
