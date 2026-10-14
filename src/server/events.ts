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
  | { kind: "usage"; agents: { agentId: string; usage: AgentUsage }[]; totals: { inputTokens: number; outputTokens: number; calls: number }; rateLimits: RateLimitSnapshot[]; cost: number; costKnown: boolean }
  | { kind: "approval_request"; requests: { id: number; agentId: string; tool: string; input: Record<string, unknown>; dangerous: boolean }[] }
  | { kind: "lock"; holders: { path: string; holder: string }[] }
  | { kind: "session"; state: "started" | "ended" | "cancelled" | "idle"; goal?: string }
  | { kind: "theme"; theme: string }
  // /awake: "lid" = the Mac stays awake lid-closed, "open" = lid-open only (admin prompt declined).
  | { kind: "awake"; state: "off" | "lid" | "open" }
  // /clear: the session was wiped. A client drops everything it is showing (transcripts, board,
  // totals, files) — replay can't carry this, because clear() below also empties the buffer.
  | { kind: "session_reset" }
  // The end of a run, as one card: the lead's summary, suggested next prompts, what changed, and
  // what it took. Published once per work run (not for a chat reply or an answered question).
  | {
      kind: "turn_summary";
      goal: string;
      ok: boolean; // every task finished
      cancelled: boolean;
      summary: string;
      next: string[];
      files: { path: string; added: number; removed: number }[];
      durationMs: number;
      tokens: number;
      cost: number;
      costKnown: boolean;
    }
  // Sent to one reconnecting client (never published) when the events it asked to replay have
  // already left the ring buffer — its view is incomplete, and it should say so rather than
  // present a partial history as the whole one.
  | { kind: "resync"; missed: number };

export type ServerEvent = ServerEventBody & { seq: number; time: number };

const BUFFER_MAX = 2000; // ring buffer for replay — enough for a session, bounded so memory can't grow forever

export class EventHub {
  private seq = 0;
  private buffer: ServerEvent[] = [];
  private evicted = 0; // seq of the newest buffered event pushed out by the cap
  private subs = new Set<(e: ServerEvent) => void>();

  // `replay: false` for what is only worth seeing live — streamed tokens, a running command's latest
  // lines. Buffered, a single long reply was a thousand events that pushed the plan and every tool
  // call out of the buffer, and a reconnecting client got a gap instead of the run; the final
  // `message` event already carries the whole text.
  publish(body: ServerEventBody & { time?: number }, replay = true): ServerEvent {
    const { time, ...rest } = body;
    const e = { ...rest, seq: ++this.seq, time: time ?? Date.now() } as ServerEvent;
    if (replay) {
      this.buffer.push(e);
      if (this.buffer.length > BUFFER_MAX) this.evicted = this.buffer.shift()!.seq;
    }
    for (const fn of this.subs) fn(e);
    return e;
  }

  // Forget every buffered event (seq keeps counting, so a client's cursor stays valid). Without
  // this a reconnecting client would replay the very history /clear just wiped.
  clear(): void {
    this.buffer = [];
  }

  // Events with seq strictly greater than `fromSeq` (0 = everything still buffered).
  replay(fromSeq: number): ServerEvent[] {
    return this.buffer.filter((e) => e.seq > fromSeq);
  }

  // How many events after `fromSeq` fell out of the buffer before a client came back for them — by
  // what was evicted, not by the gap before the oldest buffered seq, which live-only events also leave.
  missedSince(fromSeq: number): number {
    return fromSeq > 0 && this.evicted > fromSeq ? this.evicted - fromSeq : 0;
  }

  lastSeq(): number {
    return this.seq;
  }

  subscribe(fn: (e: ServerEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}
