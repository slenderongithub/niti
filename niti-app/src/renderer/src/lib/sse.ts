import type { ServerEvent } from "./types";

// The core's event stream with the TUI's reconnect behaviour (tui/cmd/niti/main.go:257-322):
// resume from the last seq seen, back off 1s → 15s, and tell the store when the link drops or
// comes back (the core never sends those — a dead core otherwise looks exactly like an idle one).
// Events are delivered in batches once per animation frame, so a burst of streamed deltas costs
// one render, not hundreds.

export interface StreamOptions {
  url: (from: number) => string;
  from: number;
  onEvents: (events: ServerEvent[]) => void;
  // Injected for tests; the browser's own by default.
  EventSourceImpl?: typeof EventSource;
  schedule?: (fn: () => void) => void;
}

export interface Stream {
  close(): void;
  lastSeq(): number;
}

export function openStream(opts: StreamOptions): Stream {
  const ES = opts.EventSourceImpl ?? EventSource;
  const schedule = opts.schedule ?? ((fn) => requestAnimationFrame(() => fn()));
  let last = opts.from;
  let es: EventSource | undefined;
  let closed = false;
  let backoff = 1000;
  let lost = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let queue: ServerEvent[] = [];
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    if (!queue.length || closed) return;
    const batch = queue;
    queue = [];
    opts.onEvents(batch);
  };
  const push = (e: ServerEvent) => {
    queue.push(e);
    if (!scheduled) {
      scheduled = true;
      schedule(flush);
    }
  };
  const synth = (state: "lost" | "restored") => push({ kind: "connection", state, seq: last, time: Date.now() });

  const connect = () => {
    if (closed) return;
    // EventSource can't set headers; the core accepts ?token= for exactly this.
    es = new ES(opts.url(last));
    es.onopen = () => {
      backoff = 1000;
      if (lost) {
        lost = false;
        synth("restored");
      }
    };
    es.onmessage = (m: MessageEvent<string>) => {
      let e: ServerEvent;
      try {
        e = JSON.parse(m.data) as ServerEvent;
      } catch {
        return;
      }
      // A replay overlapping what we already applied (reconnect races) is dropped by seq.
      if (e.kind !== "resync" && typeof e.seq === "number") {
        if (e.seq <= last) return;
        last = e.seq;
      }
      push(e);
    };
    es.onerror = () => {
      es?.close();
      es = undefined;
      if (closed) return;
      if (!lost) {
        lost = true;
        synth("lost");
      }
      retry = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15_000);
    };
  };
  connect();

  return {
    close() {
      closed = true;
      clearTimeout(retry);
      es?.close();
    },
    lastSeq: () => last,
  };
}
