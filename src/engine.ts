import { relative } from "node:path";
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
import { runProject, resumeProject, type RunnerDeps } from "./orchestrator/runner.ts";
import { EventHub } from "./server/events.ts";
import type { Provider } from "./providers/provider.ts";
import type { McpTools } from "./mcp/mcp.ts";
import type { LspRegistry } from "./lsp/registry.ts";
import type { SessionStore } from "./store/session-store.ts";
import type { AuditLog } from "./store/audit-log.ts";
import { AUTO_RULES, type PermissionRules } from "./permissions.ts";
import { costOf } from "./providers/pricing.ts";
import { watchProject, type ProjectWatcher } from "./watch.ts";
import { TOOL_GUIDANCE } from "./tools/tools.ts";
import { saveTasks, resumeConversation } from "./session.ts";
import { isGitRepo, createWorktree, diffStat, diffPatchZeroContext, commitPending, mergeBack, mergeFiles, removeWorktree, discardWorktree, abortMerge, type WorktreeHandle } from "./orchestrator/worktree.ts";

export interface EngineOptions {
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

  private makeProvider: (cfg: AgentConfig) => Provider;
  private byId = new Map<string, Agent>();
  // agent id → the systemPrompt as written in agents.yaml, before any suffix was appended.
  private declaredPrompts = new Map<string, string>();
  private readonly permissionLayers: PermissionRules[];
  private busy = false;
  private cancelled = false;
  private watcher?: ProjectWatcher;
  private readonly worktreeEnabled: boolean;

  constructor(opts: EngineOptions) {
    this.makeProvider = opts.makeProvider;
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
    if (opts.watch) {
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
    if (checks.length > 0) {
      this.bus.publish({ agentId: "orchestrator", type: "thought", payload: `verifying changes with: ${checks.map((c) => c.name).join(", ")}`, time: Date.now() });
    }

    // Built once, not per agent: it walks the tree and shells out to git, and every agent gets the
    // same map. Placed in the system prompt (ahead of the conversation) so a provider's cache
    // prefix still matches call to call — see anthropic.ts's cache_control placement.
    const mapSection = opts.repoMap === false ? "" : repoMapSection(this.root);

    for (const c of opts.configs) {
      this.declaredPrompts.set(c.id, c.systemPrompt);
      // Per agent, because two agents on the same team routinely run different model families.
      // Appended last so it qualifies the shared guidance rather than being buried above it.
      const cfg = { ...c, systemPrompt: c.systemPrompt + (opts.systemSuffix ?? "") + mapSection + TOOL_GUIDANCE + steeringFor(c.provider, c.model) };
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
        maxTurns: opts.maxTurns,
        verify: checks,
        shouldStop: () => this.cancelled,
      });
      this.agents.push(agent);
      this.byId.set(c.id, agent);
      this.messageBus.register(c.id);
      for (const tool of c.autoApprove ?? []) this.approvals.grant(c.id, tool); // agents.yaml pre-grants
    }

    // Fan every source into the one hub the TUI/dashboard consume.
    this.bus.subscribe((e) => this.hub.publish({ kind: "agent_event", event: e, time: e.time }));
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

  get running(): boolean {
    return this.busy;
  }

  pendingApprovals(): { agentId: string; tool: string; input: Record<string, unknown> }[] {
    const cur = this.approvals.current();
    const batch = this.approvals.currentBatch() ?? (cur ? [cur] : []);
    return batch.map((r) => ({ agentId: r.agentId, tool: r.tool, input: r.input }));
  }

  // Run a goal end-to-end: plan → schedule → integrate. Emits session start/end and persists tasks.
  // planOnly stops after the DAG is built, so you can read the plan (and edit agents.yaml, or say
  // it differently) before any agent writes a file — the TUI's PLAN mode.
  async submit(goal: string, opts: { planOnly?: boolean } = {}): Promise<void> {
    // A fresh goal starts a fresh conversation: no priorTurns, so nothing from an earlier run
    // bleeds in just because the planner reused a task id.
    await this.runSession(goal, (deps) => runProject(goal, this.agents, this.orch, this.bus, { ...deps, planOnly: opts.planOnly }));
  }

  // Continue the tasks a previous session left unfinished, each agent seeded with that task's
  // stored conversation. Requires a store — without one there is no history to resume from.
  async resume(): Promise<void> {
    const store = this.store;
    await this.runSession("(resumed session)", (deps) =>
      resumeProject(this.agents, this.orch, this.bus, {
        ...deps,
        // Scoped to the agent that owns the task, so a failed-over task never replays another
        // agent's transcript as its own history.
        priorTurns: store
          ? (taskId) => resumeConversation(store, taskId, this.orch.all.find((t) => t.id === taskId)?.assignedTo)
          : undefined,
      }),
    );
  }

  private async runSession(goal: string, run: (deps: RunnerDeps) => Promise<void>): Promise<void> {
    if (this.busy) throw new Error("a task is already running");
    if (this.worktreeEnabled) {
      if (this.worktreeHandle) {
        throw new Error(`a previous run's worktree (${this.worktreeHandle.branch}) hasn't been merged yet — merge or discard it first`);
      }
      if (!(await isGitRepo(this.root))) throw new Error("worktree isolation requires a git repository");
      // ponytail: a fresh worktree per run, off current HEAD — a run started before an earlier
      // worktree's work is merged won't see it. Upgrade to stacking/rebasing onto the pending
      // worktree's branch if that gap matters in practice.
      this.worktreeHandle = await createWorktree(this.root, crypto.randomUUID().slice(0, 8));
      for (const a of this.agents) a.setRoot(this.worktreeHandle.path);
    }
    this.busy = true;
    this.cancelled = false;
    this.lastGoal = goal;
    this.hub.publish({ kind: "session", state: "started", goal });
    try {
      await run({
        messageBus: this.messageBus,
        onOrchestration: (e) => {
          this.hub.publish({ kind: "orchestration", event: e, time: e.time });
          this.emitUsage();
          this.emitLocks();
        },
        shouldStop: () => this.cancelled,
      });
      saveTasks(this.orch.all); // persist so `niti resume` can reload
    } finally {
      this.busy = false;
      if (this.worktreeEnabled) for (const a of this.agents) a.setRoot(this.root); // LSP/watcher never left the real root
      this.emitUsage();
      this.hub.publish({ kind: "session", state: this.cancelled ? "cancelled" : "ended" });
    }
  }

  // POST /worktree/discard — the escape hatch the "merge or discard it first" error promised but
  // never had. Without it a merge conflict wedged the engine permanently: worktreeHandle stayed
  // set, so every later worktree-mode run refused to start and there was no way to clear it.
  async discardWorktree(): Promise<{ ok: boolean; message: string }> {
    const handle = this.worktreeHandle;
    if (!handle) return { ok: false, message: "no pending worktree" };
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
  // successful merge; a conflict leaves it in place so the user can resolve it themselves (via the
  // branch directly) and retry.
  async mergeWorktree(): Promise<{ ok: boolean; message: string }> {
    if (!this.worktreeHandle) return { ok: false, message: "no active worktree" };
    await commitPending(this.worktreeHandle); // agents write files directly, never commit as they go
    const result = await mergeBack(this.root, this.worktreeHandle.branch);
    if (result.ok) {
      await removeWorktree(this.root, this.worktreeHandle.path);
      this.worktreeHandle = undefined;
      return result;
    }
    // A failed merge left the user's repo sitting mid-merge with conflict markers in their files,
    // which they then had to discover and unpick by hand. Put the tree back and tell them the two
    // ways forward.
    await abortMerge(this.root);
    return {
      ok: false,
      message: `${result.message}\n\nYour working tree was restored. Resolve it on branch ${this.worktreeHandle.branch}, or POST /worktree/discard to throw the run away.`,
    };
  }

  // POST /worktree/merge with a `files` list — bring in only those files, then throw away the
  // worktree. A reviewer who has already picked which files they want has implicitly decided
  // against the rest; leaving the worktree/branch around "in case" just accumulates abandoned
  // branches (same reasoning as discardWorktree below).
  async mergeWorktreeFiles(files: string[]): Promise<{ ok: boolean; message: string }> {
    if (!this.worktreeHandle) return { ok: false, message: "no active worktree" };
    await commitPending(this.worktreeHandle);
    const result = await mergeFiles(this.root, this.worktreeHandle.branch, files);
    if (result.ok) {
      await removeWorktree(this.root, this.worktreeHandle.path);
      this.worktreeHandle = undefined;
    }
    return result;
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
    // An agent parked on an approval is not "in flight" in any useful sense — it is waiting on a
    // human who has just said stop. Without this the promise never settles: the agent never
    // returns, `busy` stays true, and no further submit() is ever possible.
    this.approvals.denyAll();
  }

  // Revert the most recent file write an agent made (LIFO, one write per call). Returns a
  // human-readable result — there's nothing to undo before any agent has written anything.
  undo(): string {
    const result = this.store?.undoLast();
    if (!result) return this.store ? "nothing to undo" : "undo needs a session store (run through the CLI or server)";
    const shown = relative(this.root, result.path) || result.path;
    const message = `${result.action} ${shown}`;
    this.bus.publish({ agentId: "orchestrator", type: "file_edit", payload: `undo: ${message}`, time: Date.now() });
    return message;
  }

  // /rewind [n]: undo() extended to n steps, applied atomically (see SessionStore.rewindN). n=1
  // behaves exactly like undo().
  rewind(n: number): string {
    const results = this.store?.rewindN(n);
    if (!results) return "rewind needs a session store (run through the CLI or server)";
    if (results.length === 0) return "nothing to rewind";
    for (const r of results) {
      const shown = relative(this.root, r.path) || r.path;
      this.bus.publish({ agentId: "orchestrator", type: "file_edit", payload: `rewind: ${r.action} ${shown}`, time: Date.now() });
    }
    const summary = results.map((r) => `${r.action} ${relative(this.root, r.path) || r.path}`).join(", ");
    return `rewound ${results.length} step(s): ${summary}`;
  }

  // /debate: two agents (each already carrying its own provider/model, so this works cross-provider
  // for free) alternate no-tools, read-only turns (Agent.ask — no side effects, this is a
  // discussion, not agents editing files) responding to each other, then one of them synthesizes a
  // consensus recommendation. Each turn is published to the bus so it streams live in both the TUI
  // and the web dashboard, same as any agent message. Explicit agent ids only — no auto-selection
  // heuristic, since the caller (the /debate command) already knows the roster.
  async debate(agentAId: string, agentBId: string, question: string, rounds = 3): Promise<string> {
    const a = this.byId.get(agentAId);
    const b = this.byId.get(agentBId);
    if (!a || !b) return `no such agent: ${!a ? agentAId : agentBId}`;
    if (a === b) return "debate needs two different agents";

    const turns: string[] = [];
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

    const synthesis = await a.ask(
      [`Debate transcript on: ${question}`, "", turns.join("\n\n"), "", "Synthesize a consensus recommendation from this exchange — what should actually be done, and why."].join("\n"),
    );
    this.bus.publish({ agentId: agentAId, type: "message", payload: `[debate synthesis] ${synthesis}`, time: Date.now() });

    // The full exchange, not just the verdict — seeing how the two sides got there is the point of
    // a debate. Also guarantees a multi-line result, so it opens the TUI's pager rather than being
    // squeezed into the one-line footer.
    return [`## Debate: ${agentAId} vs ${agentBId}`, "", turns.join("\n\n"), "", "## Synthesis", "", synthesis].join("\n");
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
    const result = this.messageBus.post({ from: USER, to: agentId, kind: "handoff", subject: text.slice(0, 70), body: text });
    if (!result.ok) return result.reason;
    // messageBus.post already fans out an `agent_message` SSE event (so it shows in the Messages
    // tab / feed); this additionally puts it in the agent's own transcript, matching how the
    // agent's own tool calls and thoughts appear there.
    this.bus.publish({ agentId, type: "message", payload: `[from user] ${text}`, time: Date.now() });
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
    try {
      const p = this.makeProvider({ ...agent.config, provider, model, baseURL });
      agent.reconfigure(provider, model, p, baseURL);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
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

  // Session cost so far, priced per agent from its own provider/model (a mixed team bills at mixed
  // rates). `costKnown` is false when any agent's model isn't in the price table, so the UI can
  // show "$0.42+" instead of implying the total is complete.
  private cost(): { cost: number; costKnown: boolean } {
    let cost = 0;
    let costKnown = true;
    for (const { agentId, usage } of this.usage.snapshot()) {
      const cfg = this.byId.get(agentId)?.config;
      if (!cfg) continue;
      const { usd, priced } = costOf(cfg.provider, cfg.model, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens);
      cost += usd;
      if (!priced) costKnown = false;
    }
    return { cost, costKnown };
  }

  emitLocks(): void {
    const holders = [...this.locks.byHolder()].flatMap(([holder, paths]) => paths.map((path) => ({ holder, path })));
    this.hub.publish({ kind: "lock", holders });
  }
}
