import Anthropic from "@anthropic-ai/sdk";
import type { Provider, Turn, ToolSpec, ToolCall, ProviderReply, OnDelta, RateLimit, Reasoning } from "./provider.ts";
import { parseRateLimit, cacheBreakpoints } from "./provider.ts";

const EPHEMERAL: Anthropic.CacheControlEphemeral = { type: "ephemeral" };

// Marks the LAST content block of a message as a cache breakpoint. Anthropic caches everything up
// to and including a marked block. Thinking/redacted-thinking blocks can't carry cache_control at
// all — when a replayed assistant turn (Turn.raw) ends in one, this just skips that message.
export function withCacheControl(m: Anthropic.MessageParam): Anthropic.MessageParam {
  if (typeof m.content === "string") {
    return { ...m, content: [{ type: "text", text: m.content, cache_control: EPHEMERAL }] };
  }
  if (!m.content.length) return m;
  const last = m.content[m.content.length - 1]!;
  if (last.type === "thinking" || last.type === "redacted_thinking") return m;
  const content = [...m.content];
  content[content.length - 1] = { ...last, cache_control: EPHEMERAL };
  return { ...m, content };
}

// Pre-4.6 models (Haiku 4.5, Sonnet/Opus 4.5 and older) take neither adaptive thinking nor
// `effort` — both 400. Everything newer takes both.
const LEGACY_MODEL = /haiku|claude-3|-4-5|-4-1\b|-4-0|-4-2025/;

// niti's portable reasoning level → Anthropic's `effort`. "off" becomes the lowest effort rather
// than `thinking: {type: "disabled"}`, which Opus 5.5 rejects at every effort and Opus 5 above high.
const EFFORT: Record<Reasoning, "low" | "medium" | "high" | undefined> = {
  off: "low",
  low: "low",
  medium: "medium",
  high: "high",
  auto: undefined,
};

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
  private thinking = true; // the user's thinking-mode switch (RuntimeSettings.thinkingMode)

  constructor(
    private model: string,
    apiKey?: string,
    baseURL?: string, // set for Anthropic-format providers other than Anthropic itself
    private maxOutput = 16000,
    private reasoning?: Reasoning,
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

  setThinking(on: boolean): void {
    this.thinking = on;
  }

  // Thinking + effort, only where the model takes them (see LEGACY_MODEL). Thinking off drops the
  // thinking block and asks for the lowest effort; on Opus 5+ that's the documented way to spend
  // less on reasoning, since those models think adaptively whether or not the param is sent.
  private reasoningParams(): Pick<Anthropic.MessageCreateParamsNonStreaming, "thinking" | "output_config"> {
    if (!this.native || LEGACY_MODEL.test(this.model)) return {};
    const effort = EFFORT[this.thinking ? (this.reasoning ?? "auto") : "off"];
    return {
      ...(this.thinking && this.reasoning !== "off" ? { thinking: { type: "adaptive" as const } } : {}),
      ...(effort ? { output_config: { effort } } : {}),
    };
  }

  async send(sysPrompt: string, turns: Turn[], tools: ToolSpec[], onDelta?: OnDelta, signal?: AbortSignal): Promise<ProviderReply> {
    let messages: Anthropic.MessageParam[] = turns.map((t) => {
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

    // Prompt caching: same caution as `thinking` — cache_control is part of the wire format, not
    // guaranteed to be understood by every Anthropic-*format* third party, so it's scoped to native
    // Anthropic. Three breakpoints of the four allowed: the system+tools block (below) and the two
    // conversation ones chosen by cacheBreakpoints.
    if (this.native) messages = cacheBreakpoints(messages, withCacheControl);

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: this.maxOutput,
      // safe: assistant turns replay native blocks (Turn.raw) — but only Anthropic defines these
      ...this.reasoningParams(),
      // Rendered before `messages` in Anthropic's cache lookup order (tools → system → messages),
      // so this one breakpoint also covers the tools block below it, as long as `tools` is
      // byte-identical call to call — see agent.ts's buildTools() memoization.
      system: this.native ? [{ type: "text", text: sysPrompt, cache_control: EPHEMERAL }] : sysPrompt,
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
          const stream = this.client.messages.stream(params, { signal });
          stream.on("text", (delta) => onDelta(delta));
          return stream.finalMessage();
        })()
      : await this.client.messages.create(params, { signal });

    return {
      ...blocksToReply(msg.content),
      // Optional. Anthropic itself always sends usage, but the Anthropic-*format* third parties
      // this class also serves are under no obligation to, and an unguarded read threw a
      // TypeError from inside the provider — surfacing as a failed task, not a missing metric.
      usage: msg.usage
        ? {
            inputTokens: msg.usage.input_tokens ?? 0,
            outputTokens: msg.usage.output_tokens ?? 0,
            cacheReadTokens: msg.usage.cache_read_input_tokens ?? undefined,
            cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? undefined,
          }
        : undefined,
      rateLimit: this.lastRateLimit,
    };
  }
}
