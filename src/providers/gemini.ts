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
}
