// First-class agent-to-agent channel — distinct from the UI-telemetry Bus (events/bus.ts).
// Agents hand off work, ask each other questions, and share artifacts over this bus; every
// message is also broadcast to subscribers so the TUI and web dashboard can animate the edge.

export type MessageKind = "handoff" | "question" | "answer" | "artifact" | "review" | "broadcast";

export interface AgentMessage {
  id: string;
  from: string; // agent id, or "orchestrator"
  to: string; // agent id, or "*" for broadcast
  kind: MessageKind;
  subject: string;
  body: string;
  refs?: string[]; // file paths / task ids / prior message ids
  time: number;
}

export interface PostResult {
  ok: boolean;
  reason?: string;
  delivered: string[]; // agent ids the message reached
}

// The orchestrator is always allowed to reach anyone (it supervises); it also can't be blocked
// as a recipient, so status/handoffs always flow back up.
export const ORCHESTRATOR = "orchestrator";

const MAX_PER_PAIR = 10; // messages one agent may send another within a single task/plan (loop guard)

export class MessageBus {
  private inboxes = new Map<string, AgentMessage[]>();
  private roster = new Set<string>([ORCHESTRATOR]);
  private subs = new Set<(m: AgentMessage) => void>();
  private edges?: Set<string>; // directed "from->to"; undefined = allow all pairs
  private counts = new Map<string, number>(); // "from->to" → count this task (rate cap)
  private nextId = 1;

  // Track who exists so broadcasts know their recipients and unknown targets are rejected.
  register(agentId: string): void {
    this.roster.add(agentId);
    if (!this.inboxes.has(agentId)) this.inboxes.set(agentId, []);
  }

  // Restrict messaging to an explicit set of directed edges (orchestrator is implicitly allowed
  // to/from everyone). Available for a caller that wants a stricter policy; the scheduler does NOT
  // call this today — it calls allowAll() instead, because the planner can't anticipate every
  // question an agent will need mid-task (that's the point of ask_agent), so coordination is
  // intentionally open within a run. With no restriction set (the default), every pair is allowed.
  restrict(pairs: [string, string][]): void {
    this.edges = new Set(pairs.map(([a, b]) => `${a}->${b}`));
  }

  // The default policy: any registered agent may reach any other. MAX_PER_PAIR is the abuse/loop
  // guard, not per-plan edge authorization.
  allowAll(): void {
    this.edges = undefined;
  }

  isAllowed(from: string, to: string): boolean {
    if (from === ORCHESTRATOR || to === ORCHESTRATOR) return true;
    if (!this.edges) return true;
    return this.edges.has(`${from}->${to}`);
  }

  // Reset per-task rate counters (call at each plan/task boundary).
  resetCaps(): void {
    this.counts.clear();
  }

  // Check an edge and consume one unit of its per-task budget. Shared by post() (async delivery)
  // and authorize() (synchronous ask), so the rate cap + edge authorization apply to both paths.
  private reserve(from: string, to: string): { ok: boolean; reason?: string } {
    if (!this.roster.has(to)) return { ok: false, reason: `unknown recipient '${to}'` };
    if (!this.isAllowed(from, to)) return { ok: false, reason: `edge ${from}->${to} not authorized` };
    const pair = `${from}->${to}`;
    const n = this.counts.get(pair) ?? 0;
    if (n >= MAX_PER_PAIR) return { ok: false, reason: `message rate cap reached (${from}->${to})` };
    this.counts.set(pair, n + 1);
    return { ok: true };
  }

  // Deliver a message. Rejects unknown recipients, unauthorized edges, and pair-rate overflow
  // (the loop guard). Broadcasts fan out to every registered agent except the sender.
  post(input: Omit<AgentMessage, "id" | "time">): PostResult {
    const msg: AgentMessage = { ...input, id: `m${this.nextId++}`, time: Date.now() };
    if (msg.to !== "*" && !this.roster.has(msg.to)) {
      return { ok: false, reason: `unknown recipient '${msg.to}'`, delivered: [] };
    }
    const targets = msg.to === "*" ? [...this.roster].filter((a) => a !== msg.from && a !== ORCHESTRATOR) : [msg.to];
    const delivered: string[] = [];
    for (const to of targets) {
      if (!this.reserve(msg.from, to).ok) continue; // edge blocked or rate-capped — drop
      const box = this.inboxes.get(to) ?? [];
      box.push({ ...msg, to });
      this.inboxes.set(to, box);
      delivered.push(to);
    }
    if (!delivered.length) {
      return { ok: false, reason: `no authorized recipient (edge blocked or rate-capped)`, delivered: [] };
    }
    for (const fn of this.subs) fn(msg); // notify UI once with the original (to may be "*")
    return { ok: true, delivered };
  }

  // Authorize (and rate-count) a single synchronous exchange WITHOUT enqueueing — for ask_agent,
  // where the question/answer are delivered directly (respond()'s input + the tool result), so
  // enqueueing too would double-deliver. Enforces the same cap/authorization as post().
  authorize(from: string, to: string): { ok: boolean; reason?: string } {
    return this.reserve(from, to);
  }

  // Publish a message to subscribers (TUI/dashboard) without enqueueing it — the visualization
  // half of a synchronous ask.
  announce(input: Omit<AgentMessage, "id" | "time">): AgentMessage {
    const msg: AgentMessage = { ...input, id: `m${this.nextId++}`, time: Date.now() };
    for (const fn of this.subs) fn(msg);
    return msg;
  }

  // Drain and return an agent's pending messages (injected into its next turn as context).
  drain(agentId: string): AgentMessage[] {
    const box = this.inboxes.get(agentId) ?? [];
    this.inboxes.set(agentId, []);
    return box;
  }

  pending(agentId: string): number {
    return this.inboxes.get(agentId)?.length ?? 0;
  }

  subscribe(fn: (m: AgentMessage) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}

// What the agent loop needs to talk to peers. The Engine implements this over MessageBus + the
// live agent registry (ask() actually invokes the peer's model; send() is fire-and-forget).
export interface Messenger {
  peers(selfId: string): { id: string; role: string }[];
  send(from: string, to: string, kind: MessageKind, subject: string, body: string, refs?: string[]): string;
  ask(from: string, to: string, question: string, depth: number): Promise<string>;
  inbox(agentId: string): AgentMessage[];
}

export const MAX_ASK_DEPTH = 3; // A asks B asks A … — cap the synchronous question chain
