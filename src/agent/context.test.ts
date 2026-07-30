import { test, expect } from "bun:test";
import { compactTurns } from "./context.ts";
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
  expect(compacted[0]).toEqual({
    role: "user",
    text: "[Earlier conversation summary]\nBuilt a login page, wrote a.tsx and b.tsx.",
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
