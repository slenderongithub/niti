import OpenAI from "openai";
import type { Provider, Turn, ToolSpec, ToolCall, ProviderReply, OnDelta, RateLimit, Reasoning } from "./provider.ts";
import { parseRateLimit } from "./provider.ts";

function parseArgs(s: string | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
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

    const params = {
      model: this.model,
      messages,
      ...reasoningEffort(this.thinking ? this.reasoning : undefined),
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

function mapUsage(
  u: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined,
) {
  if (!u) return undefined;
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    // OpenAI auto-caches identical prompt prefixes with zero code required on our side — this only
    // surfaces the savings that already exist, it doesn't create them. No write-side count exists
    // to report (there's no separate "cache write" action, unlike Anthropic's explicit markers).
    cacheReadTokens: u.prompt_tokens_details?.cached_tokens ?? undefined,
  };
}

// o-series and GPT-5 models take reasoning_effort; everything else 400s on it. Sent only when the
// user opted in, for the same reason as Gemini's thinkingConfig — this catalog covers 29 providers
// and most of their models have no reasoning mode to configure.
export function reasoningEffort(r?: Reasoning): Record<string, unknown> {
  if (!r || r === "auto") return {}; // auto = whatever the model does on its own
  return { reasoning_effort: r === "off" ? "minimal" : r };
}
