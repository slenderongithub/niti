import Anthropic from "@anthropic-ai/sdk";
import type { Provider, Turn, ToolSpec, ToolCall, ProviderReply, OnDelta, RateLimit } from "./provider.ts";
import { parseRateLimit } from "./provider.ts";

const EPHEMERAL: Anthropic.CacheControlEphemeral = { type: "ephemeral" };

// Marks the LAST content block of a message as a cache breakpoint. Anthropic caches everything up
// to and including a marked block, so marking the second-to-newest message caches the whole
// growing conversation prefix — the newest one or two turns are the only "fresh" tokens each call.
// Thinking/redacted-thinking blocks can't carry cache_control at all — when a replayed assistant
// turn (Turn.raw) ends in one, this just skips marking that particular message; the next call
// still gets a fresh chance once a cacheable block is at the end.
function withCacheControl(m: Anthropic.MessageParam): Anthropic.MessageParam {
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

    // Prompt caching: same caution as `thinking` above — cache_control is part of the wire format,
    // not guaranteed to be understood by every Anthropic-*format* third party, so it's scoped to
    // native Anthropic. Two breakpoints: the system+tools block (below), and the second-to-newest
    // message here, which caches the whole growing conversation prefix behind it.
    if (this.native && messages.length >= 2) {
      messages[messages.length - 2] = withCacheControl(messages[messages.length - 2]!);
    }

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: this.maxOutput,
      // safe now: assistant turns replay native blocks (Turn.raw) — but only Anthropic defines it
      ...(this.native ? { thinking: { type: "adaptive" as const } } : {}),
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
