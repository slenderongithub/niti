// The provider a local agent talks to: the OpenAI-compatible client, pointed at the llama-server the
// runtime starts for this model on first use. What makes a local call different from a hosted one
// rides along on every request — the model's own sampling settings, the agent's slot (so its prompt
// prefix stays cached), the thinking switch, and an output cap so a looping model can't fill the
// whole context with one reply.
import type { OnDelta, Provider, ProviderReply, Reasoning, ToolSpec, Turn } from "../providers/provider.ts";
import { OpenAIProvider } from "../providers/openai.ts";
import { localRuntime, type LocalRuntime } from "./runtime.ts";
import { formatOf, type InstalledModel, type Sampling } from "./store.ts";

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

export const engineDied = (err: unknown): boolean => /generation thread died|ECONNREFUSED|ECONNRESET|socket hang up|Connection error|fetch failed/i.test(err instanceof Error ? err.message : String(err));

export class LocalProvider implements Provider {
  private inner?: { url: string; slot: number; key: string; provider: OpenAIProvider };

  constructor(
    private model: string,
    private agentId: string,
    private reasoning?: Reasoning,
    private maxOutput?: number,
    private runtime: LocalRuntime = localRuntime(),
  ) {
    runtime.register(agentId, model);
  }

  async send(sysPrompt: string, turns: Turn[], tools: ToolSpec[], onDelta?: OnDelta, signal?: AbortSignal, thinking = true, format?: "json", retried = false): Promise<ProviderReply> {
    const { baseURL, apiKey, slot, manifest } = await this.runtime.ensure(this.model, this.agentId);
    // A JSON reply is constrained by grammar from its first token, which leaves no room for a
    // thinking block in front of it.
    const think = thinking && this.reasoning !== "off" && format !== "json";
    const mlx = formatOf(manifest) === "mlx";
    // llama-server constrains JSON by grammar; the MLX server has no such option, and niti's callers
    // validate and retry what comes back either way.
    // Plans, verdicts and summaries are JSON a program parses: sampled cool, so a small model's
    // plan comes out the same shape every time (the MLX engine has no grammar to hold it to JSON).
    const extras = { ...requestExtras(manifest, slot, think), ...(format === "json" ? { temperature: 0.2 } : {}), ...(format === "json" && !mlx ? { response_format: { type: "json_object" } } : {}) };
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
      return await this.inner.provider.send(sysPrompt, turns, tools, onDelta, signal, think);
    } catch (err) {
      // An engine that died under the request (the MLX server's generation thread, a crashed
      // llama-server) answers every later request with the same error. Restart it and try once more.
      if (signal?.aborted || retried || !engineDied(err)) throw err;
      this.runtime.end(this.model);
      this.runtime.stop(this.model);
      this.inner = undefined;
      return this.send(sysPrompt, turns, tools, onDelta, signal, thinking, format, true);
    } finally {
      this.runtime.end(this.model);
    }
  }
}
