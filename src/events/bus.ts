import { EventEmitter } from "node:events";

export type EventType =
  | "thought"
  | "tool_call"
  | "file_edit"
  | "delta" // streaming text chunk
  | "message" // agent text output (final)
  | "failover" // task reassigned after an agent exhausted its quota
  | "warning" // pre-emptive heads-up (e.g. approaching context limit)
  | "done"
  | "error";

export interface AgentEvent {
  agentId: string;
  type: EventType;
  payload: string;
  time: number;
}

// Thin typed wrapper over node:events. Many agents publish; the log/TUI subscribes.
export class Bus {
  private emitter = new EventEmitter();

  constructor() {
    // Agents are the writers; a slow subscriber shouldn't crash on backpressure warnings.
    this.emitter.setMaxListeners(0);
  }

  publish(e: AgentEvent): void {
    this.emitter.emit("event", e);
  }

  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.emitter.on("event", fn);
    return () => this.emitter.off("event", fn);
  }
}
