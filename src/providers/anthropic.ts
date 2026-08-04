import Anthropic from "@anthropic-ai/sdk";
import type { Provider, Turn, ToolSpec, ToolCall, ProviderReply, OnDelta, RateLimit } from "./provider.ts";
import { parseRateLimit } from "./provider.ts";

function blocksToReply(content: Anthropic.ContentBlock[]): ProviderReply {
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const b of content) {
    if (b.type === "text") text += b.text;
    else if (b.type === "tool_use") {
      toolCalls.push({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
    }
  }
  return { text, toolCalls, raw: content }; // raw replayed next turn to preserve thinking blocks
}

export class AnthropicProvider implements Provider {
  private client: Anthropic;
  private lastRateLimit?: RateLimit; // captured at the fetch layer → works for streaming too

  // True only for api.anthropic.com. Anthropic-format third parties (MiniMax's shim, and anything
  // a user points at with a custom baseURL) get the portable subset: `thinking` is Anthropic-
  // proprietary and a strict shim 400s on it, and a fixed 16k max_tokens exceeds the output cap of
  // plenty of non-Anthropic models.
  private readonly native: boolean;

  constructor(
    private model: string,
    apiKey?: string,
    baseURL?: string, // set for Anthropic-format providers other than Anthropic itself
    private maxOutput = 16000,
  ) {
    this.native = !baseURL;
    const trackedFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetch(url, init);
      this.lastRateLimit = parseRateLimit(res.headers, "anthropic");
      return res;
    };
    this.client = new Anthropic({
      ...(apiKey ? { apiKey } : {}),
      ...(baseURL ? { baseURL } : {}),
      fetch: trackedFetch,
    });
  }

  async send(sysPrompt: string, turns: Turn[], tools: ToolSpec[], onDelta?: OnDelta): Promise<ProviderReply> {
    const messages: Anthropic.MessageParam[] = turns.map((t) => {
      if (t.role === "user") return { role: "user", content: t.text };
      if (t.role === "assistant") {
        // Replay native blocks verbatim when we have them — preserves thinking blocks so
        // adaptive thinking + tool use doesn't 400 on the next turn.
        if (t.raw) return { role: "assistant", content: t.raw as Anthropic.ContentBlockParam[] };
        const content: Anthropic.ContentBlockParam[] = [];
        if (t.text) content.push({ type: "text", text: t.text });
        for (const c of t.toolCalls) {
          content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
        }
        return { role: "assistant", content };
      }
      return {
        role: "user",
        content: t.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.id,
          content: r.output,
        })),
      };
    });

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: this.maxOutput,
      // safe now: assistant turns replay native blocks (Turn.raw) — but only Anthropic defines it
      ...(this.native ? { thinking: { type: "adaptive" as const } } : {}),
      system: sysPrompt,
      messages,
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters as Anthropic.Tool["input_schema"],
            })),
          }
        : {}),
    };

    const msg = onDelta
      ? await (() => {
          const stream = this.client.messages.stream(params);
          stream.on("text", (delta) => onDelta(delta));
          return stream.finalMessage();
        })()
      : await this.client.messages.create(params);

    return {
      ...blocksToReply(msg.content),
      // Optional. Anthropic itself always sends usage, but the Anthropic-*format* third parties
      // this class also serves are under no obligation to, and an unguarded read threw a
      // TypeError from inside the provider — surfacing as a failed task, not a missing metric.
      usage: msg.usage ? { inputTokens: msg.usage.input_tokens ?? 0, outputTokens: msg.usage.output_tokens ?? 0 } : undefined,
      rateLimit: this.lastRateLimit,
    };
  }
}
