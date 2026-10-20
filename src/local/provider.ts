// The provider a local agent talks to: the OpenAI-compatible client, pointed at the llama-server the
// runtime starts for this model on first use. What makes a local call different from a hosted one
// rides along on every request — the model's own sampling settings, the agent's slot (so its prompt
// prefix stays cached), the thinking switch, and an output cap so a looping model can't fill the
// whole context with one reply.
import type { OnDelta, Provider, ProviderReply, Reasoning, ToolSpec, Turn } from "../providers/provider.ts";
import { OpenAIProvider } from "../providers/openai.ts";
import { localRuntime, type LocalRuntime } from "./runtime.ts";
import { formatOf, getInstalled, type InstalledModel, type Sampling } from "./store.ts";
import { ensureProbed, PROBE_VERSION } from "./probe.ts";
import { extractTextToolCalls } from "../agent/toolcalls.ts";

// When the model's authors published nothing: what the Qwen, Gemma and Llama cards converge on for
// agentic work. Never greedy — at temperature 0 small models fall into repeating themselves.
export const DEFAULT_SAMPLING: Sampling = { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 };

export const LOCAL_MAX_OUTPUT = 8192;

export function requestExtras(m: InstalledModel, slot: number, thinking: boolean): Record<string, unknown> {
  const s = { ...DEFAULT_SAMPLING, ...m.sampling };
  // The MLX server calls it repetition_penalty, takes no slot, and caches prefixes on its own.
  if (formatOf(m) === "mlx") {
    const { repeat_penalty, ...rest } = s;
    return { ...rest, ...(repeat_penalty ? { repetition_penalty: repeat_penalty } : {}), ...(m.thinking ? { chat_template_kwargs: { enable_thinking: thinking } } : {}) };
  }
  return {
    ...s,
    id_slot: slot,
    cache_prompt: true,
    // Only for templates that have the switch; others ignore it, but there is no reason to send it.
    ...(m.thinking ? { chat_template_kwargs: { enable_thinking: thinking } } : {}),
  };
}

// What one turn needs beyond the conversation — set by the local agent protocol (agent.ts) and the
// model check (probe.ts) just before a send, used once:
//   toolChoice "required": llama.cpp grammar-forces a tool call (no prose turn is possible);
//   prefill: the reply starts with this text already written (the MLX server continues a final
//     assistant message) — a model that drifts into prose is put at the start of its own call format;
//   stop: extra stop sequences; thinking: override the thinking switch for this turn.
export interface TurnOptions {
  toolChoice?: "required" | "auto";
  prefill?: string;
  stop?: string[];
  thinking?: boolean;
  temperature?: number;
  maxTokens?: number;
}

// Chat-template tokens a model sometimes writes past its end of turn. They are never content.
export const TEMPLATE_TOKENS = ["<|im_start|>", "<|im_end|>", "<|endoftext|>", "<|eot_id|>", "<|start_header_id|>", "<|end_header_id|>", "<end_of_turn>", "<start_of_turn>", "<|end|>", "<|user|>", "<|assistant|>"];
export const stripTemplateTokens = (t: string): string => TEMPLATE_TOKENS.reduce((s, tok) => s.split(tok).join(""), t).replace(/\n{3,}/g, "\n\n");

// A reply niti started for the model, put back together. An engine that continues the started
// message returns the rest of it; one that doesn't (the MLX server, for some templates) starts a
// fresh reply — often the whole call again — and gluing the opener on front breaks it. Whichever
// reads as a tool call wins; failing both, the joined text.
export function joinPrefill(prefill: string, rest: string, toolNames: string[]): string {
  const joined = prefill + rest;
  if (extractTextToolCalls(joined, toolNames)) return joined;
  if (extractTextToolCalls(rest, toolNames)) return rest;
  return joined;
}

export const engineDied = (err: unknown): boolean => /generation thread died|ECONNREFUSED|ECONNRESET|socket hang up|Connection error|fetch failed/i.test(err instanceof Error ? err.message : String(err));

export class LocalProvider implements Provider {
  private inner?: { url: string; slot: number; key: string; provider: OpenAIProvider };
  // The next send's TurnOptions (see above). Consumed by that send.
  next?: TurnOptions;

  constructor(
    private model: string,
    private agentId: string,
    private reasoning?: Reasoning,
    private maxOutput?: number,
    private runtime: LocalRuntime = localRuntime(),
  ) {
    runtime.register(agentId, model);
  }

  // The one-time model check, if this model hasn't had it (see send).
  async check(): Promise<void> {
    const m = getInstalled(this.model);
    if (m && (!m.probe || m.probe.version !== PROBE_VERSION)) await ensureProbed(m, { runtime: this.runtime });
  }

  async send(sysPrompt: string, turns: Turn[], tools: ToolSpec[], onDelta?: OnDelta, signal?: AbortSignal, thinking = true, format?: "json", retried = false): Promise<ProviderReply> {
    // A model's first agent request waits for its one-time check (probe.ts), so niti knows how to
    // drive it before it is given work. The check's own requests skip this.
    if (!this.agentId.startsWith("probe:")) await this.check();
    const { baseURL, apiKey, slot, manifest } = await this.runtime.ensure(this.model, this.agentId);
    const turn = this.next ?? {};
    this.next = undefined;
    // A JSON reply is constrained by grammar from its first token, which leaves no room for a
    // thinking block in front of it.
    const think = (turn.thinking ?? thinking) && this.reasoning !== "off" && format !== "json";
    const mlx = formatOf(manifest) === "mlx";
    // llama-server constrains JSON by grammar; the MLX server has no such option, and niti's callers
    // validate and retry what comes back either way.
    // Plans, verdicts and summaries are JSON a program parses: sampled cool, so a small model's
    // plan comes out the same shape every time (the MLX engine has no grammar to hold it to JSON).
    const stop = [...new Set([...TEMPLATE_TOKENS.filter((t) => t !== "<|end|>"), ...(manifest.probe?.stops ?? []), ...(turn.stop ?? [])])];
    const extras = {
      ...requestExtras(manifest, slot, think),
      ...(format === "json" ? { temperature: 0.2 } : {}),
      ...(turn.temperature !== undefined ? { temperature: turn.temperature } : {}),
      ...(turn.maxTokens ? { max_tokens: turn.maxTokens } : {}),
      ...(format === "json" && !mlx ? { response_format: { type: "json_object" } } : {}),
      // Grammar-forced tool calling exists only in llama.cpp; the MLX side uses `prefill` instead.
      ...(turn.toolChoice && tools.length && !mlx ? { tool_choice: turn.toolChoice } : {}),
      stop: stop.slice(0, 16), // OpenAI-style servers cap the list; llama.cpp and MLX accept more
    };
    // A prefilled reply: the conversation ends with the start of the assistant's answer, and the
    // engine writes the rest. The caller gets the whole reply, prefill included.
    const sent: Turn[] = turn.prefill ? [...turns, { role: "assistant", text: turn.prefill, toolCalls: [] }] : turns;
    if (!this.inner || this.inner.url !== baseURL || this.inner.slot !== slot || this.inner.key !== apiKey) {
      this.inner = {
        url: baseURL,
        slot,
        key: apiKey,
        // The MLX server loads whatever `model` names; niti's wrapper pins it, and "default_model" is
        // the name it serves the started model under.
        provider: new OpenAIProvider(mlx ? "default_model" : this.model, apiKey, baseURL, undefined, undefined, {
          vendor: "local",
          maxOutput: this.maxOutput ?? LOCAL_MAX_OUTPUT,
          ...(mlx ? { streamUsage: true } : {}),
        }),
      };
    }
    this.inner.provider.extraBody = extras;
    this.runtime.begin(this.model);
    try {
      const reply = await this.inner.provider.send(sysPrompt, sent, tools, onDelta, signal, think);
      return { ...reply, text: stripTemplateTokens(turn.prefill ? joinPrefill(turn.prefill, reply.text, tools.map((t) => t.name)) : reply.text) };
    } catch (err) {
      // An engine that died under the request (the MLX server's generation thread, a crashed
      // llama-server) answers every later request with the same error. Restart it and try once more.
      if (signal?.aborted || retried || !engineDied(err)) throw err;
      this.runtime.end(this.model);
      this.runtime.stop(this.model);
      this.inner = undefined;
      this.next = turn;
      return this.send(sysPrompt, turns, tools, onDelta, signal, thinking, format, true);
    } finally {
      this.runtime.end(this.model);
    }
  }
}
