import { parse, relative } from "node:path";
import { isHomeDir } from "./config/config.ts";
import { sandboxKind } from "./sandbox.ts";
import { Agent, type AgentConfig } from "./agent/agent.ts";
import { detectChecks, parseChecks } from "./agent/verify.ts";
import { repoMapSection } from "./agent/repomap.ts";
import { steeringFor } from "./agent/steering.ts";
import { Bus } from "./events/bus.ts";
import { MessageBus, USER, type Messenger } from "./messaging/message-bus.ts";
import { Orchestrator } from "./orchestrator/orchestrator.ts";
import { LockRegistry } from "./orchestrator/locks.ts";
import { ApprovalQueue } from "./approval.ts";
import { UsageTracker } from "./usage.ts";
import { defaultSettings, type RuntimeSettings } from "./settings.ts";
import { runProject, resumeProject, type RunnerDeps, type RunResult } from "./orchestrator/runner.ts";
import type { Exchange } from "./orchestrator/planner.ts";

const HISTORY_MAX = 6; // exchanges the planner sees — enough for follow-ups, bounded so planning stays cheap
// A merge or discard mid-run would commit half-done work, or delete the folder the agents are writing in.
const RUNNING = { ok: false, message: "a task is running in the worktree — cancel it first, or wait for it to finish" };
import { EventHub } from "./server/events.ts";
import type { Provider } from "./providers/provider.ts";
import type { McpTools } from "./mcp/mcp.ts";
import type { LspRegistry } from "./lsp/registry.ts";
import type { SessionStore } from "./store/session-store.ts";
import type { AuditLog } from "./store/audit-log.ts";
import { AUTO_RULES, type PermissionRules } from "./permissions.ts";
import { watchProject, type ProjectWatcher } from "./watch.ts";
import { TOOL_GUIDANCE, HASHLINE_GUIDANCE } from "./tools/tools.ts";
import { saveTasks, resumeConversation } from "./session.ts";
import { release as releaseAwake } from "./awake.ts";
import { GoalLoop, type GoalHost, type RoundResult } from "./goal.ts";
import { isGitRepo, createWorktree, diffStat, diffPatchZeroContext, commitPending, mergeBack, mergeFiles, removeWorktree, discardWorktree, abortMerge, type WorktreeHandle } from "./orchestrator/worktree.ts";

interface EngineOptions {
  configs: AgentConfig[];
  makeProvider: (cfg: AgentConfig) => Provider;
  root?: string;
  mcp?: McpTools;
  interactive?: boolean; // gate write_file/shell behind approvals (off for one-shot/scripting)
  systemSuffix?: string; // e.g. skills text appended to every system prompt
  store?: SessionStore; // present → conversations persist (resume, undo, session history)
  audit?: AuditLog; // present → tool calls + approval decisions append to a tamper-evident log
  permissions?: PermissionRules; // project-level tool policy from agents.yaml
  settings?: Partial<RuntimeSettings>; // autoCompact / thinkingMode from agents.yaml; both default on
  auto?: boolean; // --auto: approve anything not explicitly denied (dangerous commands still prompt)
  lsp?: LspRegistry; // present → diagnostics/hover available to every agent, alongside MCP
  watch?: boolean; // true → emit external_change events for edits made outside niti
  maxTurns?: number; // `maxTurns:` from agents.yaml — tool-loop cap per agent turn
  worktree?: boolean; // isolate each run's file writes in a fresh git worktree instead of the real root
  // `verify:` from agents.yaml. Command lines an agent's changes must pass before it may report
  // done; omitted → detected from the project (a typecheck/build script, go build, cargo check);
  // `verify: false` → nothing is run.
  verify?: string[] | false;
  // false → no generated project map in the system prompt. On by default; it is skipped
  // automatically for projects too small to need one.
  repoMap?: boolean;
  // false → shell commands run without the OS sandbox (src/sandbox.ts). On by default.
  sandbox?: boolean;
  // Saves the roster after a live model switch, so it survives a restart (saveAgents, from the
  // server/CLI). Absent → switches are live only, which is what a test-built engine wants.
  persist?: (configs: AgentConfig[]) => void;
}

// The Engine wires the whole multi-agent runtime: agents (with a live messenger so they can talk to
// each other), the orchestrator DAG, approvals, usage, locks, and a single EventHub that fans every
// signal out over one stream. Both the CLI (in-process) and the HTTP server drive the same Engine.
export class Engine {
  readonly bus = new Bus();
  readonly messageBus = new MessageBus();
  readonly orch = new Orchestrator();
  readonly approvals: ApprovalQueue;
  readonly usage = new UsageTracker();
  readonly locks: LockRegistry;
  readonly hub = new EventHub();
  readonly agents: Agent[] = [];
  readonly store?: SessionStore;
  readonly audit?: AuditLog;
  readonly root: string;
  // Public so the server can report what the project is wired to (the TUI sidebar lists both).
  readonly lsp?: LspRegistry;
  readonly mcp?: McpTools;
  // The run currently isolated in a worktree, if any — public so the server can report it over
  // GET /worktree. Persists across a run's end (manual merge, not auto-cleanup); a new worktree-mode
  // run refuses to start while one is still pending, so it's never silently orphaned.
  worktreeHandle?: WorktreeHandle;
  // Most recent goal submit()/resume() ran — /export's report header. Not persisted; a restart
  // loses it the same way the rest of the live session state does.
  lastGoal = "";
  // Headless only: tool calls refused because there was no one to approve them. A model can still
  // report its task "done" after every write was refused, so the CLI's exit code reads this rather
  // than trusting the task statuses alone.
  unapproved = 0;

  private makeProvider: (cfg: AgentConfig) => Provider;
  private persist?: (configs: AgentConfig[]) => void;
  private byId = new Map<string, Agent>();
  // agent id → the systemPrompt as written in agents.yaml, before any suffix was appended.
  private declaredPrompts = new Map<string, string>();
  private readonly permissionLayers: PermissionRules[];
  private busy = false;
  private cancelled = false;
  // Files the run in flight has edited (path → lines added/removed), for its summary and /goal.
  private runFiles = new Map<string, { added: number; removed: number }>();
  private watcher?: ProjectWatcher;
  private readonly worktreeEnabled: boolean;

  constructor(opts: EngineOptions) {
    this.makeProvider = opts.makeProvider;
    this.persist = opts.persist;
    this.store = opts.store;
    this.audit = opts.audit;
    this.approvals = new ApprovalQueue(opts.audit);
    this.root = opts.root ?? process.cwd();
    this.lsp = opts.lsp;
    this.mcp = opts.mcp;
    this.worktreeEnabled = opts.worktree ?? false;
    // A held lock is only reclaimable once its holder is actually finished — Agent.busy is the
    // authority, and it is in this process. `undefined` (an id we don't know) counts as not alive.
    this.locks = new LockRegistry(this.bus, undefined, (holder) => this.byId.get(holder)?.busy ?? false);
    // $HOME or a drive root is somewhere you launched from by accident, not a project: watching it
    // recursively and indexing it for the system prompt costs minutes of startup for no benefit.
    const broadRoot = isHomeDir(this.root) || this.root === parse(this.root).root;
    if (opts.watch && !broadRoot) {
      this.watcher = watchProject(this.root, (path) =>
        this.bus.publish({ agentId: "system", type: "external_change", payload: path, time: Date.now() }),
      );
    }

    // The messenger closes over the live agent registry: send() is fire-and-forget; ask() actually
    // invokes the peer's model and returns its answer (bounded by MAX_ASK_DEPTH).
    const messenger: Messenger = {
      peers: (self) => this.agents.filter((a) => a.config.id !== self).map((a) => ({ id: a.config.id, role: a.config.role })),
      send: (from, to, kind, subject, body, refs, fromSessionId) => {
        const r = this.messageBus.post({ from, to, kind, subject, body, refs, sessionId: fromSessionId });
        this.bus.publish({ agentId: from, type: "thought", payload: `→ ${to}: ${subject}`, time: Date.now() });
        return r.ok ? `delivered to ${r.delivered.join(", ")}` : `not delivered: ${r.reason}`;
      },
      ask: async (from, to, question, depth, fromSessionId) => {
        const target = this.byId.get(to);
        if (!target) return `no such teammate: ${to}`;
        // Enforce the edge authorization + rate cap here too (a blocked ask must NOT invoke the peer),
        // and use announce() so the synchronous question/answer aren't also queued into inboxes.
        const auth = this.messageBus.authorize(from, to);
        if (!auth.ok) return `cannot reach ${to}: ${auth.reason}`;
        // Both halves are tagged with the asking session: the answering session is already linked
        // to it by parent_session_id, so one session id is enough to reassemble the thread.
        this.messageBus.announce({ from, to, kind: "question", subject: question.slice(0, 70), body: question, sessionId: fromSessionId });
        const answer = await target.respond(question, depth, fromSessionId);
        this.messageBus.announce({ from: to, to: from, kind: "answer", subject: `re: ${question.slice(0, 50)}`, body: answer, sessionId: fromSessionId });
        return answer;
      },
      inbox: (id) => this.messageBus.drain(id),
      pending: (id) => this.messageBus.pending(id),
      remember: (from, key, value) => this.messageBus.remember(from, key, value),
      recall: (key) => this.messageBus.recall(key),
      notesVersion: () => this.messageBus.getNotesVersion(),
    };

    // Ordered least-specific-last: an agent's own block wins, then the project's, then --auto's
    // blanket allow — so an explicit project `deny` is never undone by --auto. Held as a field, and
    // mutated IN PLACE by setAuto(): every Agent is handed this same array object and re-spreads it
    // on each permission check, so splicing AUTO_RULES in or out flips the whole team live, with no
    // restart and no per-agent replumbing.
    const permissionLayers = [...(opts.permissions ? [opts.permissions] : []), ...(opts.auto ? [AUTO_RULES] : [])];
    this.permissionLayers = permissionLayers;
    const d = defaultSettings();
    this.settings = { autoCompact: opts.settings?.autoCompact ?? d.autoCompact, thinkingMode: opts.settings?.thinkingMode ?? d.thinkingMode };

    // Resolved once, at wiring time: detection reads package.json/go.mod off disk, and doing that
    // per task would re-read it on every one of them for an answer that cannot change mid-run.
    const checks = opts.verify === false ? [] : opts.verify ? parseChecks(opts.verify) : detectChecks(this.root);
    // Said once, up front: what the shell can and cannot touch here is not something to discover by
    // a command failing halfway through a task.
    if (opts.sandbox === false) {
      this.bus.publish({ agentId: "orchestrator", type: "warning", payload: "shell sandbox is off (sandbox: false in agents.yaml) — shell commands can write anywhere you can", time: Date.now() });
    } else if (sandboxKind() === "none") {
      this.bus.publish({ agentId: "orchestrator", type: "warning", payload: `no OS sandbox available on ${process.platform}${process.platform === "linux" ? " (install bubblewrap to enable one)" : ""} — shell commands are limited only by approvals`, time: Date.now() });
    }
    if (checks.length > 0) {
      this.bus.publish({ agentId: "orchestrator", type: "thought", payload: `verifying changes with: ${checks.map((c) => c.name).join(", ")}`, time: Date.now() });
    }

    // Built once, not per agent: it walks the tree and shells out to git, and every agent gets the
    // same map. Placed in the system prompt (ahead of the conversation) so a provider's cache
    // prefix still matches call to call — see anthropic.ts's cache_control placement.
    const mapSection = opts.repoMap === false || broadRoot ? "" : repoMapSection(this.root);

    for (const c of opts.configs) {
      this.declaredPrompts.set(c.id, c.systemPrompt);
      // Per agent, because two agents on the same team routinely run different model families.
      // Appended last so it qualifies the shared guidance rather than being buried above it.
      const cfg = { ...c, systemPrompt: c.systemPrompt + (opts.systemSuffix ?? "") + mapSection + TOOL_GUIDANCE + (c.editFormat === "hashline" ? HASHLINE_GUIDANCE : "") + steeringFor(c.provider, c.model) };
      // A missing key (revoked, keychain wiped, never set) must not take the whole server down —
      // that would crash boot before the handshake line prints, leaving the TUI staring at an EOF
      // with no way back in short of editing agents.yaml by hand. Defer the failure to first use,
      // same as switchModel already does; it surfaces through the normal per-agent error path below.
      let provider: Provider;
      try {
        provider = this.makeProvider(cfg);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        provider = { send: async () => { throw new Error(message); } };
      }
      const agent = new Agent(cfg, provider, this.bus, {
        root: this.root,
        // Headless has no TTY to prompt on, but `approve: undefined` skipped the guard entirely —
        // so a scripted run was *more* permissive than --auto, with no flag typed. Now it answers
        // the queue non-interactively: --auto means yes, anything else means no.
        approve: opts.interactive
          ? (tool, input, forceAsk) => this.approvals.request(c.id, tool, input, forceAsk)
          : async (tool) => {
              if (opts.auto) return true;
              this.unapproved++;
              this.bus.publish({
                agentId: c.id,
                type: "error",
                payload: `${tool} needs approval, and there's no one to ask — re-run with --auto, or pre-grant it via autoApprove/permissions in agents.yaml`,
                time: Date.now(),
              });
              return false;
            },
        mcp: opts.mcp,
        usageTracker: this.usage,
        locks: this.locks,
        messenger,
        store: this.store,
        audit: this.audit,
        permissionLayers,
        settings: this.settings,
        lsp: opts.lsp,
        onWrite: (path) => this.watcher?.markSelfWrite(path),
        sandbox: opts.sandbox !== false,
        maxTurns: opts.maxTurns,
        verify: checks,
        shouldStop: () => this.cancelled,
        abortSignal: () => this.abortCtl?.signal,
      });
      this.agents.push(agent);
      this.byId.set(c.id, agent);
      this.messageBus.register(c.id);
      for (const tool of c.autoApprove ?? []) this.approvals.grant(c.id, tool); // agents.yaml pre-grants
    }

    // Fan every source into the one hub the TUI/dashboard consume.
    this.bus.subscribe((e) => this.hub.publish({ kind: "agent_event", event: e, time: e.time }, e.type !== "delta" && e.type !== "tool_output"));
    this.messageBus.subscribe((m) => {
      // Notes get their own table (current state, latest write wins) — bus_messages stays a pure
      // log of every message ever sent, and a note isn't one of those.
      if (m.kind === "note") this.store?.upsertNote({ key: m.subject, value: m.body, from: m.from, time: m.time });
      else this.store?.recordMessage(m); // one place: both post() (queued) and announce() (synchronous ask) pass through here
      this.hub.publish({ kind: "agent_message", message: m, time: m.time });
    });
    this.approvals.onChange(() => this.hub.publish({ kind: "approval_request", requests: this.pendingApprovals() }));
    // Resume: reseed the notes board from disk so a note written before a restart is still visible.
    if (this.store) this.messageBus.hydrateNotes(this.store.listNotes());
    this.goal = new GoalLoop(this.goalHost());
  }

  // /goal — see goal.ts. Loaded from .niti/goal.json by the server at boot (GoalLoop.load), not
  // here, so an engine built in a test never picks up whatever a real session left behind.
  readonly goal: GoalLoop;

  private goalHost(): GoalHost {
    const engine = this;
    return {
      root: this.root,
      hub: this.hub,
      history: this.history,
      get worktreeHandle() {
        return engine.worktreeHandle;
      },
      set worktreeHandle(h) {
        engine.worktreeHandle = h;
      },
      get busy() {
        return engine.busy;
      },
      spent: () => ({ tokens: this.totalTokens(), cost: this.cost().cost }),
      runRound: async (prompt, label, judge) => {
        let verdict: Awaited<ReturnType<typeof judge>> | undefined;
        const r = await this.submit(prompt, {
          goalRound: true,
          label,
          // Inside the run: covered by `busy` and the abort controller, so /cancel stops it too.
          after: async (round) => {
            verdict = await judge(round);
          },
        });
        return { ...r, verdict };
      },
      // Read-only tools, so the judge can check the work rather than take the summary's word for it.
      ask: (prompt) => this.lead().answer(prompt),
      stopRun: () => this.cancel(),
      tellTeam: (text) => this.tellTeam(text),
      commitRound: async (message) => {
        if (this.worktreeHandle) await commitPending(this.worktreeHandle, message);
      },
    };
  }

  private lead(): Agent {
    const lead = this.agents.find((a) => a.config.lead) ?? this.agents[0];
    if (!lead) throw new Error("no agents configured");
    return lead;
  }

  // An operator note for whoever is working right now. While the lead is still planning it goes to
  // the whole team once (the work may land on anyone); otherwise to each agent mid-task. False when
  // nobody is working — the caller keeps it for the next round instead.
  tellTeam(text: string): boolean {
    const working = this.agents.filter((a) => a.busy).map((a) => a.config.id);
    if (!this.busy || !working.length) return false;
    const planning = !this.orch.all.some((t) => t.status === "in_progress");
    const targets = planning ? ["*"] : working;
    for (const to of targets) this.messageBus.post({ from: USER, to, kind: to === "*" ? "broadcast" : "handoff", subject: text.slice(0, 70), body: text });
    for (const id of working) this.bus.publish({ agentId: id, type: "message", payload: `[from user] ${text}`, time: Date.now() });
    return true;
  }

  // The *declared* prompt, not the augmented one. Agents run with systemPrompt + skills text +
  // TOOL_GUIDANCE appended; exposing that over GET /agents meant the dashboard round-tripped it
  // back through POST /agents into agents.yaml, and the next boot appended the suffix again — the
  // stored prompt grew by the whole guidance block on every save.
  get configs(): readonly AgentConfig[] {
    return this.agents.map((a) => {
      const declared = this.declaredPrompts.get(a.config.id);
      return declared === undefined ? a.config : { ...a.config, systemPrompt: declared };
    });
  }

  // A run is in flight, or a goal holds the floor between its rounds.
  get running(): boolean {
    return this.busy || this.goal.active;
  }

  pendingApprovals(): { id: number; agentId: string; tool: string; input: Record<string, unknown>; dangerous: boolean }[] {
    return this.approvals.queued().map((r) => ({ id: r.id, agentId: r.agentId, tool: r.tool, input: r.input, dangerous: r.forceAsk }));
  }

  // Run a goal end-to-end: plan → schedule → integrate. Emits session start/end and persists tasks.
  // planOnly stops after the DAG is built, so you can read the plan (and edit agents.yaml, or say
  // it differently) before any agent writes a file — the TUI's PLAN mode.
  //
  // For /goal: `label` is what clients and the planner's memory see instead of the long round
  // prompt, `goalRound` lets the goal's own rounds through while it holds the floor (and continues
  // in its worktree), and `after` runs inside the run once
  // the work is done (the goal's judge) — so it holds the run and /cancel stops it.
  async submit(
    goal: string,
    opts: { planOnly?: boolean; goalRound?: boolean; label?: string; after?: (r: RoundResult) => Promise<void> } = {},
  ): Promise<RoundResult> {
    // A fresh goal gets no priorTurns (nothing from an earlier run's task transcripts bleeds in), but
    // it does get the recent exchanges, so "now add tests" knows what "it" was.
    this.lastSummary = undefined;
    let result: RunResult | undefined;
    const label = opts.label ?? goal;
    await this.runSession(
      label,
      async (deps) => {
        result = await runProject(goal, this.agents, this.orch, this.bus, { ...deps, planOnly: opts.planOnly, history: this.history });
        if (opts.after && !this.cancelled) await opts.after(this.roundResult(result));
      },
      () => result?.kind === "work" && !opts.planOnly, // a chat reply or an answer gets no summary card
      opts.goalRound,
    );
    const outcome = result?.text ?? this.lastSummary ?? `${this.orch.all.filter((t) => t.status === "done").length} of ${this.orch.all.length} tasks done`;
    this.history.push({ goal: label, outcome });
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
    return this.roundResult(result);
  }

  private roundResult(result: RunResult | undefined): RoundResult {
    return { kind: result?.kind, cancelled: this.cancelled, summary: this.lastSummary ?? result?.text ?? "", files: [...this.runFiles.keys()] };
  }

  // Conversation memory for the planner (see Exchange). /clear empties it along with the board.
  readonly history: Exchange[] = [];
  private abortCtl?: AbortController; // the current run's; cancel() aborts it
  private lastSummary?: string; // the lead's integrate summary for the run in progress
  private lastNext: string[] = []; // …and its suggested next prompts

  // Continue the tasks a previous session left unfinished, each agent seeded with that task's
  // stored conversation. Requires a store — without one there is no history to resume from.
  async resume(): Promise<void> {
    const store = this.store;
    this.lastSummary = undefined;
    await this.runSession("(resumed session)", (deps) =>
      resumeProject(this.agents, this.orch, this.bus, {
        ...deps,
        // Scoped to the agent that owns the task, so a failed-over task never replays another
        // agent's transcript as its own history.
        priorTurns: store
          ? (taskId) => {
              const owner = this.orch.all.find((t) => t.id === taskId)?.assignedTo;
              return resumeConversation(store, taskId, owner, owner ? this.byId.get(owner)?.config.provider : undefined);
            }
          : undefined,
      }),
    );
  }

  private async runSession(goal: string, run: (deps: RunnerDeps) => Promise<unknown>, summarize: () => boolean = () => true, goalRound = false): Promise<void> {
    if (this.busy || (this.goal.active && !goalRound)) throw new Error("a task is already running");
    // Claimed before the first await below: worktree setup is async, and a second submit arriving
    // during it used to pass the check above and start a second run beside the first.
    this.busy = true;
    try {
      if (this.worktreeEnabled && goalRound && this.worktreeHandle) {
        // A goal's later rounds continue in the worktree its first round made.
        for (const a of this.agents) a.setRoot(this.worktreeHandle.workDir);
      } else if (this.worktreeEnabled) {
        if (this.worktreeHandle) {
          throw new Error(`a previous run's worktree (${this.worktreeHandle.branch}) hasn't been merged yet — merge or discard it first`);
        }
        if (!(await isGitRepo(this.root))) throw new Error("worktree isolation requires a git repository");
        // ponytail: a fresh worktree per run, off current HEAD — a run started before an earlier
        // worktree's work is merged won't see it. Upgrade to stacking/rebasing onto the pending
        // worktree's branch if that gap matters in practice.
        this.worktreeHandle = await createWorktree(this.root, crypto.randomUUID().slice(0, 8));
        for (const a of this.agents) a.setRoot(this.worktreeHandle.workDir);
      }
    } catch (err) {
      this.busy = false;
      throw err;
    }
    this.cancelled = false;
    this.abortCtl = new AbortController();
    this.lastGoal = goal;
    this.lastNext = [];
    this.hub.publish({ kind: "session", state: "started", goal });
    // What this run changed, for the summary card: +/- per file, summed over every edit to it.
    const started = Date.now();
    const before = { tokens: this.totalTokens(), cost: this.cost().cost };
    const files = new Map<string, { added: number; removed: number }>();
    this.runFiles = files;
    const stopWatching = this.bus.subscribe((e) => {
      if (e.type !== "file_edit" || !e.path || e.phase !== "end") return;
      const f = files.get(e.path) ?? { added: 0, removed: 0 };
      f.added += e.added ?? 0;
      f.removed += e.removed ?? 0;
      files.set(e.path, f);
    });
    try {
      await run({
        messageBus: this.messageBus,
        onOrchestration: (e) => {
          this.hub.publish({ kind: "orchestration", event: e, time: e.time });
          if (e.type === "integrate") {
            this.lastSummary = e.summary;
            this.lastNext = e.next ?? [];
          }
          // Persisted on every board change, not only after a clean finish — a crash or kill
          // mid-run used to leave `niti resume` reloading the board from the run before.
          saveTasks(this.orch.all);
          this.emitUsage();
          this.emitLocks();
        },
        shouldStop: () => this.cancelled,
      });
    } finally {
      stopWatching();
      saveTasks(this.orch.all); // persist so `niti resume` can reload
      this.busy = false;
      this.abortCtl = undefined; // an aborted controller left behind made every later ask() throw "interrupted"
      if (this.worktreeEnabled) for (const a of this.agents) a.setRoot(this.root); // LSP/watcher never left the real root
      this.emitUsage();
      if (summarize()) {
        const cost = this.cost();
        this.hub.publish({
          kind: "turn_summary",
          goal,
          ok: this.orch.all.length > 0 && this.orch.all.every((t) => t.status === "done"),
          cancelled: this.cancelled,
          summary: this.lastSummary ?? "",
          next: this.lastNext,
          files: [...files].map(([path, f]) => ({ path, ...f })),
          durationMs: Date.now() - started,
          tokens: this.totalTokens() - before.tokens,
          cost: cost.cost - before.cost,
          costKnown: cost.costKnown,
        });
      }
      this.hub.publish({ kind: "session", state: this.cancelled ? "cancelled" : "ended" });
    }
  }

  // POST /worktree/discard — the escape hatch the "merge or discard it first" error promised but
  // never had. Without it a merge conflict wedged the engine permanently: worktreeHandle stayed
  // set, so every later worktree-mode run refused to start and there was no way to clear it.
  async discardWorktree(): Promise<{ ok: boolean; message: string }> {
    const handle = this.worktreeHandle;
    if (!handle) return { ok: false, message: "no pending worktree" };
    if (this.running) return RUNNING;
    try {
      await discardWorktree(this.root, handle);
    } catch (err) {
      return { ok: false, message: `could not discard: ${err instanceof Error ? err.message : err}` };
    }
    this.worktreeHandle = undefined;
    this.bus.publish({ agentId: "orchestrator", type: "warning", payload: `discarded worktree ${handle.branch}`, time: Date.now() });
    return { ok: true, message: `discarded ${handle.branch} — its changes are gone` };
  }

  // Status for GET /worktree — undefined when no run is currently isolated.
  async worktreeStatus(): Promise<{ path: string; branch: string; diffStat: string } | undefined> {
    if (!this.worktreeHandle) return undefined;
    return { path: this.worktreeHandle.path, branch: this.worktreeHandle.branch, diffStat: await diffStat(this.worktreeHandle) };
  }

  // GET /worktree/hunks?path=<file> — zero-context per-file diff for the IDE's per-hunk review.
  // Computed on demand for one file at a time rather than folded into worktreeStatus (which the
  // dashboard polls repeatedly): most polls don't need hunk-level detail, only opening a specific
  // file's review does.
  async worktreeFileHunks(path: string): Promise<string | undefined> {
    if (!this.worktreeHandle) return undefined;
    return diffPatchZeroContext(this.worktreeHandle, path);
  }

  // POST /worktree/merge — explicit user action, never automatic. Cleans up the worktree only on a
  // successful merge. With `files`, only those are brought in and the rest is thrown away with the
  // worktree: a reviewer who picked files has decided against the others, and keeping the branch
  // "in case" just accumulates abandoned ones (same reasoning as discardWorktree).
  async mergeWorktree(files?: string[]): Promise<{ ok: boolean; message: string }> {
    const handle = this.worktreeHandle;
    if (!handle) return { ok: false, message: "no active worktree" };
    if (this.running) return RUNNING;
    await commitPending(handle); // agents write files directly, never commit as they go
    const result = files ? await mergeFiles(this.root, handle.branch, files) : await mergeBack(this.root, handle.branch);
    if (result.ok) {
      await removeWorktree(this.root, handle.path);
      this.worktreeHandle = undefined;
      return result;
    }
    if (files) return result; // a selective checkout leaves no merge in progress to undo
    // A failed merge left the user's repo sitting mid-merge with conflict markers in their files,
    // which they then had to discover and unpick by hand. Put the tree back and tell them the two
    // ways forward.
    await abortMerge(this.root);
    return {
      ok: false,
      message: `${result.message}\n\nYour working tree was restored. Resolve it on branch ${handle.branch}, or POST /worktree/discard to throw the run away.`,
    };
  }

  // /auto and /manual, and the team picker's setup question. Toggling approval mode for a live
  // session is just adding or removing the blanket-allow layer — an explicit project `deny` still
  // wins either way, and dangerous or project-escaping commands still force a prompt (see agent.ts).
  // Live toggles shared by reference with every agent (see settings.ts).
  readonly settings: RuntimeSettings;

  setAuto(on: boolean): void {
    const at = this.permissionLayers.indexOf(AUTO_RULES);
    if (on && at === -1) this.permissionLayers.push(AUTO_RULES);
    if (!on && at !== -1) this.permissionLayers.splice(at, 1);
  }

  get auto(): boolean {
    return this.permissionLayers.includes(AUTO_RULES);
  }

  cancel(): void {
    this.cancelled = true;
    this.goal.onCancel(); // esc or /cancel during a goal stops the round and pauses the goal
    this.abortCtl?.abort(); // and stop the model calls in flight, not just the next turn
    // An agent parked on an approval is not "in flight" in any useful sense — it is waiting on a
    // human who has just said stop. Without this the promise never settles: the agent never
    // returns, `busy` stays true, and no further submit() is ever possible.
    this.approvals.denyAll();
  }

  // When this session began — construction, or the last /clear. /rewind only reaches writes from
  // after it: the checkpoint table outlives restarts, and a fresh launch must not be able to
  // revert last week's edit.
  private sessionStart = Date.now();

  // /rewind [n]: revert the last n file writes an agent made this session (see
  // SessionStore.rewindN). Files only — a shell command's effects were never checkpointed. Refused
  // mid-run, where it would race the very writes it reverts. Each step is published under the
  // agent that made the write, so the TUI's Files panel and that agent's transcript follow it.
  rewind(n: number): string {
    if (!this.store) return "rewind needs a session store (run through the CLI or server)";
    if (this.running) return "a task is running — cancel it first, or wait for it to finish";
    const results = this.store.rewindN(n, undefined, this.sessionStart);
    if (results.length === 0) return "nothing to rewind";
    const shown = results.map((r) => ({ ...r, rel: relative(this.root, r.path) || r.path }));
    for (const r of shown) {
      this.bus.publish({
        agentId: r.agentId ?? "orchestrator",
        type: "file_edit",
        payload: `rewind: ${r.action} ${r.rel}`,
        time: Date.now(),
        path: r.rel,
        phase: "end",
      });
    }
    const why = { skipped: " (its directory is gone)", kept: " (it changed after that write — left as it is)" } as Record<string, string>;
    const summary = shown.map((r) => `${r.action} ${r.rel}${why[r.action] ?? ""}`).join("\n  ");
    return results.length === 1 ? `rewound 1 step: ${summary}` : `rewound ${results.length} steps:\n  ${summary}`;
  }

  // /clear: a fresh session, not just an empty board. Everything that carries the last session
  // forward is dropped — the board, the planner's conversation, token counters, agent-to-agent
  // mail and team notes, the undo stack, the stored conversations (archived, not deleted) and the
  // replay buffer — then one `session_reset` tells every connected client to wipe its view.
  // Kept on purpose: the approval "always allow" scopes, the audit log, config and the roster.
  resetSession(): number {
    const n = this.orch.all.length;
    this.orch.clear();
    this.history.length = 0;
    this.lastGoal = "";
    this.lastSummary = undefined;
    this.lastNext = [];
    this.usage.reset();
    this.messageBus.reset();
    for (const a of this.agents) a.resetSession();
    this.store?.clearSession();
    this.sessionStart = Date.now();
    this.hub.clear();
    this.hub.publish({ kind: "session_reset" });
    this.emitUsage(); // zeros, so a client's totals don't wait for the next call to update
    return n;
  }

  // /debate: two agents (each already carrying its own provider/model, so this works cross-provider
  // for free) alternate no-tools, read-only turns (Agent.ask — no side effects, this is a
  // discussion, not agents editing files) responding to each other, then one of them synthesizes a
  // consensus recommendation. Each turn is published to the bus so it streams live in both the TUI
  // and the web dashboard, same as any agent message. Explicit agent ids only — no auto-selection
  // heuristic, since the caller (the /debate command) already knows the roster.
  //
  // It is a run like any other while it lasts: it holds `busy` (so a task, another debate or a
  // model switch can't collide with it), announces itself with session events (so clients show a
  // run in progress) and owns the abort controller (so /cancel stops it between model calls). A
  // provider failure or a cancel ends it early, and what was said so far is still returned.
  async debate(agentAId: string, agentBId: string, question: string, rounds = 3): Promise<string> {
    const a = this.byId.get(agentAId);
    const b = this.byId.get(agentBId);
    if (!a || !b) return `no such agent: ${!a ? agentAId : agentBId}`;
    if (a === b) return "debate needs two different agents";
    if (this.running) return "a task is running — cancel it first, or wait for it to finish";

    this.busy = true;
    this.cancelled = false;
    this.abortCtl = new AbortController();
    this.hub.publish({ kind: "session", state: "started", goal: `debate: ${question}` });

    const turns: string[] = [];
    let synthesis = "";
    let stopped: string | undefined;
    try {
      for (let i = 0; i < rounds * 2; i++) {
        const [speaker, speakerId, otherId] = i % 2 === 0 ? ([a, agentAId, agentBId] as const) : ([b, agentBId, agentAId] as const);
        const prompt = [
          `You are ${speakerId}, debating this question with ${otherId}:`,
          question,
          "",
          turns.length ? `Conversation so far:\n${turns.join("\n\n")}` : "You go first.",
          "",
          "Respond to the other side's last point — agree or push back, with a reason. A few sentences, no tools.",
        ].join("\n");
        const reply = await speaker.ask(prompt);
        turns.push(`${speakerId}: ${reply}`);
        this.bus.publish({ agentId: speakerId, type: "message", payload: reply, time: Date.now() });
      }
      synthesis = await a.ask(
        [`Debate transcript on: ${question}`, "", turns.join("\n\n"), "", "Synthesize a consensus recommendation from this exchange — what should actually be done, and why."].join("\n"),
      );
      this.bus.publish({ agentId: agentAId, type: "message", payload: `[debate synthesis] ${synthesis}`, time: Date.now() });
    } catch (err) {
      stopped = this.cancelled ? "cancelled" : err instanceof Error ? err.message : String(err);
      if (!this.cancelled) this.bus.publish({ agentId: agentAId, type: "error", payload: `debate stopped: ${stopped}`, time: Date.now() });
    } finally {
      this.busy = false;
      this.abortCtl = undefined;
      // `message` events mark an agent as working and nothing else marks it finished.
      for (const id of [agentAId, agentBId]) this.bus.publish({ agentId: id, type: "done", payload: "", time: Date.now() });
      this.hub.publish({ kind: "session", state: this.cancelled ? "cancelled" : "ended" });
    }

    // The full exchange, not just the verdict — seeing how the two sides got there is the point of
    // a debate.
    return [
      `## Debate: ${agentAId} vs ${agentBId}`,
      "",
      turns.join("\n\n"),
      "",
      ...(stopped ? [`## Stopped early: ${stopped}`] : ["## Synthesis", "", synthesis]),
    ].join("\n");
  }

  // Web control center: inject a message into one specific already-running agent, so it's picked
  // up on that agent's next loop iteration — no new agent-side plumbing needed, this reuses the
  // same inbox mechanism send_message/ask_agent already deliver through (Agent.injectInbox drains
  // messageBus and pushes it as a user turn), just posted by "user" instead of a peer agent. Only
  // valid while the agent is actually running: posting to an idle one would just sit in its inbox
  // until its next unrelated run, which isn't what "mid-task" means. Returns an error string, or
  // undefined on success.
  //
  // "Delivered" is a real promise, not a hopeful one: an agent whose current turn would otherwise
  // have ended the run keeps looping while its inbox is non-empty (see Agent.run), so a nudge
  // that lands on the last turn is still read rather than stranded until the next run.
  messageAgent(agentId: string, text: string): string | undefined {
    const agent = this.byId.get(agentId);
    if (!agent) return `no such agent: ${agentId}`;
    if (!agent.busy) return `${agentId} isn't running — nothing to interrupt`;
    // Before any task has started, the "working" agent is the lead making the plan — and the work
    // may go to someone else. A nudge then belongs to whoever does the work, so it goes to the team.
    const planning = this.busy && !this.orch.all.some((t) => t.status === "in_progress");
    const result = this.messageBus.post({ from: USER, to: planning ? "*" : agentId, kind: planning ? "broadcast" : "handoff", subject: text.slice(0, 70), body: text });
    if (!result.ok) return result.reason;
    // messageBus.post already fans out an `agent_message` SSE event (so it shows in the Messages
    // tab / feed); this additionally puts it in the agent's own transcript, matching how the
    // agent's own tool calls and thoughts appear there.
    this.bus.publish({ agentId, type: "message", payload: `[from user] ${text}`, time: Date.now() });
    return undefined;
  }

  // Interrupt one agent, the way esc interrupts Claude Code: the model call or tool it is in is
  // abandoned (an approval it waits on is refused), and it carries on from the operator's message
  // instead of failing its task. Only for an agent working on a task — one that is only planning or
  // answering a teammate gets the message as a plain steer (aborting those would break the plan or
  // the teammate's question). MCP/LSP calls, file-lock waits and a teammate's ask_agent answer
  // finish before it lands. Returns an error string, or undefined on success.
  interruptAgent(agentId: string, text?: string): string | undefined {
    const agent = this.byId.get(agentId);
    if (!agent) return `no such agent: ${agentId}`;
    if (!agent.busy) return `${agentId} isn't running — nothing to interrupt`;
    const message = text?.trim() || "The operator interrupted you. Stop, reconsider what you were doing, and continue only if it is still the right step.";
    const onTask = this.orch.all.some((t) => t.status === "in_progress" && t.assignedTo === agentId);
    if (!onTask) return this.messageAgent(agentId, message);
    // Message first, so the loop finds it the moment the step is abandoned.
    const posted = this.messageBus.post({ from: USER, to: agentId, kind: "handoff", subject: message.slice(0, 70), body: message });
    if (!posted.ok) return posted.reason;
    this.bus.publish({ agentId, type: "message", payload: `[interrupted by user] ${message}`, time: Date.now() });
    this.approvals.denyAll(agentId);
    agent.interrupt();
    return undefined;
  }

  // Live model switch for the focused agent (drives /model + POST /model). Returns an error string
  // (missing key, unknown provider) or undefined on success.
  switchModel(agentId: string, provider: string, model: string, baseURL?: string): string | undefined {
    const agent = this.byId.get(agentId);
    if (!agent) return `no such agent: ${agentId}`;
    // Swapping providers mid-loop would send a turn history built for one provider (e.g.
    // Anthropic's opaque `raw` thinking blocks) to a different provider's send() — reject instead
    // of corrupting an in-flight conversation.
    if (agent.busy) return `${agentId} is mid-task — wait for it to finish (or /cancel) before switching its model`;
    // Same provider, no new URL given: keep the agent's own. Otherwise `/model coder custom/other`
    // dropped the baseURL a custom/Ollama/LM Studio agent cannot work without.
    // `||`, not `??`: the TUI's model picker sends "" for "no URL given".
    const url = baseURL || (provider === agent.config.provider ? agent.config.baseURL : undefined);
    try {
      const p = this.makeProvider({ ...agent.config, provider, model, baseURL: url });
      agent.reconfigure(provider, model, p, url);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    // Saved, or a restart quietly put every agent back on its old model. A refused save (an
    // agents.yaml with a YAML error) leaves the switch live and says so, rather than undoing it.
    try {
      this.persist?.([...this.configs]);
    } catch (err) {
      this.bus.publish({ agentId, type: "warning", payload: `switched for this session, but not saved: ${err instanceof Error ? err.message : err}`, time: Date.now() });
    }
    return undefined;
  }

  // A provider's key changed (POST /auth, the TUI's /api): every agent on that provider was built
  // with the old key and would keep failing with it until a restart. Rebuild their clients now.
  // Same provider, same model — only the key differs — so unlike switchModel this is safe mid-task:
  // the next call goes out with the new key. Returns the agents that picked it up.
  refreshProvider(provider: string): string[] {
    const refreshed: string[] = [];
    for (const [id, agent] of this.byId) {
      if (agent.config.provider !== provider) continue;
      try {
        agent.reconfigure(provider, agent.config.model, this.makeProvider(agent.config), agent.config.baseURL);
        refreshed.push(id);
      } catch {
        // still no usable key for it — it keeps failing through its normal error path
      }
    }
    return refreshed;
  }

  // User-triggered task reassignment (drives POST /reassign). Only pending tasks are eligible — see
  // Orchestrator.reassign. Publishes on hub, same broadcast path runProject's onOrchestration uses,
  // so every connected client (TUI, web, desktop) picks up the move, not just the caller.
  reassignTask(taskId: string, agentId: string): string | undefined {
    if (!this.byId.get(agentId)) return `no such agent: ${agentId}`;
    const err = this.orch.reassign(taskId, agentId);
    if (err) return err;
    const event = { type: "reassign" as const, taskId, role: agentId, time: Date.now() };
    this.hub.publish({ kind: "orchestration", event, time: event.time });
    return undefined;
  }

  // Release the long-lived subprocess/OS resources (file watcher, language servers). The agents,
  // task board and event history stay readable afterwards — this ends background work, not state.
  close(): void {
    this.watcher?.close();
    this.lsp?.close();
    releaseAwake();
  }

  private totalTokens(): number {
    const t = this.usage.totals();
    return t.inputTokens + t.outputTokens;
  }

  emitUsage(): void {
    this.hub.publish({
      kind: "usage",
      agents: this.usage.snapshot(),
      totals: this.usage.totals(),
      rateLimits: this.usage.rateLimits_(),
      ...this.cost(),
    });
  }

  // Session cost so far. Each call is priced when it is recorded, at the model that made it (a mixed
  // team bills at mixed rates, and a /model switch must not reprice what came before). `costKnown`
  // is false when any call's model isn't in the price table, so the UI can show "$0.42+".
  private cost(): { cost: number; costKnown: boolean } {
    const all = this.usage.snapshot();
    return { cost: all.reduce((sum, { usage }) => sum + usage.usd, 0), costKnown: all.every(({ usage }) => !usage.unpriced) };
  }

  emitLocks(): void {
    const holders = [...this.locks.byHolder()].flatMap(([holder, paths]) => paths.map((path) => ({ holder, path })));
    this.hub.publish({ kind: "lock", holders });
  }
}
