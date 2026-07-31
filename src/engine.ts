import { relative } from "node:path";
import { Agent, type AgentConfig } from "./agent/agent.ts";
import { Bus } from "./events/bus.ts";
import { MessageBus, type Messenger } from "./messaging/message-bus.ts";
import { Orchestrator } from "./orchestrator/orchestrator.ts";
import { LockRegistry } from "./orchestrator/locks.ts";
import { ApprovalQueue } from "./approval.ts";
import { UsageTracker } from "./usage.ts";
import { runProject, resumeProject, type RunnerDeps } from "./orchestrator/runner.ts";
import { EventHub } from "./server/events.ts";
import type { Provider } from "./providers/provider.ts";
import type { McpTools } from "./mcp/mcp.ts";
import type { LspRegistry } from "./lsp/registry.ts";
import type { SessionStore } from "./store/session-store.ts";
import { AUTO_RULES, type PermissionRules } from "./permissions.ts";
import { costOf } from "./providers/pricing.ts";
import { watchProject, type ProjectWatcher } from "./watch.ts";
import { TOOL_GUIDANCE } from "./tools/tools.ts";
import { saveTasks, resumeConversation } from "./session.ts";

export interface EngineOptions {
  configs: AgentConfig[];
  makeProvider: (cfg: AgentConfig) => Provider;
  root?: string;
  mcp?: McpTools;
  interactive?: boolean; // gate write_file/shell behind approvals (off for one-shot/scripting)
  systemSuffix?: string; // e.g. skills text appended to every system prompt
  store?: SessionStore; // present → conversations persist (resume, undo, session history)
  permissions?: PermissionRules; // project-level tool policy from agents.yaml
  auto?: boolean; // --auto: approve anything not explicitly denied (dangerous commands still prompt)
  lsp?: LspRegistry; // present → diagnostics/hover available to every agent, alongside MCP
  watch?: boolean; // true → emit external_change events for edits made outside amux
  maxTurns?: number; // `maxTurns:` from agents.yaml — tool-loop cap per agent turn
}

// The Engine wires the whole multi-agent runtime: agents (with a live messenger so they can talk to
// each other), the orchestrator DAG, approvals, usage, locks, and a single EventHub that fans every
// signal out over one stream. Both the CLI (in-process) and the HTTP server drive the same Engine.
export class Engine {
  readonly bus = new Bus();
  readonly messageBus = new MessageBus();
  readonly orch = new Orchestrator();
  readonly approvals = new ApprovalQueue();
  readonly usage = new UsageTracker();
  readonly locks: LockRegistry;
  readonly hub = new EventHub();
  readonly agents: Agent[] = [];
  readonly store?: SessionStore;
  readonly root: string;
  // Public so the server can report what the project is wired to (the TUI sidebar lists both).
  readonly lsp?: LspRegistry;
  readonly mcp?: McpTools;

  private makeProvider: (cfg: AgentConfig) => Provider;
  private byId = new Map<string, Agent>();
  private busy = false;
  private cancelled = false;
  private watcher?: ProjectWatcher;

  constructor(opts: EngineOptions) {
    this.makeProvider = opts.makeProvider;
    this.store = opts.store;
    this.root = opts.root ?? process.cwd();
    this.lsp = opts.lsp;
    this.mcp = opts.mcp;
    this.locks = new LockRegistry(this.bus);
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
    };

    // Ordered least-specific-last: an agent's own block wins, then the project's, then --auto's
    // blanket allow — so an explicit project `deny` is never undone by --auto.
    const permissionLayers = [...(opts.permissions ? [opts.permissions] : []), ...(opts.auto ? [AUTO_RULES] : [])];

    for (const c of opts.configs) {
      const cfg = { ...c, systemPrompt: c.systemPrompt + (opts.systemSuffix ?? "") + TOOL_GUIDANCE };
      const agent = new Agent(cfg, this.makeProvider(cfg), this.bus, {
        root: this.root,
        approve: opts.interactive ? (tool, input, forceAsk) => this.approvals.request(c.id, tool, input, forceAsk) : undefined,
        mcp: opts.mcp,
        usageTracker: this.usage,
        locks: this.locks,
        messenger,
        store: this.store,
        permissionLayers,
        lsp: opts.lsp,
        onWrite: (path) => this.watcher?.markSelfWrite(path),
        maxTurns: opts.maxTurns,
      });
      this.agents.push(agent);
      this.byId.set(c.id, agent);
      this.messageBus.register(c.id);
      for (const tool of c.autoApprove ?? []) this.approvals.grant(c.id, tool); // agents.yaml pre-grants
    }

    // Fan every source into the one hub the TUI/dashboard consume.
    this.bus.subscribe((e) => this.hub.publish({ kind: "agent_event", event: e, time: e.time }));
    this.messageBus.subscribe((m) => {
      this.store?.recordMessage(m); // one place: both post() (queued) and announce() (synchronous ask) pass through here
      this.hub.publish({ kind: "agent_message", message: m, time: m.time });
    });
    this.approvals.onChange(() => this.hub.publish({ kind: "approval_request", requests: this.pendingApprovals() }));
  }

  get configs(): readonly AgentConfig[] {
    return this.agents.map((a) => a.config);
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
        priorTurns: store ? (taskId) => resumeConversation(store, taskId) : undefined,
      }),
    );
  }

  private async runSession(goal: string, run: (deps: RunnerDeps) => Promise<void>): Promise<void> {
    if (this.busy) throw new Error("a task is already running");
    this.busy = true;
    this.cancelled = false;
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
      saveTasks(this.orch.all); // persist so `amux resume` can reload
    } finally {
      this.busy = false;
      this.emitUsage();
      this.hub.publish({ kind: "session", state: this.cancelled ? "cancelled" : "ended" });
    }
  }

  cancel(): void {
    this.cancelled = true;
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
      const { usd, priced } = costOf(cfg.provider, cfg.model, usage.inputTokens, usage.outputTokens);
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
