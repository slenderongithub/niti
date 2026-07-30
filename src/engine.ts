import { Agent, type AgentConfig } from "./agent/agent.ts";
import { Bus } from "./events/bus.ts";
import { MessageBus, type Messenger } from "./messaging/message-bus.ts";
import { Orchestrator } from "./orchestrator/orchestrator.ts";
import { LockRegistry } from "./orchestrator/locks.ts";
import { ApprovalQueue } from "./approval.ts";
import { UsageTracker } from "./usage.ts";
import { runProject } from "./orchestrator/runner.ts";
import { EventHub } from "./server/events.ts";
import type { Provider } from "./providers/provider.ts";
import type { McpTools } from "./mcp/mcp.ts";
import { saveTasks } from "./session.ts";

export interface EngineOptions {
  configs: AgentConfig[];
  makeProvider: (cfg: AgentConfig) => Provider;
  root?: string;
  mcp?: McpTools;
  interactive?: boolean; // gate write_file/shell behind approvals (off for one-shot/scripting)
  systemSuffix?: string; // e.g. skills text appended to every system prompt
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

  private makeProvider: (cfg: AgentConfig) => Provider;
  private byId = new Map<string, Agent>();
  private busy = false;
  private cancelled = false;

  constructor(opts: EngineOptions) {
    this.makeProvider = opts.makeProvider;
    this.locks = new LockRegistry(this.bus);

    // The messenger closes over the live agent registry: send() is fire-and-forget; ask() actually
    // invokes the peer's model and returns its answer (bounded by MAX_ASK_DEPTH).
    const messenger: Messenger = {
      peers: (self) => this.agents.filter((a) => a.config.id !== self).map((a) => ({ id: a.config.id, role: a.config.role })),
      send: (from, to, kind, subject, body, refs) => {
        const r = this.messageBus.post({ from, to, kind, subject, body, refs });
        this.bus.publish({ agentId: from, type: "thought", payload: `→ ${to}: ${subject}`, time: Date.now() });
        return r.ok ? `delivered to ${r.delivered.join(", ")}` : `not delivered: ${r.reason}`;
      },
      ask: async (from, to, question, depth) => {
        const target = this.byId.get(to);
        if (!target) return `no such teammate: ${to}`;
        // Enforce the edge authorization + rate cap here too (a blocked ask must NOT invoke the peer),
        // and use announce() so the synchronous question/answer aren't also queued into inboxes.
        const auth = this.messageBus.authorize(from, to);
        if (!auth.ok) return `cannot reach ${to}: ${auth.reason}`;
        this.messageBus.announce({ from, to, kind: "question", subject: question.slice(0, 70), body: question });
        const answer = await target.respond(question, depth);
        this.messageBus.announce({ from: to, to: from, kind: "answer", subject: `re: ${question.slice(0, 50)}`, body: answer });
        return answer;
      },
      inbox: (id) => this.messageBus.drain(id),
    };

    for (const c of opts.configs) {
      const cfg = opts.systemSuffix ? { ...c, systemPrompt: c.systemPrompt + opts.systemSuffix } : c;
      const agent = new Agent(cfg, this.makeProvider(cfg), this.bus, {
        root: opts.root ?? process.cwd(),
        approve: opts.interactive ? (tool, input, forceAsk) => this.approvals.request(c.id, tool, input, forceAsk) : undefined,
        mcp: opts.mcp,
        usageTracker: this.usage,
        locks: this.locks,
        messenger,
      });
      this.agents.push(agent);
      this.byId.set(c.id, agent);
      this.messageBus.register(c.id);
      for (const tool of c.autoApprove ?? []) this.approvals.grant(c.id, tool); // agents.yaml pre-grants
    }

    // Fan every source into the one hub the TUI/dashboard consume.
    this.bus.subscribe((e) => this.hub.publish({ kind: "agent_event", event: e, time: e.time }));
    this.messageBus.subscribe((m) => this.hub.publish({ kind: "agent_message", message: m, time: m.time }));
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
  async submit(goal: string): Promise<void> {
    if (this.busy) throw new Error("a task is already running");
    this.busy = true;
    this.cancelled = false;
    this.hub.publish({ kind: "session", state: "started", goal });
    try {
      await runProject(goal, this.agents, this.orch, this.bus, {
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

  emitUsage(): void {
    this.hub.publish({ kind: "usage", agents: this.usage.snapshot(), totals: this.usage.totals(), rateLimits: this.usage.rateLimits_() });
  }

  emitLocks(): void {
    const holders = [...this.locks.byHolder()].flatMap(([holder, paths]) => paths.map((path) => ({ holder, path })));
    this.hub.publish({ kind: "lock", holders });
  }
}
