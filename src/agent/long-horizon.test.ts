import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "./agent.ts";
import { Bus } from "../events/bus.ts";
import { NOTES_BOARD_MARKER, MASKED_PREFIX, BOARD_STUB, MAX_RESULT_CHARS } from "./context.ts";
import type { Provider, ToolCall, Turn } from "../providers/provider.ts";
import type { Messenger } from "../messaging/message-bus.ts";

// A 25-turn run against a scripted provider: no network, no model. It measures what the last eight
// context commits (ingestion capping, repeat-read pointers, append-only todo/notes, observation
// masking) do to the bytes actually sent, against what an unmasked, uncapped run would have sent.

const CONTEXT = 128_000; // an unknown provider name gets the default window
const CHARS_PER_TOKEN = 3; // the same pessimistic ratio the agent sizes results with
const fileBody = (tag: string, chars: number) =>
  Array.from({ length: Math.ceil(chars / 40) }, (_, i) => `${tag} line ${i} ${"x".repeat(24)}`).join("\n");
const todo = (n: number): ToolCall["input"] => ({
  items: Array.from({ length: 8 }, (_, i) => ({ text: `step ${i} of pass ${n} `.padEnd(100, "."), status: i < n ? "done" : "pending" })),
});

// Plays back a fixed list of tool calls, one per round, then finishes. Reports the size of what it
// was sent as `usage`, the way a real provider does, so the agent's own headroom logic is exercised.
class ScriptedProvider implements Provider {
  sent: Turn[][] = []; // a copy of every request, taken at send time
  constructor(private script: (round: number, turns: Turn[]) => ToolCall | undefined) {}
  async send(_sys: string, turns: Turn[]) {
    this.sent.push(structuredClone(turns));
    const call = this.script(this.sent.length, turns);
    const inputTokens = Math.ceil(JSON.stringify(turns).length / CHARS_PER_TOKEN);
    return { text: call ? "" : "done", toolCalls: call ? [call] : [], usage: { inputTokens, outputTokens: 10 } };
  }
}

const outputs = (turns: Turn[]): Map<string, string> => {
  const m = new Map<string, string>();
  for (const t of turns) if (t.role === "tool") for (const r of t.results) m.set(r.id, r.output);
  return m;
};
const boardTexts = (turns: Turn[]): string[] =>
  turns.flatMap((t) => (t.role === "user" && (t.text.startsWith(NOTES_BOARD_MARKER) || t.text === BOARD_STUB) ? [t.text] : []));

test("25 turns: capped, deduplicated, append-only, then masked — and far cheaper than an unmasked run", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-horizon-"));
  // f1 fits under the result cap (so a re-read can point back to it); f2–f5 do not.
  writeFileSync(join(root, "f1.ts"), fileBody("f1", 52_000));
  for (const f of ["f2", "f3", "f4", "f5"]) writeFileSync(join(root, `${f}.ts`), fileBody(f, 90_000));
  writeFileSync(join(root, "f6.ts"), fileBody("f6", 40_000));
  for (let i = 1; i <= 11; i++) writeFileSync(join(root, `g${i}.ts`), fileBody(`g${i}`, 20_000));

  const notes = { version: 0, n: 0 };
  const messenger: Messenger = {
    peers: () => [],
    send: () => "ok",
    ask: async () => "ok",
    inbox: () => [],
    pending: () => 0,
    remember: () => ({ id: "n1", from: "a", to: "*", kind: "note", subject: "", body: "", time: 0 }),
    recall: () => (notes.n === 0 ? [] : [{ id: "n1", from: "b", to: "*", kind: "note", subject: "plan", body: `revision ${notes.n}: ${"finding ".repeat(120)}`, time: 0 }]),
    notesVersion: () => notes.version,
  };
  const bumpNotes = () => { notes.version++; notes.n++; };

  const read = (id: string, path: string): ToolCall => ({ id, name: "read_file", input: { path } });
  // One call per round; round r's result is tool turn r.
  const script = (round: number): ToolCall | undefined => {
    if (round <= 5) return read(`r${round}`, `f${round}.ts`); //                       1–5: large files
    if (round <= 10) return read(`r${round}`, ["f1.ts", "f1.ts", "f6.ts", "f6.ts", "f1.ts"][round - 6]!); // 6–10: repeats, and f6 once in full
    if (round <= 15) {
      // 11–15: three checklist updates and three notes-board changes
      if (round % 2 === 1) { bumpNotes(); return { id: `t${round}`, name: "todo", input: todo(round) }; }
      return read(`r${round}`, `g${round - 2}.ts`); // filler: g10, g11 (a re-read after a masking pass is whole by design)
    }
    if (round === 16) return { id: "w16", name: "write_file", input: { path: "f6.ts", content: "changed\n" } }; // f6's read goes stale
    if (round <= 25) return read(`r${round}`, `g${round - 16}.ts`);
    return undefined;
  };

  const provider = new ScriptedProvider(script);
  const bus = new Bus();
  const agent = new Agent(
    { id: "a", provider: "scripted", model: "x", role: "r", systemPrompt: "s", allowedTools: ["read_file", "write_file"], autoApprove: ["write_file"] },
    provider,
    bus,
    { root, messenger },
  );
  expect(await agent.run("work through the repo")).toBe("done");
  const sent = provider.sent;
  expect(sent).toHaveLength(26); // 25 tool rounds + the final answer

  // ── Turns 1–5: ingestion capping keeps every request inside the window ──
  const afterReads = outputs(sent[5]!);
  for (const id of ["r2", "r3", "r4", "r5"]) {
    expect(afterReads.get(id)!).toContain("characters omitted from the middle");
    expect(afterReads.get(id)!.length).toBeLessThan(MAX_RESULT_CHARS + 500);
  }
  expect(afterReads.get("r1")!.length).toBeGreaterThan(50_000); // f1 came through whole
  expect(afterReads.get("r1")!).not.toContain("omitted");
  const fill = sent.map((turns) => JSON.stringify(turns).length / CHARS_PER_TOKEN / CONTEXT);
  expect(Math.max(...fill)).toBeLessThan(0.95);

  // ── Turns 6–10: an unchanged re-read is a pointer, not the payload ──
  const dup = outputs(sent[10]!);
  for (const id of ["r6", "r7", "r10"]) {
    expect(dup.get(id)!).toStartWith("[unchanged:");
    expect(dup.get(id)!.length).toBeLessThan(300);
  }
  expect(dup.get("r8")!).toContain("f6 line 0"); // first read of f6 is in full…
  expect(dup.get("r9")!).toStartWith("[unchanged:"); // …its repeat is not

  // ── Turns 11–15: todo and notes change three times each, and history is only ever appended to ──
  // Until the first masking pass nothing already sent may change. After it, the only permitted
  // change to an earlier turn is becoming a stub — never a rewrite, never a delete from the middle.
  const isStub = (t: Turn): boolean =>
    t.role === "tool" ? t.results.every((r) => r.output.startsWith(MASKED_PREFIX) || r.output.length < 500) : t.role === "user" && t.text === BOARD_STUB;
  let firstRewrite = -1;
  for (let k = 1; k < sent.length; k++) {
    const prev = sent[k - 1]!;
    expect(sent[k]!.length).toBeGreaterThanOrEqual(prev.length); // no turn ever removed
    prev.forEach((t, i) => {
      if (JSON.stringify(sent[k]![i]) === JSON.stringify(t)) return;
      if (firstRewrite < 0) firstRewrite = k;
      expect(isStub(sent[k]![i]!)).toBe(true);
    });
  }
  expect(firstRewrite).toBe(11); // the request after tool turn 11: r1 leaves the last-10 window, and alone is over 30k
  expect([...outputs(sent[15]!).keys()].filter((id) => id.startsWith("t"))).toEqual(["t11", "t13", "t15"]);

  // ── Turns 16–20 and after: masking has replaced superseded notes, stale reads and old outputs ──
  const final = sent[25]!;
  const fin = outputs(final);
  for (const id of ["r1", "r2", "r3", "r4", "r5"]) expect(fin.get(id)!).toStartWith(MASKED_PREFIX); // old outputs
  expect(fin.get("t11")!).toStartWith(MASKED_PREFIX); // superseded checklists…
  expect(fin.get("t13")!).toStartWith(MASKED_PREFIX);
  expect(fin.get("t15")!).not.toStartWith(MASKED_PREFIX); // …but the latest stays whole
  const boards = boardTexts(final);
  expect(boards).toHaveLength(3);
  expect(boards.slice(0, 2)).toEqual([BOARD_STUB, BOARD_STUB]); // superseded notes
  expect(boards[2]!).toStartWith(NOTES_BOARD_MARKER);
  expect(outputs(sent[15]!).get("r8")!).not.toStartWith(MASKED_PREFIX); // f6's read is current until it is written…
  expect(outputs(sent[16]!).get("r8")!).toStartWith(MASKED_PREFIX); // …and stale the round after write_file f6
  for (const id of ["r6", "r7", "r9", "r10"]) expect(fin.get(id)!).toStartWith("[unchanged:"); // pointers: too small to be worth a stub
  // The last 10 tool turns stay whole: at the final request that is turns 16–25.
  for (let r = 17; r <= 25; r++) expect(fin.get(`r${r}`)!).not.toStartWith(MASKED_PREFIX);
  expect(fin.get("w16")!).toStartWith("wrote");
  expect(fin.get("r17")!).toContain("g1 line 0");

  // ── Turns 21–25: total input against a baseline that never masks, caps or deduplicates ──
  // The baseline is the same run with every result at the size it would have had: a truncated read
  // gets its omitted characters back, a pointer becomes the read it points to, a masked turn its
  // original text. Sizes are taken the first time each turn is seen, when nothing has touched it.
  const original: number[] = []; // JSON size of turn i as first sent, corrected to its uncapped size
  const readSize = new Map<string, number>();
  const uncapped = (out: string, path: string): number => {
    const m = /\[… (\d+) characters omitted/.exec(out);
    if (m) return out.length + Number(m[1]);
    if (out.startsWith("[unchanged:")) return readSize.get(path) ?? out.length;
    return out.length;
  };
  const actualTokens = sent.map((turns) => JSON.stringify(turns).length / CHARS_PER_TOKEN);
  let baselineTokens = 0;
  sent.forEach((turns) => {
    turns.forEach((t, i) => {
      if (original[i] !== undefined) return;
      let size = JSON.stringify(t).length;
      if (t.role === "tool") {
        for (const r of t.results) {
          const call = sent.at(-1)!.flatMap((x) => (x.role === "assistant" ? x.toolCalls : [])).find((c) => c.id === r.id);
          const path = String(call?.input.path ?? "");
          const full = uncapped(r.output, path);
          if (call?.name === "read_file" && !r.output.startsWith("[unchanged:")) readSize.set(path, full);
          size += full - r.output.length;
        }
      }
      original[i] = size;
    });
    baselineTokens += original.slice(0, turns.length).reduce((a, b) => a + b, 0) / CHARS_PER_TOKEN;
  });
  const actual = actualTokens.reduce((a, b) => a + b, 0);
  const saved = 1 - actual / baselineTokens;
  console.log(`long-horizon: ${Math.round(actual)} input tokens vs ${Math.round(baselineTokens)} unmasked/uncapped (${(saved * 100).toFixed(1)}% saved)`);
  expect(actual).toBeLessThan(baselineTokens * 0.6); // at least 40% fewer
  // The baseline would have blown the window the run stayed inside.
  expect(Math.max(...sent.map((_, k) => original.slice(0, sent[k]!.length).reduce((a, b) => a + b, 0) / CHARS_PER_TOKEN)) / CONTEXT).toBeGreaterThan(0.95);
});
