import { EventEmitter } from "node:events";

export type EventType =
  | "thought"
  | "tool_call"
  | "file_edit"
  | "delta" // streaming text chunk
  | "message" // agent text output (final)
  | "failover" // task reassigned after an agent exhausted its quota
  | "warning" // pre-emptive heads-up (e.g. approaching context limit)
  | "external_change" // a file changed outside niti (human edit, git checkout, formatter)
  | "done"
  | "error";

export interface AgentEvent {
  agentId: string;
  type: EventType;
  payload: string;
  time: number;
  // Populated only for "file_edit" (and "external_change") — the project-relative path touched,
  // as a real field rather than something a consumer has to scrape out of `payload`'s human-
  // readable string. Optional and additive: every existing consumer that only reads `payload`
  // is unaffected.
  path?: string;
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
    // Wrapped, because EventEmitter.emit calls listeners synchronously and lets a throw propagate
    // straight out of publish() — i.e. out of the agent loop that published it. One buggy renderer
    // or a subscriber that touched a closed stream would abort the run and strand in-flight agents.
    // A broken subscriber is the subscriber's problem, not the run's.
    const guarded = (ev: AgentEvent) => {
      try {
        fn(ev);
      } catch (err) {
        console.error(`niti: event subscriber threw: ${err instanceof Error ? err.message : err}`);
      }
    };
    this.emitter.on("event", guarded);
    return () => this.emitter.off("event", guarded);
  }
}
