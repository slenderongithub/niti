// The provider a local agent talks to: the OpenAI-compatible client, pointed at the llama-server the
// runtime starts for this model on first use. What makes a local call different from a hosted one
// rides along on every request — the model's own sampling settings, the agent's slot (so its prompt
// prefix stays cached), the thinking switch, and an output cap so a looping model can't fill the
// whole context with one reply.
import type { OnDelta, Provider, ProviderReply, Reasoning, ToolSpec, Turn } from "../providers/provider.ts";
import { OpenAIProvider } from "../providers/openai.ts";
import { localRuntime, type LocalRuntime } from "./runtime.ts";
import type { InstalledModel, Sampling } from "./store.ts";

// When the model's authors published nothing: what the Qwen, Gemma and Llama cards converge on for
// agentic work. Never greedy — at temperature 0 small models fall into repeating themselves.
export const DEFAULT_SAMPLING: Sampling = { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 };

export const LOCAL_MAX_OUTPUT = 8192;

export function requestExtras(m: InstalledModel, slot: number, thinking: boolean): Record<string, unknown> {
  const s = { ...DEFAULT_SAMPLING, ...m.sampling };
  return {
    ...s,
    id_slot: slot,
    cache_prompt: true,
    // Only for templates that have the switch; others ignore it, but there is no reason to send it.
    ...(m.thinking ? { chat_template_kwargs: { enable_thinking: thinking } } : {}),
  };
}

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

  async send(sysPrompt: string, turns: Turn[], tools: ToolSpec[], onDelta?: OnDelta, signal?: AbortSignal, thinking = true, format?: "json"): Promise<ProviderReply> {
    const { baseURL, apiKey, slot, manifest } = await this.runtime.ensure(this.model, this.agentId);
    // A JSON reply is constrained by grammar from its first token, which leaves no room for a
    // thinking block in front of it.
    const think = thinking && this.reasoning !== "off" && format !== "json";
    const extras = { ...requestExtras(manifest, slot, think), ...(format === "json" ? { response_format: { type: "json_object" } } : {}) };
    if (!this.inner || this.inner.url !== baseURL || this.inner.slot !== slot || this.inner.key !== apiKey) {
      this.inner = {
        url: baseURL,
        slot,
        key: apiKey,
        provider: new OpenAIProvider(this.model, apiKey, baseURL, undefined, undefined, {
          vendor: "local",
          maxOutput: this.maxOutput ?? LOCAL_MAX_OUTPUT,
        }),
      };
    }
    this.inner.provider.extraBody = extras;
    this.runtime.begin(this.model);
    try {
      return await this.inner.provider.send(sysPrompt, turns, tools, onDelta, signal, think);
    } finally {
      this.runtime.end(this.model);
    }
  }
}
