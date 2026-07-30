import type { AgentEvent } from "../events/bus.ts";
import type { AgentMessage } from "../messaging/message-bus.ts";
import type { OrchestrationEvent } from "../orchestrator/scheduler.ts";
import type { AgentUsage, RateLimitSnapshot } from "../usage.ts";

// The single event contract the Go TUI and web dashboard both consume over SSE. A discriminated
// union with a monotonic `seq` + `time` on every event, so a late-joining client can replay from
// the last seq it saw and stay consistent.
export type ServerEventBody =
  | { kind: "agent_event"; event: AgentEvent }
  | { kind: "agent_message"; message: AgentMessage }
  | { kind: "orchestration"; event: OrchestrationEvent }
  | { kind: "usage"; agents: { agentId: string; usage: AgentUsage }[]; totals: { inputTokens: number; outputTokens: number; calls: number }; rateLimits: RateLimitSnapshot[] }
  | { kind: "approval_request"; requests: { agentId: string; tool: string; input: Record<string, unknown> }[] }
  | { kind: "lock"; holders: { path: string; holder: string }[] }
  | { kind: "session"; state: "started" | "ended" | "cancelled" | "idle"; goal?: string };

export type ServerEvent = ServerEventBody & { seq: number; time: number };

const BUFFER_MAX = 2000; // ring buffer for replay — enough for a session, bounded so memory can't grow forever

export class EventHub {
  private seq = 0;
  private buffer: ServerEvent[] = [];
  private subs = new Set<(e: ServerEvent) => void>();

  publish(body: ServerEventBody & { time?: number }): ServerEvent {
    const { time, ...rest } = body;
    const e = { ...rest, seq: ++this.seq, time: time ?? Date.now() } as ServerEvent;
    this.buffer.push(e);
    if (this.buffer.length > BUFFER_MAX) this.buffer.shift();
    for (const fn of this.subs) fn(e);
    return e;
  }

  // Events with seq strictly greater than `fromSeq` (0 = everything still buffered).
  replay(fromSeq: number): ServerEvent[] {
    return this.buffer.filter((e) => e.seq > fromSeq);
  }

  lastSeq(): number {
    return this.seq;
  }

  subscribe(fn: (e: ServerEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}
