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

  // The system prompt is cache_control-marked (see the dedicated caching tests below); its text is
  // otherwise unchanged.
  expect(seen.params.system).toEqual([{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
  // The second-to-last message (index 1 of 3) is the prompt-caching breakpoint for the growing
  // conversation prefix — its LAST content block carries cache_control, nothing else does.
  expect(seen.params.messages[1].content).toEqual([
    { type: "text", text: "checking" },
    { type: "tool_use", id: "tu_0", name: "read_file", input: { path: "a.ts" }, cache_control: { type: "ephemeral" } },
  ]);
  // A tool result is a *user* message carrying tool_result blocks — not a "tool" role. It's the
  // newest message, so it's deliberately NOT cache-marked (see caching tests).
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

test("usage reports cache read/write tokens when Anthropic sends them", async () => {
  const p = new AnthropicProvider("claude-opus-4-8", "k");
  withStub(p, reply([{ type: "text", text: "hi" }], { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }));
  const out = await p.send("s", [{ role: "user", text: "x" }], []);
  expect(out.usage).toEqual({ inputTokens: 7, outputTokens: 2, cacheReadTokens: 900, cacheWriteTokens: 50 });
});

test("cacheReadTokens/cacheWriteTokens are undefined, not 0, when Anthropic doesn't report them", async () => {
  const p = new AnthropicProvider("claude-opus-4-8", "k");
  withStub(p, reply([{ type: "text", text: "hi" }], { input_tokens: 7, output_tokens: 2 }));
  const out = await p.send("s", [{ role: "user", text: "x" }], []);
  expect(out.usage?.cacheReadTokens).toBeUndefined();
  expect(out.usage?.cacheWriteTokens).toBeUndefined();
});

test("a single-message call has nothing to mark as the 'second-to-last' message — only system is cache-marked", async () => {
  const p = new AnthropicProvider("claude-opus-4-8", "k");
  const seen = withStub(p, reply([{ type: "text", text: "hi" }]));
  await p.send("SYS", [{ role: "user", text: "only turn" }], []);
  expect(seen.params.system).toEqual([{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
  expect(seen.params.messages[0]).toEqual({ role: "user", content: "only turn" }); // untouched — no [-2] exists
});

test("a plain string user message becomes a one-block array when it's the cache breakpoint", async () => {
  const p = new AnthropicProvider("claude-opus-4-8", "k");
  const seen = withStub(p, reply([{ type: "text", text: "hi" }]));
  const turns: Turn[] = [
    { role: "user", text: "first message" }, // second-to-last → gets marked
    { role: "user", text: "second message" }, // newest → left alone
  ];
  await p.send("s", turns, []);
  expect(seen.params.messages[0]).toEqual({
    role: "user",
    content: [{ type: "text", text: "first message", cache_control: { type: "ephemeral" } }],
  });
  expect(seen.params.messages[1]).toEqual({ role: "user", content: "second message" });
});

test("a replayed assistant turn ending in a thinking block is left unmarked rather than sending an invalid cache_control", async () => {
  const p = new AnthropicProvider("claude-opus-4-8", "k");
  const raw = [{ type: "text", text: "reasoning aside" }, { type: "thinking", thinking: "…", signature: "sig" }];
  const seen = withStub(p, reply([{ type: "text", text: "done" }]));
  const turns: Turn[] = [
    { role: "assistant", text: "ignored", toolCalls: [], raw },
    { role: "user", text: "follow-up" },
  ];
  await p.send("s", turns, []);
  expect(seen.params.messages[0].content).toBe(raw); // untouched: thinking blocks can't carry cache_control
});

test("prompt caching is withheld from Anthropic-compatible third parties, same as `thinking`", async () => {
  const shim = new AnthropicProvider("MiniMax-M2", "k", "https://api.minimax.io/anthropic/v1", 4096);
  const seen = withStub(shim, reply([{ type: "text", text: "" }]));
  const turns: Turn[] = [
    { role: "user", text: "first" },
    { role: "user", text: "second" },
  ];
  await shim.send("SYS", turns, []);
  expect(seen.params.system).toBe("SYS"); // plain string, not the cache_control array form
  expect(seen.params.messages[0]).toEqual({ role: "user", content: "first" }); // not cache-marked either
});
