import { READ_ONLY_TOOLS, WRITE_TOOLS } from "../tools/tools.ts";
import { firstError } from "./verify.ts";
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
//
// The other way to burn a turn budget is not to stop acting but to act without effect: edit, run the
// check, get the same error, edit again. Observed on `fix-what-it-broke`: five edits to two files,
// the same "TODO_BROKEN is not defined" after each, a check edited green and failing again. Every
// round there is progress by the rule above, so a second signal watches the *result*: a failing
// check is fingerprinted by its first error line, and a recurrence counts only if a write happened
// since it was last seen (re-running an unchanged check is the stall above, not this). A green run
// in between does not reset it — a check that was edited green and then fails again is the same
// failure, not a new one. The run is told at RECUR_NUDGE, and ended at RECUR_STOP — the very next attempt. Measured at 5 it ended at
// call 26 of 30, saving almost nothing; the two-call cost of each attempt is why the count is low.
export const RECUR_NUDGE = 3;
export const RECUR_STOP = 4; // one attempt after the nudge: a run that ignores it has shown it will not change course
// ponytail: fixed thresholds. Tune from eval traces; a per-task budget is the upgrade if these bite.
export const NUDGE_AFTER = 8;
export const STOP_AFTER = 6;

export type StallVerdict = "ok" | "nudge" | "stop";
export type StallKind = "idle" | "recurring";

const spins = (call: ToolCall, r: ToolResult): boolean =>
  READ_ONLY_TOOLS.has(call.name) || r.output.startsWith("error:") || (call.name === "shell" && /^exit (?!0\b)/.test(r.output));

export class StallGuard {
  private armed = false; // a file has been written this run
  private streak = 0; // consecutive stagnant rounds since the last progress
  private nudged = false;
  private sinceNudge = 0;
  private failing = false; // something in this streak failed or repeated
  private seen = new Set<string>();
  private epoch = 0; // successful writes so far
  private errors = new Map<string, { count: number; epoch: number }>(); // failing-check fingerprint → recurrences
  private nudgedErrors = new Set<string>();
  kind: StallKind = "idle"; // what the last nudge/stop was about
  detail = ""; // the recurring error, when kind is "recurring"

  // One round: the calls the model made and what came back, in the same order.
  observe(calls: ToolCall[], results: ToolResult[]): StallVerdict {
    const recur = this.observeRecurrence(calls, results);
    const idle = this.observeIdle(calls, results); // always: it owns the reset on progress
    if (recur !== "ok") return recur;
    if (idle !== "ok") this.kind = "idle";
    return idle;
  }

  private observeRecurrence(calls: ToolCall[], results: ToolResult[]): StallVerdict {
    if (calls.some((c, i) => WRITE_TOOLS.has(c.name) && !results[i]?.output.startsWith("error:"))) this.epoch++;
    let verdict: StallVerdict = "ok";
    calls.forEach((c, i) => {
      const out = results[i]?.output ?? "";
      if (c.name !== "shell" || !/^exit (?!0\b)/.test(out)) return;
      const fp = firstError(out)?.slice(0, 200);
      if (!fp) return;
      const e = this.errors.get(fp);
      if (!e) return void this.errors.set(fp, { count: 1, epoch: this.epoch });
      if (this.epoch === e.epoch) return; // same tree, same answer: not a new attempt
      e.count++;
      e.epoch = this.epoch;
      if (e.count >= RECUR_STOP) verdict = "stop";
      else if (e.count >= RECUR_NUDGE && !this.nudgedErrors.has(fp) && verdict !== "stop") {
        this.nudgedErrors.add(fp);
        verdict = "nudge";
      }
      if (verdict !== "ok") {
        this.kind = "recurring";
        this.detail = fp;
        this.recurCount = e.count;
      }
    });
    return verdict;
  }
  recurCount = 0;

  private observeIdle(calls: ToolCall[], results: ToolResult[]): StallVerdict {
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

export function recurringNudge(error: string, times: number): string {
  return (
    `The same failure has now come back after ${times} separate attempts to fix it:\n\n${error}\n\n` +
    `Variations of the same fix are not working, so stop varying it. Read that message literally: what does it say is wrong, and which line is it about? ` +
    `Fix that cause in the code the check is examining. Do not edit the check, its script or its configuration to make it stop complaining — ` +
    `that only hides the failure. If you cannot fix it, stop and report what is blocking you.`
  );
}

export function stallNudge(rounds: number): string {
  return (
    `You have made ${rounds} rounds of tool calls since you last changed a file, and every one was a read or a failing command. ` +
    `Reading again or re-running the same check returns the same result until the code changes.\n\n` +
    `Do this now: state in one sentence what the failure is and which file and line cause it, then call edit or write_file to fix it. ` +
    `If you cannot fix it, stop and report exactly what is blocking you instead of continuing to look.`
  );
}
