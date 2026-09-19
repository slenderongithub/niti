import { GoogleGenAI } from "@google/genai";
import type { Provider, Turn, ToolSpec, ToolCall, ProviderReply, OnDelta, Reasoning } from "./provider.ts";

export class GeminiProvider implements Provider {
  private client: GoogleGenAI;

  constructor(
    private model: string,
    apiKey: string, // required — the SDK has no env fallback
    baseURL?: string, // a Gemini-compatible proxy; the factory computes it and used to drop it here
    private reasoning?: Reasoning,
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

  async send(sysPrompt: string, turns: Turn[], tools: ToolSpec[], onDelta?: OnDelta): Promise<ProviderReply> {
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
        ...thinkingConfig(this.reasoning),
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
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let n = 0;
    const grabUsage = (meta?: { promptTokenCount?: number; candidatesTokenCount?: number }) => {
      if (meta) usage = { inputTokens: meta.promptTokenCount ?? 0, outputTokens: meta.candidatesTokenCount ?? 0 };
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
export function thinkingConfig(r?: Reasoning): Record<string, unknown> {
  if (!r) return {};
  const budget = { off: 0, low: 1024, medium: 8192, high: 24576, auto: -1 }[r];
  return { thinkingConfig: { thinkingBudget: budget } };
}
