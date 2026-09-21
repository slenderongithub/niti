import { READ_ONLY_TOOLS, WRITE_TOOLS } from "../tools/tools.ts";
import type { ToolCall, ToolResult } from "../providers/provider.ts";

// The turn cap bounds a run that never finishes, but it bounds it at the price of every turn: an
// agent that has stopped acting — reading the same files, re-running a failing check, never
// calling edit — re-sends a growing history 30 times to reach the same "exhausted". Observed on the
// eval's `fix-what-it-broke`: one edit, then a dozen rounds of read, check, read, check.
//
// A stall is a run of rounds in which every call is a read, a failing command or an errored call —
// nothing that could have changed the answer. It is only judged once the run has written a file:
// before that, reading is the job, and a research or review task is never "stuck". Escalation is
// two steps, because the two mistakes cost differently. A wrongly-issued nudge is one short user
// turn; a wrongly-issued stop kills a session that was about to work. So:
//
//   NUDGE_AFTER stagnant rounds  → say so, once, and tell it what to do instead.
//   STOP_AFTER more, and only if the streak was going nowhere (a command or call failed, or the
//   same call was made twice) → end the run as exhausted.
//
// A long streak of *distinct, succeeding* reads earns the nudge and nothing more: that is a deep
// dive, not a loop. Any call that is not a read or a failure — an edit, a passing command, a
// teammate — is progress and resets everything.
// ponytail: fixed thresholds. Tune from eval traces; a per-task budget is the upgrade if these bite.
export const NUDGE_AFTER = 8;
export const STOP_AFTER = 6;

export type StallVerdict = "ok" | "nudge" | "stop";

const spins = (call: ToolCall, r: ToolResult): boolean =>
  READ_ONLY_TOOLS.has(call.name) || r.output.startsWith("error:") || (call.name === "shell" && /^exit (?!0\b)/.test(r.output));

export class StallGuard {
  private armed = false; // a file has been written this run
  private streak = 0; // consecutive stagnant rounds since the last progress
  private nudged = false;
  private sinceNudge = 0;
  private failing = false; // something in this streak failed or repeated
  private seen = new Set<string>();

  // One round: the calls the model made and what came back, in the same order.
  observe(calls: ToolCall[], results: ToolResult[]): StallVerdict {
    const wrote = calls.some((c, i) => WRITE_TOOLS.has(c.name) && !results[i]?.output.startsWith("error:"));
    const stagnant = !wrote && calls.length > 0 && calls.every((c, i) => results[i] !== undefined && spins(c, results[i]!));
    if (wrote) this.armed = true;
    if (!stagnant) {
      this.streak = this.sinceNudge = 0;
      this.nudged = this.failing = false;
      this.seen.clear();
      return "ok";
    }
    if (!this.armed) return "ok";
    this.streak++;
    calls.forEach((c, i) => {
      const key = `${c.name}:${JSON.stringify(c.input)}`;
      const failed = !READ_ONLY_TOOLS.has(c.name) || results[i]!.output.startsWith("error:"); // a stagnant non-read is a failing command
      if (failed || this.seen.has(key)) this.failing = true;
      this.seen.add(key);
    });
    if (this.nudged) {
      if (++this.sinceNudge >= STOP_AFTER && this.failing) return "stop";
      return "ok";
    }
    if (this.streak >= NUDGE_AFTER) {
      this.nudged = true;
      return "nudge";
    }
    return "ok";
  }

  get rounds(): number {
    return this.streak;
  }
}

export function stallNudge(rounds: number): string {
  return (
    `You have made ${rounds} rounds of tool calls since you last changed a file, and every one was a read or a failing command. ` +
    `Reading again or re-running the same check returns the same result until the code changes.\n\n` +
    `Do this now: state in one sentence what the failure is and which file and line cause it, then call edit or write_file to fix it. ` +
    `If you cannot fix it, stop and report exactly what is blocking you instead of continuing to look.`
  );
}
