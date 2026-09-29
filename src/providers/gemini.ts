import { GoogleGenAI } from "@google/genai";
import type { Provider, Turn, ToolSpec, ToolCall, ProviderReply, OnDelta, Reasoning, Usage } from "./provider.ts";

export class GeminiProvider implements Provider {
  private client: GoogleGenAI;

  constructor(
    private model: string,
    apiKey: string, // required — the SDK has no env fallback
    baseURL?: string, // a Gemini-compatible proxy; the factory computes it and used to drop it here
    private reasoning?: Reasoning,
    private maxOutput?: number,
  ) {
    // The @google/genai transport falls back to a bare fetch() — no retries, no timeout — unless
    // httpOptions.retryOptions is set. Anthropic and OpenAI's SDKs both retry twice by default, so
    // a routine Flash 503 was the one blip that threw all the way out to the scheduler and re-ran
    // the entire task from turn zero, re-billing every tool call it had already made.
    this.client = new GoogleGenAI({
      apiKey,
      httpOptions: { timeout: 120_000, retryOptions: { attempts: 3 }, ...(baseURL ? { baseUrl: baseURL } : {}) },
    });
  }

  private thinking = true;

  setThinking(on: boolean): void {
    this.thinking = on;
  }

  async send(sysPrompt: string, turns: Turn[], tools: ToolSpec[], onDelta?: OnDelta, signal?: AbortSignal): Promise<ProviderReply> {
    // Gemini roles are "user"/"model"; tool results are functionResponse parts paired by name.
    const contents = turns.map((t) => {
      if (t.role === "user") return { role: "user", parts: [{ text: t.text }] };
      if (t.role === "assistant") {
        // Replay the native parts verbatim when we have them: newer Gemini models attach a
        // thoughtSignature to each functionCall part and reject the next turn's request if it's
        // missing (400 INVALID_ARGUMENT). Rebuilding functionCall parts from toolCalls (as below)
        // drops that signature, so a fresh reply must always carry raw forward — same pattern as
        // Anthropic's thinking blocks (see anthropic.ts).
        if (t.raw) return { role: "model", parts: t.raw as Record<string, unknown>[] };
        const parts: Record<string, unknown>[] = [];
        if (t.text) parts.push({ text: t.text });
        for (const c of t.toolCalls) parts.push({ functionCall: { name: c.name, args: c.input } });
        return { role: "model", parts };
      }
      return {
        role: "user",
        parts: t.results.map((r) => ({
          functionResponse: { name: r.name, response: { result: r.output } },
        })),
      };
    });

    const params = {
      model: this.model,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      contents: contents as any,
      config: {
        systemInstruction: sysPrompt,
        ...(signal ? { abortSignal: signal } : {}),
        ...thinkingConfig(this.thinking ? this.reasoning : undefined, this.model),
        ...(this.maxOutput ? { maxOutputTokens: this.maxOutput } : {}),
        ...(tools.length
          ? {
              tools: [
                {
                  functionDeclarations: tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    // Gemini's Schema is an OpenAPI subset; our JSON Schema is close enough for these tools.
                    parameters: t.parameters as never,
                  })),
                },
              ],
            }
          : {}),
      },
    };

    let text = "";
    const toolCalls: ToolCall[] = [];
    const rawParts: Record<string, unknown>[] = []; // native parts, verbatim — carries thoughtSignature
    let usage: Usage | undefined;
    let n = 0;
    // Gemini caches long prompt prefixes implicitly — no request parameter, nothing to opt into —
    // but it only *reports* the hit in cachedContentTokenCount, which nothing here was reading. The
    // effect was cosmetic but consistently wrong in one direction: /cost and /usage billed every
    // cached token at the full input rate, so the longer a session ran (and the better the cache
    // did), the more they overstated what it had actually cost.
    //
    // promptTokenCount already includes the cached tokens, so this is a breakdown of inputTokens,
    // not an addition to it — same shape Anthropic and OpenAI report.
    const grabUsage = (meta?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number }) => {
      if (!meta) return;
      // candidatesTokenCount EXCLUDES thinking, but thinking is billed at the output rate — leaving
      // it out under-reported output and cost on every call with thinking on.
      const thoughts = meta.thoughtsTokenCount ?? 0;
      usage = {
        inputTokens: meta.promptTokenCount ?? 0,
        outputTokens: (meta.candidatesTokenCount ?? 0) + thoughts,
        reasoningTokens: thoughts || undefined,
        // Left undefined rather than 0 when absent: 0 asserts "the cache was checked and missed",
        // which is a different claim from "this response said nothing about caching".
        cacheReadTokens: meta.cachedContentTokenCount ?? undefined,
      };
    };
    // ponytail: Gemini gives no call id → synthesize name+index. Parallel calls to the SAME tool
    // can't be disambiguated on the response side; rare in practice.
    const consume = (parts: readonly Record<string, unknown>[]) => {
      for (const p of parts) {
        rawParts.push(p);
        if (typeof p.text === "string") {
          text += p.text;
          onDelta?.(p.text);
        }
        const fc = p.functionCall as { name?: string; args?: unknown } | undefined;
        if (fc) {
          toolCalls.push({
            id: `${fc.name}-${n++}`,
            name: fc.name ?? "",
            input: (fc.args ?? {}) as Record<string, unknown>,
          });
        }
      }
    };

    if (onDelta) {
      const stream = await this.client.models.generateContentStream(params);
      for await (const chunk of stream) {
        consume((chunk.candidates?.[0]?.content?.parts ?? []) as Record<string, unknown>[]);
        grabUsage(chunk.usageMetadata);
      }
    } else {
      const res = await this.client.models.generateContent(params);
      consume((res.candidates?.[0]?.content?.parts ?? []) as Record<string, unknown>[]);
      grabUsage(res.usageMetadata);
    }
    return { text, toolCalls, raw: rawParts, usage };
  }

  // A fixed embedding model, independent of `this.model` (the chat model this instance was built
  // for isn't an embedding model, and the two are never the same id) — this is the current
  // generally-available Gemini embedding model, not something a caller should be picking per agent.
  async embed(texts: string[]): Promise<number[][]> {
    const res = await this.client.models.embedContent({ model: "gemini-embedding-001", contents: texts });
    return (res.embeddings ?? []).map((e) => e.values ?? []);
  }
}

// Flash and Flash-Lite ship with thinking effectively off, so a model that can reason is answering
// coding tasks without doing any — the single cheapest quality knob in this provider, and one
// nothing in niti was touching. Sent only when the user asked for it: `thinkingConfig` is rejected
// by models that have no thinking mode at all, so an unconditional default would break them.
//
// -1 is Gemini's "dynamic" budget: the model sizes its own thinking per request, which is the
// right answer whenever the user has not got a specific number in mind.
//
// Two model-specific encodings: Gemini 3 takes a `thinkingLevel` (low/high) in place of a token
// budget, and Pro models cannot switch thinking off at all — a budget of 0 is a 400 there, so
// "off" becomes the smallest budget Pro accepts. Aliases like gemini-pro-latest name no version, so
// they keep the budget form, which Gemini 3 still accepts.
export function thinkingConfig(r?: Reasoning, model = ""): Record<string, unknown> {
  if (!r) return {};
  if (/gemini-3/.test(model)) {
    if (r === "auto") return {}; // the model's own dynamic default
    return { thinkingConfig: { thinkingLevel: r === "off" || r === "low" ? "low" : "high" } };
  }
  const budget = { off: /pro/.test(model) ? 128 : 0, low: 1024, medium: 8192, high: 24576, auto: -1 }[r];
  return { thinkingConfig: { thinkingBudget: budget } };
}
