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

test("malformed tool arguments degrade to an empty input instead of throwing", async () => {
  // A model emitting truncated JSON must not take the whole agent loop down with it.
  const p = new OpenAIProvider("gpt-4o", "k");
  withStub(p, reply({ content: null, tool_calls: [{ id: "c", type: "function", function: { name: "shell", arguments: '{"command":' } }] }));
  const out = await p.send("s", [{ role: "user", text: "go" }], []);
  expect(out.toolCalls).toEqual([{ id: "c", name: "shell", input: {} }]);
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

test("setThinking(false) drops reasoning_effort from the request; true restores it", async () => {
  const p = new OpenAIProvider("o3", "k", undefined, undefined, "high");
  const seen = withStub(p, reply({ content: "ok" }));
  await p.send("S", [{ role: "user", text: "hi" }], []);
  expect(seen.params.reasoning_effort).toBe("high");
  p.setThinking(false);
  await p.send("S", [{ role: "user", text: "hi" }], []);
  expect("reasoning_effort" in seen.params).toBe(false);
  p.setThinking(true);
  await p.send("S", [{ role: "user", text: "hi" }], []);
  expect(seen.params.reasoning_effort).toBe("high");
});
