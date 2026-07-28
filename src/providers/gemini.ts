import { GoogleGenAI } from "@google/genai";
import type { Provider, Turn, ToolSpec, ToolCall, ProviderReply, OnDelta } from "./provider.ts";

export class GeminiProvider implements Provider {
  private client: GoogleGenAI;

  constructor(
    private model: string,
    apiKey: string, // required — the SDK has no env fallback
  ) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async send(sysPrompt: string, turns: Turn[], tools: ToolSpec[], onDelta?: OnDelta): Promise<ProviderReply> {
    // Gemini roles are "user"/"model"; tool results are functionResponse parts paired by name.
    const contents = turns.map((t) => {
      if (t.role === "user") return { role: "user", parts: [{ text: t.text }] };
      if (t.role === "assistant") {
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
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let n = 0;
    const grabUsage = (meta?: { promptTokenCount?: number; candidatesTokenCount?: number }) => {
      if (meta) usage = { inputTokens: meta.promptTokenCount ?? 0, outputTokens: meta.candidatesTokenCount ?? 0 };
    };
    // ponytail: Gemini gives no call id → synthesize name+index. Parallel calls to the SAME tool
    // can't be disambiguated on the response side; rare in practice.
    const consume = (parts: { text?: string; functionCall?: { name?: string; args?: unknown } }[]) => {
      for (const p of parts) {
        if (p.text) {
          text += p.text;
          onDelta?.(p.text);
        }
        if (p.functionCall) {
          toolCalls.push({
            id: `${p.functionCall.name}-${n++}`,
            name: p.functionCall.name ?? "",
            input: (p.functionCall.args ?? {}) as Record<string, unknown>,
          });
        }
      }
    };

    if (onDelta) {
      const stream = await this.client.models.generateContentStream(params);
      for await (const chunk of stream) {
        consume(chunk.candidates?.[0]?.content?.parts ?? []);
        grabUsage(chunk.usageMetadata);
      }
    } else {
      const res = await this.client.models.generateContent(params);
      consume(res.candidates?.[0]?.content?.parts ?? []);
      grabUsage(res.usageMetadata);
    }
    return { text, toolCalls, usage };
  }
}
