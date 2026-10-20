import { test, expect } from "bun:test";
import { OpenAIProvider, reasoningEffort } from "./openai.ts";
import type { Turn } from "./provider.ts";

// This class is the transport for every non-Anthropic, non-Gemini model in the catalog — the
// majority of it — and it had no test at all. The risky part is the translation either way: our
// Turn[] into OpenAI's message shape, and its response back into a ProviderReply. Both are
// exercised here against a stubbed client, so no network and no key.

// Swap the SDK client for a recorder. `send` only ever touches chat.completions.create.
function withStub(provider: OpenAIProvider, reply: unknown) {
  const seen: { params?: any } = {};
  (provider as unknown as { client: unknown }).client = {
    chat: { completions: { create: async (params: any) => ((seen.params = params), reply) } },
  };
  return seen;
}

const reply = (message: unknown, usage?: unknown) => ({ choices: [{ message }], usage });

test("a tool call round-trips: our Turn[] out, OpenAI's tool_calls back in", async () => {
  const p = new OpenAIProvider("gpt-4o", "k");
  const seen = withStub(
    p,
    reply({
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "write_file", arguments: '{"path":"a.ts","content":"x"}' } }],
    }),
  );

  const turns: Turn[] = [
    { role: "user", text: "write it" },
    { role: "assistant", text: "", toolCalls: [{ id: "call_0", name: "read_file", input: { path: "a.ts" } }] },
    { role: "tool", results: [{ id: "call_0", name: "read_file", output: "old contents" }] },
  ];
  const out = await p.send("SYS", turns, [
    { name: "write_file", description: "d", parameters: { type: "object", properties: {} } },
  ]);

  // Outbound: system first, tool results as their own `tool` messages keyed by call id.
  expect(seen.params.messages[0]).toEqual({ role: "system", content: "SYS" });
  expect(seen.params.messages[1]).toEqual({ role: "user", content: "write it" });
  expect(seen.params.messages[2].tool_calls[0]).toMatchObject({ id: "call_0", function: { name: "read_file" } });
  expect(seen.params.messages[3]).toEqual({ role: "tool", tool_call_id: "call_0", content: "old contents" });
  expect(seen.params.tools[0].function.name).toBe("write_file");

  // Inbound: arguments are JSON *text* on the wire and must come back as a parsed object.
  expect(out.toolCalls).toEqual([{ id: "call_1", name: "write_file", input: { path: "a.ts", content: "x" } }]);
  expect(out.text).toBe("");
});

test("malformed tool arguments don't throw: repaired when possible, otherwise the call says why", async () => {
  // A model emitting truncated JSON must not take the whole agent loop down with it — and must be
  // told, rather than having its call run with empty arguments.
  const p = new OpenAIProvider("gpt-4o", "k");
  withStub(p, reply({ content: null, tool_calls: [{ id: "c", type: "function", function: { name: "shell", arguments: '{"command":' } }] }));
  const out = await p.send("s", [{ role: "user", text: "go" }], []);
  expect(out.toolCalls).toEqual([{ id: "c", name: "shell", input: {}, parseError: expect.stringContaining("not valid JSON") }]);
  withStub(p, reply({ content: null, tool_calls: [{ id: "d", type: "function", function: { name: "read_file", arguments: '```json\n{"path": "a.ts",}\n```' } }] }));
  expect((await p.send("s", [{ role: "user", text: "go" }], [])).toolCalls).toEqual([{ id: "d", name: "read_file", input: { path: "a.ts" } }]);
});

test("usage is normalised, and a reply with no choices is empty rather than a crash", async () => {
  const p = new OpenAIProvider("gpt-4o", "k");
  withStub(p, reply({ content: "hi" }, { prompt_tokens: 10, completion_tokens: 3 }));
  expect(await p.send("s", [{ role: "user", text: "x" }], [])).toMatchObject({
    text: "hi",
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 3 },
  });

  // An empty `choices` array is what a content filter or a gateway error looks like.
  const q = new OpenAIProvider("gpt-4o", "k");
  withStub(q, { choices: [] });
  expect(await q.send("s", [{ role: "user", text: "x" }], [])).toMatchObject({ text: "", toolCalls: [] });
});

test("cached_tokens surfaces as cacheReadTokens — OpenAI's auto-caching needs no request-side change to report", async () => {
  const p = new OpenAIProvider("gpt-4o", "k");
  withStub(p, reply({ content: "hi" }, { prompt_tokens: 1200, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 1024 } }));
  const out = await p.send("s", [{ role: "user", text: "x" }], []);
  expect(out.usage).toMatchObject({ inputTokens: 1200, outputTokens: 3, cacheReadTokens: 1024 });
});

test("cacheReadTokens is undefined, not 0, when OpenAI doesn't report prompt_tokens_details", async () => {
  const p = new OpenAIProvider("gpt-4o", "k");
  withStub(p, reply({ content: "hi" }, { prompt_tokens: 10, completion_tokens: 3 }));
  const out = await p.send("s", [{ role: "user", text: "x" }], []);
  expect(out.usage?.cacheReadTokens).toBeUndefined();
});

test("no tools means no `tools` key at all — some endpoints reject an empty array", async () => {
  const p = new OpenAIProvider("gpt-4o", "k");
  const seen = withStub(p, reply({ content: "ok" }));
  await p.send("s", [{ role: "user", text: "x" }], []);
  expect("tools" in seen.params!).toBe(false);
});

test("stream_options is withheld from local runtimes, which reject unknown parameters", async () => {
  const hosted = new OpenAIProvider("m", "k", "https://api.deepseek.com/v1");
  const local = new OpenAIProvider("m", "k", "http://localhost:11434/v1");
  const seenHosted = withStub(hosted, reply({ content: "" }));
  const seenLocal = withStub(local, reply({ content: "" }));

  // Streaming path: the stub returns a non-iterable, so just assert what was requested.
  await hosted.send("s", [{ role: "user", text: "x" }], [], () => {}).catch(() => {});
  await local.send("s", [{ role: "user", text: "x" }], [], () => {}).catch(() => {});

  expect(seenHosted.params?.stream_options).toEqual({ include_usage: true });
  expect(seenLocal.params?.stream_options).toBeUndefined();
});

test("reasoning_effort is sent only when asked for, since most catalog models reject it", () => {
  expect(reasoningEffort("high")).toEqual({ reasoning_effort: "high" });
  expect(reasoningEffort("auto")).toEqual({}); // auto = leave the model's own default alone
  expect(reasoningEffort(undefined)).toEqual({});
});

test("reasoning is encoded per vendor: 'minimal' only on OpenAI's GPT-5, OpenRouter's own object", () => {
  expect(reasoningEffort("off", "openai", "gpt-5-mini")).toEqual({ reasoning_effort: "minimal" });
  expect(reasoningEffort("off", "openai", "o3")).toEqual({ reasoning_effort: "low" });
  expect(reasoningEffort("off", "groq", "openai/gpt-oss-120b")).toEqual({ reasoning_effort: "low" }); // groq rejects minimal
  expect(reasoningEffort("medium", "openrouter", "openai/gpt-5")).toEqual({ reasoning: { effort: "medium" } });
});

test("native OpenAI gets a prompt_cache_key and max_completion_tokens; compatible vendors get max_tokens", async () => {
  const native = new OpenAIProvider("gpt-5", "k", undefined, undefined, undefined, { vendor: "openai", cacheKey: "niti-lead", maxOutput: 8000 });
  const seenNative = withStub(native, reply({ content: "ok" }));
  await native.send("S", [{ role: "user", text: "hi" }], []);
  expect(seenNative.params.prompt_cache_key).toBe("niti-lead");
  expect(seenNative.params.max_completion_tokens).toBe(8000);

  const groq = new OpenAIProvider("llama-3.3-70b", "k", "https://api.groq.com/openai/v1", undefined, undefined, { vendor: "groq", cacheKey: "niti-lead", maxOutput: 8000 });
  const seenGroq = withStub(groq, reply({ content: "ok" }));
  await groq.send("S", [{ role: "user", text: "hi" }], []);
  expect("prompt_cache_key" in seenGroq.params).toBe(false); // an OpenAI-only parameter
  expect(seenGroq.params.max_tokens).toBe(8000);
});

test("usage: reasoning tokens and DeepSeek's cache-hit field are read", async () => {
  const p = new OpenAIProvider("gpt-5", "k");
  withStub(p, reply({ content: "ok" }, { prompt_tokens: 100, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 30 }, prompt_tokens_details: { cached_tokens: 64 } }));
  expect((await p.send("S", [{ role: "user", text: "hi" }], [])).usage).toEqual({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 64, reasoningTokens: 30 });

  const ds = new OpenAIProvider("deepseek-chat", "k", "https://api.deepseek.com");
  withStub(ds, reply({ content: "ok" }, { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 }));
  expect((await ds.send("S", [{ role: "user", text: "hi" }], [])).usage?.cacheReadTokens).toBe(80);
});

test("OpenRouter serving Claude gets cache_control breakpoints; other OpenRouter models don't", async () => {
  const turns: Turn[] = [
    { role: "user", text: "task" },
    { role: "assistant", text: "", toolCalls: [{ id: "c0", name: "read_file", input: {} }] },
    { role: "tool", results: [{ id: "c0", name: "read_file", output: "contents" }] },
  ];
  const claude = new OpenAIProvider("anthropic/claude-sonnet-5", "k", "https://openrouter.ai/api/v1", undefined, undefined, { vendor: "openrouter" });
  const seen = withStub(claude, reply({ content: "ok" }));
  await claude.send("SYS", turns, []);
  const cc = { type: "ephemeral" };
  expect(seen.params.messages[0].content).toEqual([{ type: "text", text: "SYS", cache_control: cc }]);
  expect(seen.params.messages[1].content).toEqual([{ type: "text", text: "task", cache_control: cc }]); // previous call's newest
  expect(seen.params.messages[3].content).toEqual([{ type: "text", text: "contents", cache_control: cc }]); // newest
  expect(seen.params.usage).toEqual({ include: true });

  const llama = new OpenAIProvider("meta-llama/llama-3.3-70b-instruct", "k", "https://openrouter.ai/api/v1", undefined, undefined, { vendor: "openrouter" });
  const seenLlama = withStub(llama, reply({ content: "ok" }));
  await llama.send("SYS", turns, []);
  expect(seenLlama.params.messages[0].content).toBe("SYS");
});

test("thinking=false drops reasoning_effort from the request; true restores it", async () => {
  const p = new OpenAIProvider("o3", "k", undefined, undefined, "high");
  const seen = withStub(p, reply({ content: "ok" }));
  await p.send("S", [{ role: "user", text: "hi" }], []);
  expect(seen.params.reasoning_effort).toBe("high");
  await p.send("S", [{ role: "user", text: "hi" }], [], undefined, undefined, false);
  expect("reasoning_effort" in seen.params).toBe(false);
  await p.send("S", [{ role: "user", text: "hi" }], [], undefined, undefined, true);
  expect(seen.params.reasoning_effort).toBe("high");
});

test("reasoning_content comes back on raw and is replayed on the next request (DeepSeek / Kimi)", async () => {
  const p = new OpenAIProvider("deepseek-reasoner", "k", "https://api.deepseek.com", undefined, undefined, { vendor: "deepseek" });
  const seen = withStub(p, reply({ content: null, reasoning_content: "check a.ts first", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] }));
  const out = await p.send("s", [{ role: "user", text: "fix it" }], []);
  expect(out.raw).toEqual({ openaiReasoning: { vendor: "deepseek", content: "check a.ts first" } });

  await p.send("s", [
    { role: "user", text: "fix it" },
    { role: "assistant", text: "", toolCalls: out.toolCalls, raw: out.raw },
    { role: "tool", results: [{ id: "c1", name: "read_file", output: "x" }] },
  ], []);
  expect(seen.params.messages[2].reasoning_content).toBe("check a.ts first");
});

test("reasoning captured from one vendor is never replayed to another", async () => {
  const p = new OpenAIProvider("m", "k", "https://x", undefined, undefined, { vendor: "groq" });
  const seen = withStub(p, reply({ content: "ok" }));
  await p.send("s", [
    { role: "user", text: "go" },
    { role: "assistant", text: "a", toolCalls: [], raw: { openaiReasoning: { vendor: "deepseek", content: "secret" } } },
    { role: "user", text: "next" },
  ], []);
  expect(seen.params.messages[2].reasoning_content).toBeUndefined();
  // Anthropic-shaped raw (an array of blocks) is ignored too.
  await p.send("s", [{ role: "user", text: "go" }, { role: "assistant", text: "a", toolCalls: [], raw: [{ type: "thinking" }] }], []);
  expect(seen.params.messages[2].reasoning_content).toBeUndefined();
});

test("a harness note after tool results rides on the tool message when reasoning is live, so it is not a new user turn", async () => {
  const p = new OpenAIProvider("deepseek-reasoner", "k", "https://api.deepseek.com", undefined, undefined, { vendor: "deepseek" });
  const seen = withStub(p, reply({ content: "ok" }));
  const call = [{ id: "c1", name: "shell", input: { command: "bun test" } }];
  await p.send("s", [
    { role: "user", text: "fix it" },
    { role: "assistant", text: "", toolCalls: call, raw: { openaiReasoning: { vendor: "deepseek", content: "r" } } },
    { role: "tool", results: [{ id: "c1", name: "shell", output: "1 fail" }] },
    { role: "user", text: "Verification failed" },
  ], []);
  const msgs = seen.params.messages;
  expect(msgs).toHaveLength(4); // system, user, assistant, tool — no trailing user message
  expect(msgs[3].role).toBe("tool");
  expect(msgs[3].content).toContain("1 fail");
  expect(msgs[3].content).toContain("Verification failed");

  // Without reasoning in play nothing changes: the note stays its own user message.
  await p.send("s", [
    { role: "user", text: "fix it" },
    { role: "assistant", text: "", toolCalls: call },
    { role: "tool", results: [{ id: "c1", name: "shell", output: "1 fail" }] },
    { role: "user", text: "Verification failed" },
  ], []);
  expect(seen.params.messages.at(-1)).toEqual({ role: "user", content: "Verification failed" });
});

test("streamed reasoning (OpenRouter `reasoning` + fragmented reasoning_details) is accumulated", async () => {
  const p = new OpenAIProvider("anthropic/claude-x", "k", "https://openrouter.ai/api/v1", undefined, undefined, { vendor: "openrouter" });
  const chunks = [
    { choices: [{ delta: { reasoning: "think ", reasoning_details: [{ type: "reasoning.text", index: 0, text: "think " }] } }] },
    { choices: [{ delta: { reasoning: "more", reasoning_details: [{ type: "reasoning.text", index: 0, text: "more", signature: "sig" }] } }] },
    { choices: [{ delta: { content: "done" } }] },
  ];
  (p as unknown as { client: unknown }).client = {
    chat: { completions: { create: async () => ({ async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } }) } },
  };
  const out = await p.send("s", [{ role: "user", text: "x" }], [], () => {});
  expect(out.text).toBe("done");
  expect(out.raw).toEqual({
    openaiReasoning: { vendor: "openrouter", content: "think more", details: [{ type: "reasoning.text", index: 0, text: "think more", signature: "sig" }] },
  });
});

test("'off' asks later GPT-5.x and GPT-6 for 'low', which every reasoning model accepts", () => {
  expect(reasoningEffort("off", "openai", "gpt-5.6-terra")).toEqual({ reasoning_effort: "low" });
  expect(reasoningEffort("off", "openai", "gpt-6.1-sol")).toEqual({ reasoning_effort: "low" });
});

test("a reply stopped at the length limit is flagged truncated", async () => {
  const p = new OpenAIProvider("gpt-4o", "k");
  withStub(p, { choices: [{ message: { content: "half" }, finish_reason: "length" }] });
  expect((await p.send("S", [{ role: "user", text: "hi" }], [])).truncated).toBe(true);
});

test("inline <think> is kept out of the answer; a bare </think> only for runtimes on this Mac", async () => {
  const p = new OpenAIProvider("qwen", "k", undefined, undefined, undefined, { vendor: "ollama" });
  withStub(p, reply({ content: "<think>plan it</think>\n\nThe answer." }));
  expect((await p.send("s", [{ role: "user", text: "go" }], [])).text).toBe("The answer.");
  withStub(p, reply({ content: "reasoning that the template opened</think>Done." }));
  expect((await p.send("s", [{ role: "user", text: "go" }], [])).text).toBe("Done.");
  const hosted = new OpenAIProvider("x", "k", undefined, undefined, undefined, { vendor: "groq" });
  withStub(hosted, reply({ content: "close tags look like `</think>` in XML" }));
  expect((await hosted.send("s", [{ role: "user", text: "go" }], [])).text).toBe("close tags look like `</think>` in XML");
});

test("a streamed reply's inline thinking never reaches the live deltas", async () => {
  const p = new OpenAIProvider("qwen", "k", undefined, undefined, undefined, { vendor: "local" });
  const chunks = ["<thi", "nk>hmm", " let me see</think>", "Hel", "lo"].map((c) => ({ choices: [{ delta: { content: c } }] }));
  chunks.push({ choices: [], timings: { prompt_n: 30, predicted_n: 5, cache_n: 70 } } as never);
  (p as unknown as { client: unknown }).client = {
    chat: { completions: { create: async () => (async function* () { yield* chunks; })() } },
  };
  const deltas: string[] = [];
  const out = await p.send("s", [{ role: "user", text: "go" }], [], (d) => deltas.push(d));
  expect(deltas.join("")).toBe("Hello");
  expect(out.text).toBe("Hello");
  // llama-server's timings stand in for usage: the cached prefix counts as prompt.
  expect(out.usage).toMatchObject({ inputTokens: 100, outputTokens: 5, cacheReadTokens: 70 });
});
