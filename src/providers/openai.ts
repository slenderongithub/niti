import OpenAI from "openai";
import type { Provider, Turn, ToolSpec, ToolCall, ProviderReply, OnDelta, RateLimit, Reasoning } from "./provider.ts";
import { parseRateLimit, cacheBreakpoints } from "./provider.ts";

function parseArgs(s: string | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

export interface OpenAIOptions {
  vendor?: string; // catalog key ("openai", "openrouter", "deepseek", …) — picks the per-vendor dialect
  cacheKey?: string; // OpenAI prompt_cache_key: requests sharing it are routed to the same prefix cache
  maxOutput?: number;
}

export class OpenAIProvider implements Provider {
  private client: OpenAI;
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
    const trackedFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetch(url, init);
      this.lastRateLimit = parseRateLimit(res.headers, "openai");
      return res;
    };
    this.client = new OpenAI({
      ...(apiKey ? { apiKey } : {}),
      ...(baseURL ? { baseURL } : {}),
      ...(headers ? { defaultHeaders: headers } : {}),
      fetch: trackedFetch,
    });
  }

  private thinking = true;

  setThinking(on: boolean): void {
    this.thinking = on;
  }

  async send(sysPrompt: string, turns: Turn[], tools: ToolSpec[], onDelta?: OnDelta): Promise<ProviderReply> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: sysPrompt },
    ];
    for (const t of turns) {
      if (t.role === "user") {
        messages.push({ role: "user", content: t.text });
      } else if (t.role === "assistant") {
        messages.push({
          role: "assistant",
          content: t.text || null,
          ...(t.toolCalls.length
            ? {
                tool_calls: t.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function" as const,
                  function: { name: c.name, arguments: JSON.stringify(c.input) },
                })),
              }
            : {}),
        });
      } else {
        for (const r of t.results) {
          messages.push({ role: "tool", tool_call_id: r.id, content: r.output });
        }
      }
    }

    const { vendor, cacheKey, maxOutput } = this.opts;
    // OpenRouter forwards Anthropic's cache_control to Claude models, which cache nothing without it
    // (OpenAI and DeepSeek cache automatically; Claude does not). Same breakpoints as anthropic.ts.
    const openrouterClaude = vendor === "openrouter" && this.model.startsWith("anthropic/");
    const sent = openrouterClaude ? [markOpenAI(messages[0]!), ...cacheBreakpoints(messages.slice(1), markOpenAI)] : messages;

    const params = {
      model: this.model,
      messages: sent,
      ...reasoningEffort(this.thinking ? this.reasoning : undefined, vendor, this.model),
      ...(vendor === "openai" && cacheKey ? { prompt_cache_key: cacheKey } : {}),
      ...(maxOutput ? (vendor === "openai" ? { max_completion_tokens: maxOutput } : { max_tokens: maxOutput }) : {}),
      // OpenRouter reports cached and reasoning tokens (and the real cost) only when asked.
      ...(vendor === "openrouter" ? { usage: { include: true } } : {}),
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
      const res = await this.client.chat.completions.create(params);
      const msg = res.choices[0]?.message;
      const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).flatMap((tc) =>
        tc.type === "function" ? [{ id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) }] : [],
      );
      return { text: msg?.content ?? "", toolCalls, usage: mapUsage(res.usage), rateLimit: this.lastRateLimit };
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
    });
    let text = "";
    let usage: ReturnType<typeof mapUsage>;
    const acc: Record<number, { id?: string; name?: string; args: string }> = {};
    for await (const chunk of stream) {
      if (chunk.usage) usage = mapUsage(chunk.usage);
      const d = chunk.choices[0]?.delta;
      if (d?.content) {
        text += d.content;
        onDelta(d.content);
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
      .map((a) => ({ id: a.id ?? a.name!, name: a.name!, input: parseArgs(a.args) }));
    return { text, toolCalls, usage, rateLimit: this.lastRateLimit };
  }
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

export function mapUsage(
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
  const level = r === "off" ? (vendor === "openai" && /gpt-5/.test(model) ? "minimal" : "low") : r;
  if (vendor === "openrouter") return { reasoning: { effort: level } };
  return { reasoning_effort: level };
}
