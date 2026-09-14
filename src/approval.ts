// Bridges concurrent agents (which pause awaiting a decision) and the single TUI prompt.
// Requests queue up; the TUI answers them one at a time (or as a batch — see currentBatch).
// Approving with scope "agent" grants that (agentId, tool) pair for the rest of the session;
// scope "path" additionally narrows the grant to the request's parent directory. A dangerous
// call marks itself forceAsk, which always queues regardless of any standing grant.
import { normalize } from "node:path";
import type { AuditLog } from "./store/audit-log.ts";

export interface ApprovalRequest {
  agentId: string;
  tool: string;
  input: Record<string, unknown>;
  resolve: (ok: boolean) => void;
  queuedAt: number;
}

export interface PermissionScope {
  agentId: string; // "*" = any agent
  tool: string; // "*" = any tool
  pathPattern?: string; // glob (Bun.Glob) — only checked when the request's input has a string `path`
}

const BATCH_MIN = 3; // fewer than this, show them one at a time
const BATCH_WINDOW_MS = 5000; // ...but only batch if they arrived close together

// Flood guard: an agent that piles up more than this many still-unanswered requests gets refused
// outright rather than queued, the same "reject past a cap" shape as message-bus.ts's MAX_PER_PAIR
// — a legitimate burst (several file writes in one turn, or the batch dialog's own 3+ case) stays
// well under this; only a pathological flood trying to bury the human in prompts hits it.
const MAX_PENDING_PER_AGENT = 20;

export class ApprovalQueue {
  private pending: ApprovalRequest[] = [];
  private listeners = new Set<() => void>();
  private scopes: PermissionScope[] = [];

  constructor(private audit?: AuditLog) {}

  private logDecision(req: ApprovalRequest, ok: boolean, scope?: "agent" | "path"): void {
    this.audit?.append({ agentId: req.agentId, kind: "approval", detail: { tool: req.tool, ok, scope } });
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
      return typeof input.path === "string" && new Bun.Glob(s.pathPattern).match(normalize(input.path));
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
      this.pending.push({ agentId, tool, input, resolve, queuedAt: Date.now() });
      this.notify();
    });
  }

  current(): ApprovalRequest | undefined {
    return this.pending[0];
  }

  // Present as one batch dialog once 3+ requests are queued within a 5s window; otherwise the
  // TUI falls back to current() and handles them one at a time.
  currentBatch(): readonly ApprovalRequest[] | undefined {
    if (this.pending.length < BATCH_MIN) return undefined;
    return Date.now() - this.pending[0]!.queuedAt <= BATCH_WINDOW_MS ? this.pending : undefined;
  }

  // `edited` overrides fields of the queued request's input (e.g. a diff-view in-place edit) —
  // merged into the same object the agent loop is holding a reference to, so it picks up the
  // change without any further plumbing back through the caller.
  answer(ok: boolean, scope?: "agent" | "path", edited?: Record<string, unknown>): void {
    const req = this.pending.shift();
    if (!req) return;
    if (ok && edited) Object.assign(req.input, edited);
    if (ok && scope === "agent") this.grant(req.agentId, req.tool);
    if (ok && scope === "path" && typeof req.input.path === "string") {
      const dir = normalize(req.input.path).split("/").slice(0, -1).join("/");
      // A file at the project root has no directory part. Granting "./**" there matched nothing —
      // Bun.Glob compares it against a bare "README.md" — so "always allow in this directory"
      // silently did nothing and the user was re-prompted for every root-level file.
      this.grant(req.agentId, req.tool, dir ? `${dir}/**` : "*");
    }
    this.logDecision(req, ok, scope);
    req.resolve(ok);
    this.notify();
  }

  // Batch actions — resolve a whole slice of the queue at once, so N side-by-side approvals
  // don't cost N round trips through the TUI.
  approveAll(): void {
    this.drain(() => true);
  }

  denyAll(): void {
    this.drain(() => false);
  }

  approveAgent(agentId: string): void {
    const matched = this.pending.filter((r) => r.agentId === agentId);
    this.pending = this.pending.filter((r) => r.agentId !== agentId);
    for (const r of matched) {
      this.logDecision(r, true); // one-time batch approval, not a standing "agent" scope grant
      r.resolve(true);
    }
    this.notify();
  }

  private drain(outcome: (r: ApprovalRequest) => boolean): void {
    const batch = this.pending;
    this.pending = [];
    for (const r of batch) {
      const ok = outcome(r);
      this.logDecision(r, ok);
      r.resolve(ok);
    }
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
