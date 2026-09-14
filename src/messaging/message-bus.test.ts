import { test, expect } from "bun:test";
import { MessageBus, ORCHESTRATOR, USER } from "./message-bus.ts";

function bus() {
  const b = new MessageBus();
  b.register("frontend");
  b.register("backend");
  return b;
}

test("delivers a message to the recipient inbox", () => {
  const b = bus();
  const r = b.post({ from: "frontend", to: "backend", kind: "question", subject: "api shape?", body: "GET /products?" });
  expect(r.ok).toBe(true);
  expect(r.delivered).toEqual(["backend"]);
  const drained = b.drain("backend");
  expect(drained.length).toBe(1);
  expect(drained[0]!.subject).toBe("api shape?");
  expect(b.pending("backend")).toBe(0); // drain clears
});

test("rejects an unknown recipient", () => {
  const b = bus();
  const r = b.post({ from: "frontend", to: "ghost", kind: "handoff", subject: "x", body: "y" });
  expect(r.ok).toBe(false);
  expect(r.reason).toContain("unknown recipient");
});

test("broadcast reaches every agent except the sender", () => {
  const b = bus();
  b.register("designer");
  const r = b.post({ from: "designer", to: "*", kind: "broadcast", subject: "palette", body: "use pastels" });
  expect(r.ok).toBe(true);
  expect(r.delivered.sort()).toEqual(["backend", "frontend"]);
});

test("restrict blocks unauthorized edges but keeps allowed ones", () => {
  const b = bus();
  b.restrict([["frontend", "backend"]]); // only frontend→backend
  expect(b.post({ from: "frontend", to: "backend", kind: "question", subject: "a", body: "b" }).ok).toBe(true);
  const blocked = b.post({ from: "backend", to: "frontend", kind: "answer", subject: "a", body: "b" });
  expect(blocked.ok).toBe(false);
});

test("orchestrator can always reach and be reached", () => {
  const b = bus();
  b.restrict([]); // nothing allowed between agents…
  expect(b.post({ from: ORCHESTRATOR, to: "frontend", kind: "handoff", subject: "go", body: "" }).ok).toBe(true);
  expect(b.post({ from: "frontend", to: ORCHESTRATOR, kind: "answer", subject: "done", body: "" }).ok).toBe(true);
});

test("rate cap stops a runaway ping-pong between two agents", () => {
  const b = bus();
  let ok = 0;
  for (let i = 0; i < 25; i++) {
    if (b.post({ from: "frontend", to: "backend", kind: "question", subject: `q${i}`, body: "" }).ok) ok++;
  }
  expect(ok).toBe(10); // MAX_PER_PAIR
  b.resetCaps();
  expect(b.post({ from: "frontend", to: "backend", kind: "question", subject: "again", body: "" }).ok).toBe(true);
});

test("a user nudge is never rate-capped — a human interrupting is not a loop", () => {
  const b = bus();
  for (let i = 0; i < 25; i++) {
    expect(b.post({ from: USER, to: "backend", kind: "handoff", subject: `nudge ${i}`, body: "x" }).ok).toBe(true);
  }
  expect(b.drain("backend").length).toBe(25);
});

test("authorize enforces the rate cap and reports why a blocked edge failed", () => {
  const b = bus();
  b.restrict([]); // no agent-to-agent edges allowed
  const blocked = b.authorize("frontend", "backend");
  expect(blocked.ok).toBe(false);
  expect(blocked.reason).toContain("not authorized");

  b.allowAll();
  let ok = 0;
  for (let i = 0; i < 15; i++) if (b.authorize("frontend", "backend").ok) ok++;
  expect(ok).toBe(10); // shares MAX_PER_PAIR with post()
  expect(b.authorize("frontend", "backend").reason).toContain("rate cap");
});

test("announce notifies subscribers without enqueueing to an inbox (no double-delivery)", () => {
  const b = bus();
  const seen: string[] = [];
  b.subscribe((m) => seen.push(m.subject));
  b.announce({ from: "frontend", to: "backend", kind: "question", subject: "sync-q", body: "?" });
  expect(seen).toEqual(["sync-q"]);
  expect(b.pending("backend")).toBe(0); // not queued
});

test("subscribers see every posted message once", () => {
  const b = bus();
  const seen: string[] = [];
  b.subscribe((m) => seen.push(m.subject));
  b.post({ from: "frontend", to: "backend", kind: "handoff", subject: "one", body: "" });
  b.post({ from: "backend", to: "frontend", kind: "answer", subject: "two", body: "" });
  expect(seen).toEqual(["one", "two"]);
});

test("remember/recall: a note is visible to every agent, not just the writer, and is never drained", () => {
  const b = bus();
  b.remember("frontend", "api-base-url", "https://api.internal");
  expect(b.recall("api-base-url").map((n) => n.body)).toEqual(["https://api.internal"]);
  // Read again — unlike drain(), recall() doesn't consume it.
  expect(b.recall("api-base-url").map((n) => n.body)).toEqual(["https://api.internal"]);
  expect(b.recall("no-such-key")).toEqual([]);
});

test("remember on an existing key overwrites it — latest write wins", () => {
  const b = bus();
  b.remember("frontend", "theme", "dark");
  b.remember("backend", "theme", "light");
  const notes = b.recall("theme");
  expect(notes).toHaveLength(1);
  expect(notes[0]!.body).toBe("light");
  expect(notes[0]!.from).toBe("backend");
});

test("recall with no key returns the whole board", () => {
  const b = bus();
  b.remember("frontend", "a", "1");
  b.remember("frontend", "b", "2");
  expect(b.recall().map((n) => n.subject).sort()).toEqual(["a", "b"]);
});

test("notesVersion bumps on every remember, so a reader can detect change without diffing", () => {
  const b = bus();
  const v0 = b.getNotesVersion();
  b.remember("frontend", "a", "1");
  const v1 = b.getNotesVersion();
  expect(v1).toBeGreaterThan(v0);
  b.remember("frontend", "a", "2"); // same key, still a write
  expect(b.getNotesVersion()).toBeGreaterThan(v1);
});

test("hydrateNotes reseeds the board from persisted rows without notifying subscribers", () => {
  const b = bus();
  const seen: string[] = [];
  b.subscribe((m) => seen.push(m.subject));
  b.hydrateNotes([{ key: "budget-cap", value: "$50", from: "architect", time: 1000 }]);
  expect(b.recall("budget-cap").map((n) => n.body)).toEqual(["$50"]);
  expect(seen).toEqual([]); // replay, not a live write — no UI event
});

test("remember bypasses the per-pair rate cap and edge restrictions (it's not a pairwise exchange)", () => {
  const b = bus();
  b.restrict([]); // no agent-to-agent edges allowed at all
  for (let i = 0; i < 15; i++) b.remember("frontend", `k${i}`, "v");
  expect(b.recall().length).toBe(15);
});
