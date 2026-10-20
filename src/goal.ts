import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { extractJson, type Exchange } from "./orchestrator/planner.ts";
import { treeFingerprint, type WorktreeHandle } from "./orchestrator/worktree.ts";
import type { EventHub } from "./server/events.ts";

// /goal — a persistent objective. Each round is an ordinary run (plan → tasks → integrate); after
// it, the lead judges whether the objective is met. Not met → the next round starts with the
// judge's next step and any notes from the operator. It stops when the judge says done, a budget
// (rounds, tokens, dollars) is spent, two rounds in a row change nothing, or someone pauses or
// stops it. State lives in .niti/goal.json, so a restarted core shows the goal paused, never
// silently resumed.

export type GoalState = "running" | "paused" | "done" | "blocked" | "budget" | "rounds" | "stopped";

export interface Verdict {
  round: number;
  done: boolean;
  reason: string;
  next: string;
  changed: boolean; // the round left the tree different from how it found it
}

// What every client shows. Rides on a `goal` event and on POST /session.
export interface GoalStatus {
  objective: string;
  state: GoalState;
  reason: string; // why it is in that state ("judge: tests pass", "cancelled", "core restarted")
  round: number;
  maxRounds: number;
  used: { tokens: number; cost: number };
  budget: { tokens?: number; usd?: number };
  verdicts: Verdict[]; // most recent last, capped
  notes: string[]; // operator notes waiting for the next round
  error: boolean; // paused because something went wrong, not because someone asked
}

export interface RoundResult {
  kind?: "reply" | "answer" | "work";
  cancelled: boolean;
  summary: string;
  files: string[];
}

// The engine, as the loop sees it — kept narrow so the loop can be tested without a real team.
export interface GoalHost {
  readonly root: string;
  readonly hub: EventHub;
  readonly history: Exchange[];
  worktreeHandle?: WorktreeHandle;
  readonly busy: boolean;
  spent(): { tokens: number; cost: number };
  runRound(prompt: string, label: string, judge: (r: RoundResult) => Promise<Omit<Verdict, "round" | "changed">>): Promise<RoundResult & { verdict?: Omit<Verdict, "round" | "changed"> }>;
  ask(prompt: string, opts?: { json?: boolean }): Promise<string>; // the lead, read-only, inside the round's run
  stopRun(): void; // cancel the round in flight without pausing the goal (the caller sets the state)
  tellTeam(text: string): boolean; // deliver to the agents working right now; false = nobody is
  commitRound(message: string): Promise<void>;
}

const MAX_VERDICTS = 10;
const MAX_OUTCOMES = 6;
const STALL_ROUNDS = 2;
export const DEFAULT_ROUNDS = 20;
const JUDGE_MARK = "NITI-GOAL-JUDGE";

const VerdictJson = z.object({ done: z.boolean(), reason: z.string().default(""), next: z.string().default("") });

export function parseGoalArgs(args: string): { objective: string; rounds: number; tokens?: number; usd?: number } | string {
  let rest = args;
  const num = (flag: string): number | undefined => {
    const m = rest.match(new RegExp(`--${flag}[ =](\\S+)`));
    if (!m) return undefined;
    rest = rest.replace(m[0], "");
    const n = Number(m[1]!.replace(/^\$/, ""));
    return Number.isFinite(n) && n > 0 ? n : NaN;
  };
  const rounds = num("rounds");
  const tokens = num("tokens");
  const usd = num("usd");
  if ([rounds, tokens, usd].some((n) => Number.isNaN(n))) return "--rounds, --tokens and --usd take a positive number";
  const objective = rest.trim();
  if (!objective) return "usage: /goal <objective> [--rounds N] [--tokens N] [--usd N] · /goal pause|resume|stop|status|note <text>";
  return { objective, rounds: Math.floor(rounds ?? DEFAULT_ROUNDS), tokens, usd };
}

export class GoalLoop {
  status?: GoalStatus;
  private looping = false;
  private pauseAfterRound = false;
  private stalls = 0;
  private base = { tokens: 0, cost: 0 }; // spend when the goal (re)started, minus what it had used
  private outcomes: Exchange[] = [];
  private unwatch?: () => void;

  constructor(private host: GoalHost, private file = join(host.root, ".niti", "goal.json")) {}

  // A goal that holds the floor: no other run may start while it is running.
  get active(): boolean {
    return this.status?.state === "running";
  }

  // Running or paused — /clear refuses while one exists, so its usage and history can't vanish.
  get exists(): boolean {
    return this.status?.state === "running" || this.status?.state === "paused";
  }

  // /awake holds while the goal runs or a person paused it (so it can be resumed from a phone),
  // and lets go when it ends or pauses because something broke.
  get holdsAwake(): boolean {
    return this.active || (this.status?.state === "paused" && !this.status.error);
  }

  start(objective: string, budget: { rounds: number; tokens?: number; usd?: number }): string | undefined {
    if (this.exists) return "a goal is already active — /goal stop it first";
    if (this.host.busy) return "a task is running — cancel it first, or wait for it to finish";
    if (this.host.worktreeHandle) return `a previous run's worktree (${this.host.worktreeHandle.branch}) hasn't been merged — merge or discard it first`;
    this.status = {
      objective,
      state: "running",
      reason: "",
      round: 0,
      maxRounds: budget.rounds,
      used: { tokens: 0, cost: 0 },
      budget: { tokens: budget.tokens, usd: budget.usd },
      verdicts: [],
      notes: [],
      error: false,
    };
    this.stalls = 0;
    this.outcomes = [];
    this.pauseAfterRound = false;
    this.base = this.host.spent();
    this.publish();
    this.spawn();
    return undefined;
  }

  // Graceful: the round in flight finishes, then the goal waits.
  pause(): string {
    if (this.status?.state !== "running") return "no goal is running";
    if (!this.looping) {
      this.setState("paused", "paused");
      return "goal paused";
    }
    this.pauseAfterRound = true;
    return "pausing after this round — /cancel stops the round now";
  }

  // From Engine.cancel(): esc or /cancel during a goal stops the round and pauses the goal.
  onCancel(): void {
    if (this.status?.state === "running") this.setState("paused", "cancelled");
  }

  resume(): string {
    const s = this.status;
    if (s?.state === "running" && this.pauseAfterRound) {
      this.pauseAfterRound = false;
      return "not pausing after all — the goal keeps going";
    }
    if (!s || s.state !== "paused") return "no paused goal";
    if (this.host.busy) return "a task is running — wait for it to finish";
    if (s.round >= s.maxRounds) s.maxRounds = s.round + DEFAULT_ROUNDS; // resuming a finished budget is asking for more
    this.base = { tokens: this.host.spent().tokens - s.used.tokens, cost: this.host.spent().cost - s.used.cost };
    this.stalls = 0;
    this.pauseAfterRound = false;
    this.setState("running", "");
    this.spawn();
    return "goal resumed";
  }

  stop(): string {
    if (!this.exists) return "no goal is active";
    const wasRunning = this.looping;
    this.setState("stopped", "stopped by you");
    if (wasRunning) this.host.stopRun();
    return "goal stopped";
  }

  // An operator note: delivered now to whoever is working, and carried into the next round's prompt.
  note(text: string): string {
    const s = this.status;
    if (!this.exists || !s) return "no goal is active — start one with /goal <objective>";
    const sent = this.host.tellTeam(text);
    s.notes.push(sent ? `${text} (already sent mid-round)` : text);
    this.persist();
    this.publish();
    return sent ? "sent to the team, and kept for the next round" : "kept for the next round";
  }

  // Raise a spent budget, e.g. from the phone after the goal stopped at it.
  extend(more: { rounds?: number; tokens?: number; usd?: number }): string {
    const s = this.status;
    if (!s) return "no goal";
    if (more.rounds) s.maxRounds += more.rounds;
    if (more.tokens) s.budget.tokens = (s.budget.tokens ?? s.used.tokens) + more.tokens;
    if (more.usd) s.budget.usd = (s.budget.usd ?? s.used.cost) + more.usd;
    if (s.state === "budget" || s.state === "rounds") s.state = "paused";
    this.persist();
    this.publish();
    return s.state === "paused" ? "budget raised — /goal resume to continue" : "budget raised";
  }

  describe(): string {
    const s = this.status;
    if (!s) return "no goal — start one with /goal <objective>";
    const budget = [s.budget.tokens ? `${s.used.tokens}/${s.budget.tokens} tokens` : `${s.used.tokens} tokens`, s.budget.usd ? `$${s.used.cost.toFixed(2)}/$${s.budget.usd}` : `$${s.used.cost.toFixed(2)}`];
    const last = s.verdicts.at(-1);
    return [
      `goal    ${s.objective}`,
      `state   ${s.state}${s.reason ? ` — ${s.reason}` : ""}`,
      `round   ${s.round}/${s.maxRounds}`,
      `spent   ${budget.join(" · ")}`,
      ...(last ? [`judge   ${last.done ? "done" : "not yet"}: ${last.reason}${last.next ? ` → next: ${last.next}` : ""}`] : []),
      ...(s.notes.length ? [`notes   ${s.notes.join(" · ")}`] : []),
    ].join("\n");
  }

  // Boot: a goal the last core left behind comes back paused — a restart is not consent to spend.
  load(): void {
    if (!existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as { status?: GoalStatus; outcomes?: Exchange[]; worktree?: WorktreeHandle };
      if (!saved.status) return;
      this.status = saved.status;
      this.outcomes = saved.outcomes ?? [];
      this.host.history.push(...this.outcomes);
      if (saved.worktree && existsSync(saved.worktree.workDir) && !this.host.worktreeHandle) this.host.worktreeHandle = saved.worktree;
      if (this.status.state === "running") {
        this.status.state = "paused";
        this.status.reason = "core restarted";
        this.status.error = true;
        this.persist();
      }
      this.publish();
    } catch {
      console.error(`niti: ignoring unreadable ${this.file}`);
    }
  }

  // /clear on a goal that has ended: forget it.
  clear(): void {
    if (!this.status) return;
    this.status = undefined;
    this.outcomes = [];
    this.persist();
    this.publish();
  }

  private spawn(): void {
    if (this.looping) return;
    this.looping = true;
    this.watchBudget();
    this.loop()
      .catch((err) => this.setState("paused", `goal loop failed: ${err instanceof Error ? err.message : err}`, true))
      .finally(() => {
        this.looping = false;
        this.unwatch?.();
        this.unwatch = undefined;
      });
  }

  // Budget is checked as spend happens (usage is re-sent on every orchestration event), so one
  // round can't overshoot by a whole round's worth.
  private watchBudget(): void {
    this.unwatch?.();
    this.unwatch = this.host.hub.subscribe((e) => {
      if (e.kind !== "usage" || this.status?.state !== "running") return;
      try {
        this.measure();
        if (this.overBudget()) {
          this.setState("budget", "budget spent");
          this.host.stopRun();
        }
      } catch {
        /* a subscriber must never throw into publish() */
      }
    });
  }

  private measure(): void {
    const now = this.host.spent();
    this.status!.used = { tokens: now.tokens - this.base.tokens, cost: now.cost - this.base.cost };
  }

  private overBudget(): boolean {
    const s = this.status!;
    return (s.budget.tokens !== undefined && s.used.tokens >= s.budget.tokens) || (s.budget.usd !== undefined && s.used.cost >= s.budget.usd);
  }

  private async loop(): Promise<void> {
    const s = this.status!;
    while (s.state === "running") {
      if (s.round >= s.maxRounds) return this.setState("rounds", `${s.maxRounds} rounds used`);
      if (this.overBudget()) return this.setState("budget", "budget spent");
      s.round++;
      const notes = s.notes.splice(0);
      this.persist();
      this.publish();
      const workDir = this.host.worktreeHandle?.workDir ?? this.host.root;
      const before = await treeFingerprint(workDir);
      let result: Awaited<ReturnType<GoalHost["runRound"]>>;
      try {
        result = await this.host.runRound(this.roundPrompt(notes), `goal ${s.round}/${s.maxRounds}: ${s.objective}`, (r) => this.judge(r));
      } catch (err) {
        s.notes.unshift(...notes);
        return this.setState("paused", `round ${s.round} failed: ${err instanceof Error ? err.message : err}`, true);
      }
      this.measure();
      // Paused, stopped or out of budget mid-round: the state is already set.
      if (s.state !== "running") return void this.afterRound(result, before, workDir);
      if (result.cancelled) return this.setState("paused", "cancelled");
      const verdict = await this.afterRound(result, before, workDir);
      if (verdict.done) return this.setState("done", verdict.reason || "objective met");
      this.stalls = verdict.changed ? 0 : this.stalls + 1;
      if (this.stalls >= STALL_ROUNDS) return this.setState("blocked", `${STALL_ROUNDS} rounds in a row changed nothing — ${verdict.reason || "the team is stuck"}`);
      if (this.pauseAfterRound) {
        this.pauseAfterRound = false;
        return this.setState("paused", "paused");
      }
      this.persist();
      this.publish();
    }
  }

  // Commit the round (worktree mode), record what the judge said and what it changed.
  private async afterRound(result: RoundResult & { verdict?: Omit<Verdict, "round" | "changed"> }, before: string | undefined, workDir: string): Promise<Verdict> {
    const s = this.status!;
    const after = await treeFingerprint(workDir);
    const changed = result.kind === "work" && (before !== undefined && after !== undefined ? before !== after : result.files.length > 0);
    await this.host.commitRound(`niti goal round ${s.round}: ${s.objective.slice(0, 60)}`).catch(() => {});
    const verdict: Verdict = { round: s.round, changed, ...(result.verdict ?? { done: false, reason: "the judge gave no verdict", next: "" }) };
    s.verdicts.push(verdict);
    if (s.verdicts.length > MAX_VERDICTS) s.verdicts.splice(0, s.verdicts.length - MAX_VERDICTS);
    this.outcomes.push({ goal: `goal round ${s.round}: ${s.objective}`, outcome: result.summary || verdict.reason });
    if (this.outcomes.length > MAX_OUTCOMES) this.outcomes.splice(0, this.outcomes.length - MAX_OUTCOMES);
    this.persist();
    return verdict;
  }

  private roundPrompt(notes: string[]): string {
    const s = this.status!;
    const last = s.verdicts.at(-1);
    return [
      `Continue working toward this goal: ${s.objective}`,
      s.round === 1 ? "This is the first round — plan the first concrete piece of work and do it." : `Round ${s.round} of at most ${s.maxRounds}.`,
      ...(last && !last.done ? [`Last round's review: ${last.reason}`, ...(last.next ? [`Next step: ${last.next}`] : [])] : []),
      ...(notes.length ? ["Notes from the operator:", ...notes.map((n) => `- ${n}`)] : []),
      "Do real work in this round (write code, run checks); don't just describe it.",
    ].join("\n");
  }

  // Runs inside the round (so it is cancellable and holds the run). Never throws: a bad reply is
  // "not done", which the stall rule eventually turns into "blocked".
  private async judge(r: RoundResult): Promise<Omit<Verdict, "round" | "changed">> {
    const s = this.status!;
    const prompt = [
      `${JUDGE_MARK} You are judging whether a goal has been fully achieved.`,
      `Goal: ${s.objective}`,
      `Round ${s.round} summary: ${r.summary || "(none)"}`,
      `Files changed this round: ${r.files.length ? r.files.join(", ") : "none"}`,
      ...(s.verdicts.length ? [`Earlier reviews: ${s.verdicts.map((v) => `round ${v.round}: ${v.reason}`).join(" | ")}`] : []),
      `Check the project with your read-only tools rather than trusting the summary. Then answer ONLY with JSON:`,
      `{"done": true|false, "reason": "<one sentence>", "next": "<the single most useful next step, if not done>"}`,
    ].join("\n");
    try {
      const parsed = VerdictJson.safeParse(extractJson(await this.host.ask(prompt, { json: true })));
      if (parsed.success) return parsed.data;
      return { done: false, reason: "the judge's reply wasn't valid JSON", next: "" };
    } catch (err) {
      return { done: false, reason: `the judge failed: ${err instanceof Error ? err.message : err}`, next: "" };
    }
  }

  private setState(state: GoalState, reason: string, error = false): void {
    const s = this.status;
    if (!s) return;
    s.state = state;
    s.reason = reason;
    s.error = error;
    this.persist();
    this.publish();
  }

  private publish(): void {
    this.host.hub.publish({ kind: "goal", status: this.status ? structuredClone(this.status) : null });
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ status: this.status, outcomes: this.outcomes, worktree: this.status ? this.host.worktreeHandle : undefined }, null, 2));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error(`niti: could not save ${this.file}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
