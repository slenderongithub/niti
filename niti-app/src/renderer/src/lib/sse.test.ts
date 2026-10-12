import { expect, test } from "bun:test";
import { openStream } from "./sse";
import type { ServerEvent } from "./types";

class FakeES {
  static all: FakeES[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeES.all.push(this);
  }
  emit(e: Partial<ServerEvent>) {
    this.onmessage?.({ data: JSON.stringify(e) } as MessageEvent<string>);
  }
  close() {
    this.closed = true;
  }
}

test("resumes from the last seq, drops replays, and reports the link", async () => {
  const got: ServerEvent[] = [];
  const s = openStream({ url: (from) => `/events?from=${from}`, from: 0, onEvents: (e) => got.push(...e), EventSourceImpl: FakeES as unknown as typeof EventSource, schedule: (fn) => fn() });
  const es = FakeES.all[0]!;
  es.onopen?.();
  es.emit({ kind: "theme", theme: "x", seq: 1, time: 0 });
  es.emit({ kind: "theme", theme: "y", seq: 2, time: 0 });
  es.emit({ kind: "theme", theme: "dup", seq: 2, time: 0 });
  expect(got.map((e) => e.seq)).toEqual([1, 2]);
  es.onerror?.();
  expect(got.at(-1)).toMatchObject({ kind: "connection", state: "lost" });
  await Bun.sleep(1100);
  const es2 = FakeES.all[1]!;
  expect(es2.url).toBe("/events?from=2");
  es2.onopen?.();
  expect(got.at(-1)).toMatchObject({ kind: "connection", state: "restored" });
  s.close();
  expect(es2.closed).toBe(true);
});
