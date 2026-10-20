// Bridges concurrent agents (which pause awaiting a decision) and the clients that answer them.
// Requests queue up; every client sees the whole queue (queued()) and answers them by id.
// Approving with scope "agent" grants that (agentId, tool) pair for the rest of the session;
// scope "path" additionally narrows the grant to the request's parent directory. A dangerous
// call marks itself forceAsk, which always queues regardless of any standing grant.
import { normalizePath } from "./permissions.ts";
import type { AuditLog } from "./store/audit-log.ts";

interface ApprovalRequest {
  id: number; // stable per request, so a client can answer the one it showed, not whatever is now first
  agentId: string;
  tool: string;
  input: Record<string, unknown>;
  resolve: (ok: boolean) => void;
  // Dangerous, outside the project, or a credential: always asked, never waved through by a grant —
  // and so never part of a client's "allow all" either.
  forceAsk: boolean;
  expiresAt?: number; // epoch ms the request is refused on its own; absent when the timeout is off
  timer?: ReturnType<typeof setTimeout>;
}

interface PermissionScope {
  agentId: string; // "*" = any agent
  tool: string; // "*" = any tool
  pathPattern?: string; // glob (Bun.Glob) — only checked when the request's input has a string `path`
}

// Flood guard: an agent that piles up more than this many still-unanswered requests gets refused
// outright rather than queued, the same "reject past a cap" shape as message-bus.ts's MAX_PER_PAIR
// — a legitimate burst (several file writes in one turn, or the batch dialog's own 3+ case) stays
// well under this; only a pathological flood trying to bury the human in prompts hits it.
const MAX_PENDING_PER_AGENT = 20;

// An unanswered request is refused after this long, so an unattended session keeps moving instead of
// parking an agent forever. `approvalTimeout:` in agents.yaml (seconds) overrides it; 0 turns it off.
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;

export class ApprovalQueue {
  private pending: ApprovalRequest[] = [];
  private listeners = new Set<() => void>();
  private scopes: PermissionScope[] = [];
  private nextId = 1;
  onExpire?: (req: { agentId: string; tool: string }) => void; // the engine says so in the agent's feed

  constructor(private audit?: AuditLog, private timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS) {}

  private logDecision(req: ApprovalRequest, ok: boolean, scope?: "agent" | "path", timedOut?: boolean): void {
    this.audit?.append({ agentId: req.agentId, kind: "approval", detail: { tool: req.tool, ok, scope, ...(timedOut ? { timedOut } : {}) } });
  }

  // Requests already queued keep the deadline they were shown with; the new value applies to the next.
  setTimeout(ms: number): void {
    this.timeoutMs = ms;
  }

  // Taken out of the queue for any reason: its deadline no longer applies.
  private settle(req: ApprovalRequest, ok: boolean, scope?: "agent" | "path", timedOut?: boolean): void {
    clearTimeout(req.timer);
    this.logDecision(req, ok, scope, timedOut);
    req.resolve(ok);
  }

  // Pre-grant a scope — used to seed autoApprove rules from agents.yaml at startup.
  grant(agentId: string, tool: string, pathPattern?: string): void {
    this.scopes.push({ agentId, tool, pathPattern });
  }

  isAllowed(agentId: string, tool: string, input: Record<string, unknown> = {}): boolean {
    return this.scopes.some((s) => {
      if (s.agentId !== agentId && s.agentId !== "*") return false;
      if (s.tool !== tool && s.tool !== "*") return false;
      if (!s.pathPattern) return true;
      // normalize for the same reason as permissions.subject: a standing grant on src/** must not
      // be satisfied by src/../.niti/agents.yaml.
      return typeof input.path === "string" && new Bun.Glob(s.pathPattern).match(normalizePath(input.path));
    });
  }

  request(agentId: string, tool: string, input: Record<string, unknown>, forceAsk = false): Promise<boolean> {
    if (!forceAsk && this.isAllowed(agentId, tool, input)) return Promise.resolve(true);
    // Reject outright rather than queue: a flood of requests must not be able to bury a human in
    // enough prompts that a rushed "approve all" click-through becomes the path of least resistance.
    if (this.pending.filter((r) => r.agentId === agentId).length >= MAX_PENDING_PER_AGENT) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const req: ApprovalRequest = { id: this.nextId++, agentId, tool, input, resolve, forceAsk };
      if (this.timeoutMs > 0) {
        req.expiresAt = Date.now() + this.timeoutMs;
        req.timer = setTimeout(() => this.expire(req.id), this.timeoutMs);
        req.timer.unref?.(); // a parked request alone shouldn't keep a process alive
      }
      this.pending.push(req);
      this.notify();
    });
  }

  // The deadline passed with nobody answering: refused, the same as a "no".
  private expire(id: number): void {
    const i = this.pending.findIndex((r) => r.id === id);
    if (i < 0) return;
    const req = this.pending.splice(i, 1)[0]!;
    this.settle(req, false, undefined, true);
    this.onExpire?.(req);
    this.notify();
  }

  current(): ApprovalRequest | undefined {
    return this.pending[0];
  }

  // The whole queue, oldest first. It used to be the whole queue only when 3+ requests had arrived
  // within 5 seconds and just the front otherwise — so a client listing them showed one while ten
  // waited, and the list shrank on a timer with no event to say so.
  queued(): readonly ApprovalRequest[] {
    return this.pending;
  }

  // `edited` overrides fields of the queued request's input (e.g. a diff-view in-place edit) —
  // merged into the same object the agent loop is holding a reference to, so it picks up the
  // change without any further plumbing back through the caller.
  // With an id, answers that request wherever it sits in the queue; returns false if it is no longer
  // pending (another client answered it first). Without one, answers the front (the TUI, the web page).
  answer(ok: boolean, scope?: "agent" | "path", edited?: Record<string, unknown>, id?: number): boolean {
    const i = id === undefined ? 0 : this.pending.findIndex((r) => r.id === id);
    if (i < 0 || i >= this.pending.length) return false;
    const req = this.pending.splice(i, 1)[0]!;
    if (ok && edited) Object.assign(req.input, edited);
    if (ok && scope === "agent") this.grant(req.agentId, req.tool);
    if (ok && scope === "path" && typeof req.input.path === "string") {
      const dir = normalizePath(req.input.path).split("/").slice(0, -1).join("/");
      // A file at the project root has no directory part. Granting "./**" there matched nothing —
      // Bun.Glob compares it against a bare "README.md" — so "always allow in this directory"
      // silently did nothing and the user was re-prompted for every root-level file.
      this.grant(req.agentId, req.tool, dir ? `${dir}/**` : "*");
    }
    this.settle(req, ok, scope);
    this.notify();
    return true;
  }

  // /cancel: everything waiting is refused at once — the human just said stop. With an agent id, only
  // that agent's requests (interrupting one agent).
  denyAll(agentId?: string): void {
    const batch = agentId ? this.pending.filter((r) => r.agentId === agentId) : this.pending;
    this.pending = agentId ? this.pending.filter((r) => r.agentId !== agentId) : [];
    for (const r of batch) this.settle(r, false);
    this.notify();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

export type Approve = (tool: string, input: Record<string, unknown>, forceAsk?: boolean) => Promise<boolean>;
