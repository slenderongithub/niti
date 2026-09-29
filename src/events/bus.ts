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
  | "error"
  // The live view (all additive — a consumer that ignores them sees exactly what it saw before):
  | "tool_output" // a running shell call's latest output lines (payload), throttled
  | "tool_end" // end of a call that published no other end event (coordination tools, forks)
  | "todo"; // the agent's checklist changed (todos), payload is the rendered list

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
  // "file_edit" only: a unified snippet of what changed (see snippetDiff), for the TUI feed.
  diff?: string;

  // --- the live view (optional, additive) ---
  // Pairs a call's start with its end and its streamed output: the provider's tool call id.
  callId?: string;
  phase?: "start" | "end";
  tool?: string; // the tool's name, so a consumer needn't parse it out of payload
  ok?: boolean; // end: whether the call succeeded (an error event is the failed end)
  durationMs?: number;
  exitCode?: number; // shell
  outcome?: string; // end: the one line that stays in the transcript ("48 passed", "exit 1")
  lines?: number; // end: how many lines of output there were in total
  head?: string[]; // end: the first few output lines, for the collapsed view
  tail?: string[]; // end: the last few
  body?: string[]; // end (shell): up to 60 lines — what the live view shows when expanded
  hunks?: { lines: { k: "+" | "-" | " "; t: string; o?: number; n?: number }[] }[]; // file_edit: the change, numbered
  added?: number;
  removed?: number;
  more?: number; // diff lines beyond what hunks carries
  todos?: { text: string; status: string }[]; // "todo"
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
