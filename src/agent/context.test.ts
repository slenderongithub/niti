import { test, expect } from "bun:test";
import { compactTurns, truncateMiddle, resultBudgetChars, promptTokens, MAX_RESULT_CHARS } from "./context.ts";
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
