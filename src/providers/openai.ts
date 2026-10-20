import OpenAI from "openai";
import type { Provider, Turn, ToolSpec, ToolCall, ProviderReply, OnDelta, RateLimit, Reasoning } from "./provider.ts";
import { rateLimitFetch, cacheBreakpoints } from "./provider.ts";
import { parseToolArgs, splitThinking } from "../agent/toolcalls.ts";

// Runtimes on this Mac, whose output gets the extra inline-thinking handling (see splitThinking).
const LOCAL_VENDORS = new Set(["local", "ollama", "lmstudio"]);

function toCall(id: string, name: string, args: string | undefined): ToolCall {
  const { input, error } = parseToolArgs(args);
  return { id, name, input, ...(error ? { parseError: error } : {}) };
}

// What an OpenAI-compatible reasoning model returned alongside its answer, kept on the assistant
// turn's `raw` and replayed on the next request. Chat Completions has no field for it, so most
// clients drop it — and the models built on interleaved thinking get measurably worse when they
// do (MiniMax's ablation: BrowseComp 44.0 → 31.4, τ²-bench 87 → 64), or 400 outright (DeepSeek
// thinking mode with tools, Kimi K2 thinking). Tagged with the vendor so a history replayed to a
// different endpoint never carries a field that endpoint has never seen.
interface OpenAIRaw {
  openaiReasoning: { vendor: string; content?: string; details?: unknown[] };
}

function reasoningOf(raw: unknown, vendor: string): OpenAIRaw["openaiReasoning"] | undefined {
  const r = (raw as Partial<OpenAIRaw> | undefined)?.openaiReasoning;
  return r && r.vendor === vendor ? r : undefined;
}

// The vendors' field names differ: DeepSeek, Kimi, GLM and Qwen use `reasoning_content`; OpenRouter
// sends a plain `reasoning` string plus structured `reasoning_details` (which carry the encrypted /
// signed blocks Claude and Gemini need back); MiniMax uses `reasoning_details` alone.
function captureReasoning(vendor: string, content: string, details: unknown[]): OpenAIRaw | undefined {
  if (!content && details.length === 0) return undefined;
  return { openaiReasoning: { vendor, ...(content ? { content } : {}), ...(details.length ? { details } : {}) } };
}

// Streamed reasoning_details arrive as fragments sharing an `index`; concatenate their text fields.
function mergeDetails(into: Record<string, unknown>[], fragments: unknown): void {
  for (const f of Array.isArray(fragments) ? (fragments as Record<string, unknown>[]) : []) {
    const prev = typeof f.index === "number" ? into.find((d) => d.index === f.index && d.type === f.type) : undefined;
    if (!prev) {
      into.push({ ...f });
      continue;
    }
    for (const k of ["text", "summary", "data"] as const) {
      if (typeof f[k] === "string") prev[k] = ((prev[k] as string | undefined) ?? "") + f[k];
    }
    if (f.signature) prev.signature = f.signature;
  }
}

// DeepSeek's rule (V3.2 report): reasoning is kept across tool calls and discarded only when a new
// *user* message arrives. niti speaks to the model mid-task as the user — verification failures,
// stall nudges, the inbox, the notes board, the todo checklist — so on this wire each of those
// would wipe the reasoning the replay above just preserved. When the assistant turn before them
// carried reasoning, those notes ride on the last tool message instead. Anthropic needs none of
// this: it merges consecutive user messages into the tool-result turn already.
const HARNESS_NOTE = "\n\n[niti — note from the harness, not part of the tool output]\n";

interface OpenAIOptions {
  vendor?: string; // catalog key ("openai", "openrouter", "deepseek", …) — picks the per-vendor dialect
  cacheKey?: string; // OpenAI prompt_cache_key: requests sharing it are routed to the same prefix cache
  maxOutput?: number;
}

export class OpenAIProvider implements Provider {
  private client: OpenAI;
  // Extra request fields for runtimes with their own knobs (llama-server: sampling, id_slot,
  // chat_template_kwargs). Set by the caller per call; sent verbatim.
  extraBody?: Record<string, unknown>;
  private lastRateLimit?: RateLimit; // captured at the fetch layer → works for streaming too

  // Whether to send OpenAI's `stream_options`. True for api.openai.com and for hosted
  // OpenAI-compatible vendors, false for the local runtimes, which are the strict ones about
  // unknown parameters and the ones a user cannot simply switch away from.
  private readonly supportsUsageOption: boolean;

  constructor(
    private model: string,
    apiKey?: string,
    baseURL?: string, // set for OpenAI-compatible providers (DeepSeek, Groq, OpenRouter, Ollama, …)
    headers?: Record<string, string>, // extra default headers (e.g. Copilot's editor headers)
    private reasoning?: Reasoning,
    private opts: OpenAIOptions = {},
  ) {
    this.supportsUsageOption = !/localhost|127\.0\.0\.1|\[::1\]/.test(baseURL ?? "");
    this.client = new OpenAI({
      ...(apiKey ? { apiKey } : {}),
      ...(baseURL ? { baseURL } : {}),
      ...(headers ? { defaultHeaders: headers } : {}),
      fetch: rateLimitFetch("openai", (rl) => (this.lastRateLimit = rl)),
    });
  }

  async send(sysPrompt: string, turns: Turn[], tools: ToolSpec[], onDelta?: OnDelta, signal?: AbortSignal, thinking = true): Promise<ProviderReply> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: sysPrompt },
    ];
    const { vendor } = this.opts;
    const tag = vendor ?? "default"; // which endpoint a captured reasoning trace belongs to
    let reasoningLive = false; // the latest assistant turn carried reasoning we replayed
    for (const t of turns) {
      if (t.role === "user") {
        const last = messages[messages.length - 1];
        if (reasoningLive && last?.role === "tool") {
          last.content = `${last.content as string}${HARNESS_NOTE}${t.text}`;
          continue;
        }
        messages.push({ role: "user", content: t.text });
      } else if (t.role === "assistant") {
        const r = reasoningOf(t.raw, tag);
        reasoningLive = !!r;
        messages.push({
          role: "assistant",
          content: t.text || null,
          ...(r?.content ? { reasoning_content: r.content } : {}),
          ...(r?.details ? { reasoning_details: r.details } : {}),
          ...(t.toolCalls.length
            ? {
                tool_calls: t.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function" as const,
                  function: { name: c.name, arguments: JSON.stringify(c.input) },
                })),
              }
            : {}),
        } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam);
      } else {
        for (const r of t.results) {
          messages.push({ role: "tool", tool_call_id: r.id, content: r.output });
        }
      }
    }

    const { cacheKey, maxOutput } = this.opts;
    // OpenRouter forwards Anthropic's cache_control to Claude models, which cache nothing without it
    // (OpenAI and DeepSeek cache automatically; Claude does not). Same breakpoints as anthropic.ts.
    const openrouterClaude = vendor === "openrouter" && this.model.startsWith("anthropic/");
    const sent = openrouterClaude ? [markOpenAI(messages[0]!), ...cacheBreakpoints(messages.slice(1), markOpenAI)] : messages;

    const params = {
      model: this.model,
      messages: sent,
      ...reasoningEffort(thinking ? this.reasoning : undefined, vendor, this.model),
      ...(vendor === "openai" && cacheKey ? { prompt_cache_key: cacheKey } : {}),
      ...(maxOutput ? (vendor === "openai" ? { max_completion_tokens: maxOutput } : { max_tokens: maxOutput }) : {}),
      // OpenRouter reports cached and reasoning tokens (and the real cost) only when asked.
      ...(vendor === "openrouter" ? { usage: { include: true } } : {}),
      ...this.extraBody,
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              type: "function" as const,
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    };

    if (!onDelta) {
      const res = await this.client.chat.completions.create(params, { signal });
      const msg = res.choices[0]?.message as (OpenAI.Chat.Completions.ChatCompletionMessage & ReasoningFields) | undefined;
      const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).flatMap((tc) => (tc.type === "function" ? [toCall(tc.id, tc.function.name, tc.function.arguments)] : []));
      // Inline thinking is dropped, not replayed as reasoning_content: a runtime that put it in the
      // content has no such field, and chat templates strip earlier turns' thinking anyway.
      const { answer } = splitThinking(msg?.content ?? "", LOCAL_VENDORS.has(tag));
      const raw = captureReasoning(tag, msg?.reasoning_content ?? msg?.reasoning ?? "", Array.isArray(msg?.reasoning_details) ? msg.reasoning_details : []);
      const truncated = res.choices[0]?.finish_reason === "length";
      return { text: answer, toolCalls, usage: mapUsage(res.usage), rateLimit: this.lastRateLimit, truncated, ...(raw ? { raw } : {}) };
    }

    // Streaming: accumulate text (emitted live) and tool-call fragments (arrive by index).
    // include_usage → the final chunk carries token usage.
    const stream = await this.client.chat.completions.create({
      ...params,
      stream: true,
      // An OpenAI extension, not part of the wire format everyone else implements. Strict local
      // runtimes (llama.cpp servers, some vLLM builds) 400 on an unknown parameter, which turned
      // "no token accounting" into "streaming does not work at all" for offline users.
      ...(this.supportsUsageOption ? { stream_options: { include_usage: true } } : {}),
    }, { signal });
    let text = "";
    let shown = 0; // characters of the answer already streamed (thinking excluded)
    let reasoning = "";
    const details: Record<string, unknown>[] = [];
    let usage: ReturnType<typeof mapUsage>;
    let truncated = false;
    const acc: Record<number, { id?: string; name?: string; args: string }> = {};
    for await (const chunk of stream) {
      if (chunk.usage) usage = mapUsage(chunk.usage);
      // llama-server reports its token counts as `timings` on the final chunk, whether or not it
      // honours stream_options — without them compaction would never know how full the window is.
      else if (!usage && (chunk as { timings?: Timings }).timings) usage = usageFromTimings((chunk as { timings?: Timings }).timings!);
      if (chunk.choices[0]?.finish_reason === "length") truncated = true;
      const d = chunk.choices[0]?.delta as (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & ReasoningFields) | undefined;
      reasoning += d?.reasoning_content ?? d?.reasoning ?? "";
      if (d?.reasoning_details) mergeDetails(details, d.reasoning_details);
      if (d?.content) {
        text += d.content;
        // Inline thinking is held back from the live stream: only the answer after it is shown —
        // and so is a start that may still become "<think>" once its next chunk arrives.
        const head = text.trimStart();
        const visible = head.length < 7 && "<think>".startsWith(head) ? "" : splitThinking(text, LOCAL_VENDORS.has(tag)).answer;
        if (visible.length > shown) {
          onDelta(visible.slice(shown));
          shown = visible.length;
        }
      }
      for (const tc of d?.tool_calls ?? []) {
        const a = (acc[tc.index] ??= { args: "" });
        if (tc.id) a.id = tc.id;
        if (tc.function?.name) a.name = tc.function.name;
        if (tc.function?.arguments) a.args += tc.function.arguments;
      }
    }
    const toolCalls: ToolCall[] = Object.values(acc)
      .filter((a) => a.name)
      // A runtime that sends no id: one unique per call, never the bare name — ids are what results,
      // the UI's live blocks and observation masking pair on, across the whole conversation.
      .map((a) => toCall(a.id ?? `${a.name}-${crypto.randomUUID().slice(0, 8)}`, a.name!, a.args));
    const { answer } = splitThinking(text, LOCAL_VENDORS.has(tag));
    const raw = captureReasoning(tag, reasoning, details);
    return { text: answer, toolCalls, usage, rateLimit: this.lastRateLimit, truncated, ...(raw ? { raw } : {}) };
  }
}

// llama.cpp's per-request counters: prompt_n tokens evaluated, cache_n reused from the slot's cache.
interface Timings {
  prompt_n?: number;
  predicted_n?: number;
  cache_n?: number;
}

export function usageFromTimings(t: Timings) {
  return {
    inputTokens: (t.prompt_n ?? 0) + (t.cache_n ?? 0),
    outputTokens: t.predicted_n ?? 0,
    cacheReadTokens: t.cache_n ?? undefined,
    reasoningTokens: undefined,
  };
}

// Non-standard fields OpenAI-compatible vendors add to a message or a stream delta.
interface ReasoningFields {
  reasoning_content?: string | null;
  reasoning?: string | null;
  reasoning_details?: unknown[];
}

// Puts an Anthropic-style cache_control on a Chat Completions message's last text part (see the
// OpenRouter note in send). Assistant turns that are pure tool calls have no text to mark.
function markOpenAI<M>(m: M): M {
  const msg = m as { content?: unknown };
  const cc = { type: "ephemeral" };
  if (typeof msg.content === "string" && msg.content) return { ...msg, content: [{ type: "text", text: msg.content, cache_control: cc }] } as M;
  if (Array.isArray(msg.content) && msg.content.length) {
    const content = [...msg.content];
    content[content.length - 1] = { ...content[content.length - 1], cache_control: cc };
    return { ...msg, content } as M;
  }
  return m;
}

function mapUsage(
  u:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number } | null;
        completion_tokens_details?: { reasoning_tokens?: number } | null;
        prompt_cache_hit_tokens?: number; // DeepSeek's own field; it does not fill prompt_tokens_details
      }
    | undefined,
) {
  if (!u) return undefined;
  return {
    inputTokens: u.prompt_tokens ?? 0,
    // completion_tokens already includes reasoning tokens (billed as output) — reasoningTokens below
    // is a breakdown of it, not an addition.
    outputTokens: u.completion_tokens ?? 0,
    // OpenAI and DeepSeek auto-cache identical prompt prefixes — this only surfaces savings that
    // already exist. No write-side count exists to report (no explicit cache writes, unlike Anthropic).
    cacheReadTokens: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? undefined,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens || undefined,
  };
}

// o-series and GPT-5 models take reasoning_effort; everything else 400s on it. Sent only when the
// user opted in, for the same reason as Gemini's thinkingConfig — this catalog covers 29 providers
// and most of their models have no reasoning mode to configure.
//
// The encoding is per vendor: OpenRouter normalises reasoning under its own `reasoning` object, and
// "minimal" exists only on OpenAI's GPT-5 family — Groq, xAI and the rest reject it, so "off" maps
// to the lowest level every vendor accepts.
export function reasoningEffort(r?: Reasoning, vendor?: string, model = ""): Record<string, unknown> {
  if (!r || r === "auto") return {}; // auto = whatever the model does on its own
  // "minimal" belongs to the original GPT-5 family only; later GPT-5.x and GPT-6 renamed their
  // lowest level, and "low" is the one every reasoning model accepts.
  const level = r === "off" ? (vendor === "openai" && /^gpt-5(-mini|-nano)?$/.test(model) ? "minimal" : "low") : r;
  if (vendor === "openrouter") return { reasoning: { effort: level } };
  return { reasoning_effort: level };
}
