import { test, expect } from "bun:test";
import { compactTurns, NOTES_BOARD_MARKER, truncateMiddle, resultBudgetChars, promptTokens, maskObservations, MASKED_PREFIX, BOARD_STUB, MAX_RESULT_CHARS } from "./context.ts";
import type { Provider, Turn } from "../providers/provider.ts";

test("leaves the array untouched when it's already at or under keepRecent", async () => {
  const turns: Turn[] = [{ role: "user", text: "hi" }];
  const provider: Provider = {
    async send() {
      throw new Error("should not be called");
    },
  };
  expect(await compactTurns(turns, provider, 4)).toBe(turns);
});

test("summarizes older turns into one turn, keeping the most recent N verbatim", async () => {
  const turns: Turn[] = [
    { role: "user", text: "build a login page" },
    { role: "assistant", text: "", toolCalls: [{ id: "1", name: "write_file", input: { path: "a.tsx" } }] },
    { role: "tool", results: [{ id: "1", name: "write_file", output: "wrote a.tsx" }] },
    { role: "assistant", text: "", toolCalls: [{ id: "2", name: "write_file", input: { path: "b.tsx" } }] },
    { role: "tool", results: [{ id: "2", name: "write_file", output: "wrote b.tsx" }] },
    { role: "assistant", text: "done", toolCalls: [] },
  ];
  let seenTranscript = "";
  const provider: Provider = {
    async send(_sys, sendTurns) {
      seenTranscript = (sendTurns[0] as { text: string }).text;
      return { text: "Built a login page, wrote a.tsx and b.tsx.", toolCalls: [] };
    },
  };

  const compacted = await compactTurns(turns, provider, 2);

  // A naive slice(-2) would cut mid-pair here (turns[-2] is a "tool" turn without its "assistant"
  // turn) — the safe boundary walks back one more turn to keep that pair intact, so 3 are kept.
  expect(compacted).toHaveLength(4); // 1 summary + 3 kept (pair-safe boundary, not a raw slice(-2))
  // The model's summary, plus the ledger recovered from the dropped turns without asking it.
  expect(compacted[0]).toEqual({
    role: "user",
    text: "[Earlier conversation summary]\nBuilt a login page, wrote a.tsx and b.tsx.\n\nFiles changed so far: a.tsx",
  });
  expect(compacted.slice(1)).toEqual(turns.slice(-3));
  expect(seenTranscript).toContain("build a login page");
  expect(seenTranscript).toContain("wrote a.tsx"); // still summarized (it's in the "old" half)
});

test("never keeps a tool-result turn without its preceding assistant turn (injectInbox parity shift)", async () => {
  // Mirrors what agent.ts can actually produce: an injected inbox "user" turn lands between rounds,
  // shifting the parity so a naive fixed-size tail slice would cut mid tool_call/tool_result pair.
  const turns: Turn[] = [
    { role: "user", text: "build the api" },
    { role: "assistant", text: "", toolCalls: [{ id: "X", name: "write_file", input: { path: "a.ts" } }] },
    { role: "tool", results: [{ id: "X", name: "write_file", output: "wrote a.ts" }] },
    { role: "user", text: "Messages from teammates:\n\n[from frontend · question] what's the shape?" }, // injectInbox
    { role: "assistant", text: "", toolCalls: [{ id: "Y", name: "write_file", input: { path: "b.ts" } }] },
    { role: "tool", results: [{ id: "Y", name: "write_file", output: "wrote b.ts" }] },
  ];
  const provider: Provider = { async send() { return { text: "summary", toolCalls: [] }; } };

  const compacted = await compactTurns(turns, provider, 4); // naive slice(-4) would start at index 2 = the tool(X) turn

  // The tool(X) turn must not appear without its assistant(X) turn right before it.
  const toolIdx = compacted.findIndex((t) => t.role === "tool" && "results" in t && t.results[0]?.id === "X");
  if (toolIdx !== -1) {
    expect(compacted[toolIdx - 1]).toMatchObject({ role: "assistant", toolCalls: [{ id: "X" }] });
  }
});

test("the file ledger survives a summarizer that mentions no files at all", async () => {
  // The real failure: a summarizer under a length budget writes prose and names nothing, so the
  // next turn re-reads and re-edits files the agent had already finished with.
  const turns: Turn[] = [
    { role: "user", text: "wire up auth" },
    { role: "assistant", text: "", toolCalls: [{ id: "1", name: "write_file", input: {} }] },
    { role: "tool", results: [{ id: "1", name: "write_file", output: "wrote src/auth/login.ts" }] },
    { role: "assistant", text: "", toolCalls: [{ id: "2", name: "edit", input: {} }] },
    { role: "tool", results: [{ id: "2", name: "edit", output: "edited src/routes/index.ts" }] },
    { role: "assistant", text: "", toolCalls: [{ id: "3", name: "shell", input: {} }] },
    { role: "tool", results: [{ id: "3", name: "shell", output: "error: tsc: Cannot find module './session.ts'" }] },
    // Two more rounds, so the error above falls into the half being dropped rather than the half
    // kept verbatim — it is the dropped half the ledger has to rescue.
    { role: "assistant", text: "", toolCalls: [{ id: "4", name: "read_file", input: {} }] },
    { role: "tool", results: [{ id: "4", name: "read_file", output: "     1\texport {}" }] },
    { role: "assistant", text: "still working", toolCalls: [] },
  ];
  const vague: Provider = { async send() { return { text: "Made progress on the auth work.", toolCalls: [] }; } };

  const summary = (await compactTurns(turns, vague, 2))[0] as { text: string };

  expect(summary.text).toContain("src/auth/login.ts");
  expect(summary.text).toContain("src/routes/index.ts");
  expect(summary.text).toContain("Cannot find module");
});

test("the summarizer is asked for decisions and open work, not a length", async () => {
  const turns: Turn[] = [
    { role: "user", text: "a" },
    { role: "assistant", text: "b", toolCalls: [] },
    { role: "user", text: "c" },
    { role: "assistant", text: "d", toolCalls: [] },
  ];
  let prompt = "";
  const provider: Provider = {
    async send(sys) {
      prompt = sys;
      return { text: "x", toolCalls: [] };
    },
  };
  await compactTurns(turns, provider, 2);
  expect(prompt).toContain("Decisions:");
  expect(prompt).toContain("Open:");
});

test("truncateMiddle keeps both ends, says what was dropped, and leaves short text alone", () => {
  expect(truncateMiddle("short", 100)).toBe("short");
  const out = truncateMiddle("A".repeat(500) + "B".repeat(500), 100);
  expect(out.startsWith("AAAA")).toBe(true);
  expect(out.endsWith("BBBB")).toBe(true);
  expect(out).toContain("900 characters omitted");
  expect(out.length).toBeLessThan(400);
});

test("a result's budget shrinks with the room left below the compaction line", () => {
  // Plenty of room: the fixed ceiling applies.
  expect(resultBudgetChars(10_000, 1_000_000, 0.95, 1)).toBe(MAX_RESULT_CHARS);
  // 94% full of 1M: 10k tokens left, shared by two calls → 5k tokens each at 3 chars a token.
  expect(resultBudgetChars(940_000, 1_000_000, 0.95, 2)).toBe(15_000);
  // Already past the line: a floor, so the model still gets an excerpt rather than nothing.
  expect(resultBudgetChars(990_000, 1_000_000, 0.95, 1)).toBe(3_000);
  // Unknown window: no dynamic sizing, only the ceiling.
  expect(resultBudgetChars(500_000, 0, 0.95, 1)).toBe(MAX_RESULT_CHARS);
});

test("promptTokens counts the cached part for Anthropic, whose input_tokens excludes it", () => {
  const u = { inputTokens: 500, outputTokens: 10, cacheReadTokens: 90_000, cacheWriteTokens: 2_000 };
  expect(promptTokens("anthropic", u)).toBe(92_500);
  // OpenAI and Gemini already include the cached part in their input count.
  expect(promptTokens("openai", u)).toBe(500);
  expect(promptTokens("google", u)).toBe(500);
});

// ── Observation masking ──────────────────────────────────────────────────────────────────────

const big = (tag: string, n = 2_000) => `${tag}:` + "x".repeat(n);
// One model step: an assistant turn calling a tool, then the tool's result.
function step(id: string, name: string, input: Record<string, unknown>, output: string): Turn[] {
  return [
    { role: "assistant", text: `thinking about ${id}`, toolCalls: [{ id, name, input }] },
    { role: "tool", results: [{ id, name, output }] },
  ];
}
const outputOf = (turns: Turn[], id: string): string => {
  for (const t of turns) if (t.role === "tool") for (const r of t.results) if (r.id === id) return r.output;
  throw new Error(id);
};
const OPTS = { keepRecent: 3, highWater: 1_000 };

test("masking leaves a short task completely alone", () => {
  const turns: Turn[] = [{ role: "user", text: "go" }, ...step("a", "read_file", { path: "a.ts" }, big("a")), ...step("b", "shell", { command: "ls" }, big("b"))];
  const before = JSON.stringify(turns);
  expect(maskObservations(turns)).toEqual({ masked: 0, savedChars: 0 }); // default thresholds: nothing near them
  expect(JSON.stringify(turns)).toBe(before);
});

test("old observations are masked with a stub that says how to get them back; recent ones and every call stay whole", () => {
  const turns: Turn[] = [{ role: "user", text: "go" }];
  for (const [i, path] of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"].entries()) turns.push(...step(`r${i}`, "read_file", { path }, big(path)));
  const calls = JSON.stringify(turns.filter((t) => t.role === "assistant"));

  const { masked, savedChars } = maskObservations(turns, OPTS);

  expect(masked).toBe(2); // r0 and r1: everything but the last 3 tool turns
  expect(outputOf(turns, "r0")).toStartWith(MASKED_PREFIX);
  expect(outputOf(turns, "r0")).toContain("read_file a.ts");
  expect(outputOf(turns, "r0")).toContain("2005 characters"); // what it was, so the model can weigh re-reading
  expect(outputOf(turns, "r2")).toStartWith("c.ts:");
  expect(outputOf(turns, "r3")).toStartWith("d.ts:");
  expect(outputOf(turns, "r4")).toStartWith("e.ts:");
  expect(JSON.stringify(turns.filter((t) => t.role === "assistant"))).toBe(calls); // the model's own words and calls, untouched
  expect(savedChars).toBeGreaterThan(3_500);
  // A second pass has nothing left to do.
  expect(maskObservations(turns, OPTS).masked).toBe(0);
});

test("masking waits for enough to be worth the cache miss it causes", () => {
  const turns: Turn[] = [{ role: "user", text: "go" }];
  for (let i = 0; i < 5; i++) turns.push(...step(`r${i}`, "read_file", { path: `f${i}.ts` }, big(`f${i}`, 600)));
  // Two eligible results of ~600 chars: 1.2k, under a 5k mark → no pass at all.
  expect(maskObservations(turns, { keepRecent: 3, highWater: 5_000 }).masked).toBe(0);
});

test("a superseded checklist is masked whatever its age; the latest one never is", () => {
  const turns: Turn[] = [
    { role: "user", text: "go" },
    ...step("t1", "todo", { items: ["a"] }, big("[ ] a")),
    ...step("t2", "todo", { items: ["a"] }, big("[x] a")),
    ...step("r", "shell", { command: "ls" }, big("ls")),
  ];
  maskObservations(turns, { keepRecent: 10, highWater: 1 });
  expect(outputOf(turns, "t1")).toStartWith(MASKED_PREFIX);
  expect(outputOf(turns, "t2")).toStartWith("[x] a"); // the current state
  expect(outputOf(turns, "r")).toStartWith("ls"); // recent, not superseded
});

test("a read is masked once a newer read of it, or a write to it, has replaced it", () => {
  const turns: Turn[] = [
    { role: "user", text: "go" },
    ...step("read1", "read_file", { path: "a.ts" }, big("first look")),
    ...step("read2", "read_file", { path: "a.ts" }, big("second look")), // same window, newer
    ...step("read3", "read_file", { path: "b.ts" }, big("b before edit")),
    ...step("edit", "edit", { path: "b.ts" }, "edited b.ts"),
    ...step("read4", "read_file", { path: "c.ts" }, big("untouched")),
  ];
  maskObservations(turns, { keepRecent: 10, highWater: 1 });
  expect(outputOf(turns, "read1")).toStartWith(MASKED_PREFIX);
  expect(outputOf(turns, "read2")).toStartWith("second look");
  expect(outputOf(turns, "read3")).toStartWith(MASKED_PREFIX); // b.ts changed since: this is stale text
  expect(outputOf(turns, "read4")).toStartWith("untouched");
});

test("an 'unchanged' pointer does not count as replacing the read it points to", () => {
  const turns: Turn[] = [
    { role: "user", text: "go" },
    ...step("full", "read_file", { path: "a.ts" }, big("the content")),
    ...step("again", "read_file", { path: "a.ts" }, "[unchanged: a.ts is identical to your earlier read of it (same range), which is still in this conversation above.]"),
  ];
  maskObservations(turns, { keepRecent: 10, highWater: 1 });
  expect(outputOf(turns, "full")).toStartWith("the content"); // the pointer's target must stay readable
});

test("only bulk observation tools are masked: forks, messages, edits and small results are left alone", () => {
  const turns: Turn[] = [
    { role: "user", text: "go" },
    ...step("fork", "spawn_fork", { goal: "look" }, big("the fork's findings")),
    ...step("mcp", "some_mcp_tool", {}, big("mcp result")),
    ...step("w", "write_file", { path: "x.ts" }, "wrote 3 bytes"),
    ...step("tiny", "shell", { command: "true" }, "ok"),
    ...step("last", "shell", { command: "ls" }, big("recent")),
  ];
  expect(maskObservations(turns, { keepRecent: 1, highWater: 1 }).masked).toBe(0);
});

test("masking builds new turns rather than editing the ones the store and provider already hold", () => {
  const turns: Turn[] = [{ role: "user", text: "go" }];
  for (let i = 0; i < 4; i++) turns.push(...step(`r${i}`, "shell", { command: "ls" }, big(`o${i}`)));
  const original = turns[2]!; // r0's tool turn
  maskObservations(turns, OPTS);
  expect(turns[2]).not.toBe(original);
  expect((original as { results: { output: string }[] }).results[0]!.output).toStartWith("o0"); // the old object is intact
});

// ── Compaction and the notes board ───────────────────────────────────────────────────────────

const board = (v: string): Turn => ({ role: "user", text: `${NOTES_BOARD_MARKER}\n\n[k] (from b) ${v}` });
const say = (text: string): Turn => ({ role: "assistant", text, toolCalls: [] });
function capturing(): { provider: Provider; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    provider: {
      async send(_sys, turns) {
        sent.push(turns.map((t) => (t.role === "user" ? t.text : "")).join("\n"));
        return { text: "SUMMARY", toolCalls: [] };
      },
    },
  };
}
const boardsOf = (turns: Turn[]) => turns.filter((t) => t.role === "user" && t.text.startsWith(NOTES_BOARD_MARKER)).map((t) => (t as { text: string }).text);

test("compaction keeps only the newest board, carrying it across when it would have been summarized away", async () => {
  const turns: Turn[] = [{ role: "user", text: "task" }, board("v1"), say("a"), board("v2"), say("b"), board("v3"), say("c"), say("d"), say("e"), say("f"), say("g")];
  const { provider, sent } = capturing();
  const out = await compactTurns(turns, provider, 4);
  expect(boardsOf(out)).toHaveLength(1);
  expect(boardsOf(out)[0]).toContain("v3");
  expect(out[0]).toMatchObject({ role: "user" });
  expect((out[0] as { text: string }).text).toContain("SUMMARY");
  expect(out[1]).toEqual(board("v3")); // right behind the summary, so the model still has its teammates' notes
  expect(sent[0]).not.toContain("Team notes board"); // and the summarizer never reads them
});

test("a board already in the recent window is kept in place, and older copies in it are dropped", async () => {
  const turns: Turn[] = [{ role: "user", text: "task" }, board("v1"), say("a"), say("b"), say("c"), board("v2"), say("d"), board("v3"), say("e")];
  const out = await compactTurns(turns, capturing().provider, 5);
  expect(boardsOf(out)).toHaveLength(1);
  expect(boardsOf(out)[0]).toContain("v3");
  expect(out.findIndex((t) => t.role === "user" && t.text.includes("v3"))).toBeGreaterThan(1); // in its own place, not moved up
});

test("compaction with no board anywhere is unchanged from before", async () => {
  const turns: Turn[] = [{ role: "user", text: "task" }, say("a"), say("b"), say("c"), say("d"), say("e"), say("f")];
  const out = await compactTurns(turns, capturing().provider, 4);
  expect(out).toHaveLength(5); // summary + 4 recent
  expect(boardsOf(out)).toHaveLength(0);
});

test("superseded notes boards are masked in the batch pass; only the newest stays whole", () => {
  const board = (n: number): Turn => ({ role: "user", text: `${NOTES_BOARD_MARKER}\n\n${`note ${n} `.repeat(200)}` });
  const turns: Turn[] = [{ role: "user", text: "go" }, board(1), ...step("a", "shell", { command: "ls" }, big("a", 100)), board(2), board(3)];
  const { masked, savedChars } = maskObservations(turns, { keepRecent: 10, highWater: 1_000 });
  expect(masked).toBe(2);
  expect(savedChars).toBeGreaterThan(2_000);
  expect((turns[1] as { text: string }).text).toBe(BOARD_STUB);
  expect((turns[4] as { text: string }).text).toBe(BOARD_STUB);
  expect((turns[5] as { text: string }).text).toStartWith(NOTES_BOARD_MARKER);
  expect((turns[0] as { text: string }).text).toBe("go");
  expect(maskObservations(turns, { keepRecent: 10, highWater: 1 }).masked).toBe(0); // idempotent
});
