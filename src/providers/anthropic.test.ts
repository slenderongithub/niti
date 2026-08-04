import { test, expect } from "bun:test";
import { AnthropicProvider } from "./anthropic.ts";
import type { Turn } from "./provider.ts";

// The other untested transport. Two things here are load-bearing and easy to break silently: the
// verbatim replay of native content blocks (dropping them 400s the *next* turn once adaptive
// thinking is on), and the Anthropic-only parameters that must not be sent to a compatible shim.

function withStub(provider: AnthropicProvider, reply: unknown) {
  const seen: { params?: any } = {};
  (provider as unknown as { client: unknown }).client = {
    messages: { create: async (params: any) => ((seen.params = params), reply) },
  };
  return seen;
}

const reply = (content: unknown[], usage?: unknown) => ({ content, usage });

test("tool_use blocks translate both ways, and tool results go back as a user turn", async () => {
  const p = new AnthropicProvider("claude-opus-4-8", "k");
  const seen = withStub(p, reply([{ type: "tool_use", id: "tu_1", name: "shell", input: { command: "ls" } }]));

  const turns: Turn[] = [
    { role: "user", text: "look around" },
    { role: "assistant", text: "checking", toolCalls: [{ id: "tu_0", name: "read_file", input: { path: "a.ts" } }] },
    { role: "tool", results: [{ id: "tu_0", name: "read_file", output: "contents" }] },
  ];
  const out = await p.send("SYS", turns, [{ name: "shell", description: "d", parameters: { type: "object", properties: {} } }]);

  expect(seen.params.system).toBe("SYS");
  expect(seen.params.messages[1].content).toEqual([
    { type: "text", text: "checking" },
    { type: "tool_use", id: "tu_0", name: "read_file", input: { path: "a.ts" } },
  ]);
  // A tool result is a *user* message carrying tool_result blocks — not a "tool" role.
  expect(seen.params.messages[2]).toEqual({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "tu_0", content: "contents" }],
  });
  expect(out.toolCalls).toEqual([{ id: "tu_1", name: "shell", input: { command: "ls" } }]);
});

test("native blocks are replayed verbatim when present, preserving thinking blocks", async () => {
  // Rebuilding the assistant turn from text+toolCalls drops the thinking block, and the *next*
  // request then 400s. `raw` exists precisely so that cannot happen.
  const p = new AnthropicProvider("claude-opus-4-8", "k");
  const raw = [
    { type: "thinking", thinking: "…", signature: "sig" },
    { type: "tool_use", id: "tu_0", name: "shell", input: {} },
  ];
  const seen = withStub(p, reply([{ type: "text", text: "done" }]));
  await p.send("s", [{ role: "assistant", text: "ignored", toolCalls: [], raw }], []);
  expect(seen.params.messages[0].content).toBe(raw);
});

test("Anthropic-only parameters are withheld from compatible third parties", async () => {
  // MiniMax ships an Anthropic-format shim in the catalog. `thinking` is Anthropic-proprietary,
  // and a strict shim 400s on an unknown top-level parameter.
  const native = new AnthropicProvider("claude-opus-4-8", "k");
  const shim = new AnthropicProvider("MiniMax-M2", "k", "https://api.minimax.io/anthropic/v1", 4096);
  const seenNative = withStub(native, reply([{ type: "text", text: "" }]));
  const seenShim = withStub(shim, reply([{ type: "text", text: "" }]));

  await native.send("s", [{ role: "user", text: "x" }], []);
  await shim.send("s", [{ role: "user", text: "x" }], []);

  expect(seenNative.params.thinking).toEqual({ type: "adaptive" });
  expect(seenShim.params.thinking).toBeUndefined();
  // ...and max_tokens is per-entry, not a fixed 16000 that overflows a smaller model's cap.
  expect(seenNative.params.max_tokens).toBe(16000);
  expect(seenShim.params.max_tokens).toBe(4096);
});

test("usage is normalised from Anthropic's field names", async () => {
  const p = new AnthropicProvider("claude-opus-4-8", "k");
  withStub(p, reply([{ type: "text", text: "hi" }], { input_tokens: 7, output_tokens: 2 }));
  const out = await p.send("s", [{ role: "user", text: "x" }], []);
  expect(out).toMatchObject({ text: "hi", usage: { inputTokens: 7, outputTokens: 2 } });
});
