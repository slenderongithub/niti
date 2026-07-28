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

  expect(compacted).toHaveLength(3); // 1 summary + 2 kept
  expect(compacted[0]).toEqual({
    role: "user",
    text: "[Earlier conversation summary]\nBuilt a login page, wrote a.tsx and b.tsx.",
  });
  expect(compacted.slice(1)).toEqual(turns.slice(-2));
  expect(seenTranscript).toContain("build a login page");
  expect(seenTranscript).toContain("wrote a.tsx");
});
