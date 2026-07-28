// The one interface every provider implements. One agentic model call: given the conversation
// so far and the available tools, return the assistant's text plus any tool calls it wants run.

// Some SDKs (e.g. @google/genai's ApiError) wrap the raw HTTP error body as a JSON *string*
// inside `.message`, so `String(err)` dumps "ApiError: {\"error\":{\"message\":\"{\\n ..." —
// the useful reason is buried past where a truncated UI display cuts off. Unwrap one level of
// nested JSON so the summary leads with the actual status/reason, not outer braces.
export function summarizeError(err: unknown): string {
  const e = err as { status?: number; message?: string };
  let msg = e?.message ?? String(err);
  try {
    const parsed = JSON.parse(msg);
    const inner = parsed?.error ?? parsed;
    if (typeof inner?.message === "string") msg = inner.message;
  } catch {
    // not JSON — use the message as-is
  }
  return e?.status ? `${e.status}: ${msg}` : msg;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string; // Gemini pairs responses by function name, not id
  output: string;
}

export type Turn =
  | { role: "user"; text: string }
  // raw: provider-native assistant content, replayed verbatim so blocks that must round-trip
  // unchanged (e.g. Anthropic thinking blocks) survive tool turns. Opaque to other providers.
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: "tool"; results: ToolResult[] };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

// Account-level quota left, read from response rate-limit headers.
export interface RateLimit {
  remainingTokens?: number;
  remainingRequests?: number;
  resetAt?: string;
}

// Pure header → RateLimit parse (kept testable). Header names differ per provider.
export function parseRateLimit(headers: Headers, kind: "anthropic" | "openai"): RateLimit {
  const num = (s: string | null) => (s == null || !Number.isFinite(Number(s)) ? undefined : Number(s));
  if (kind === "anthropic") {
    return {
      remainingTokens: num(headers.get("anthropic-ratelimit-tokens-remaining")),
      remainingRequests: num(headers.get("anthropic-ratelimit-requests-remaining")),
      resetAt: headers.get("anthropic-ratelimit-tokens-reset") ?? undefined,
    };
  }
  return {
    remainingTokens: num(headers.get("x-ratelimit-remaining-tokens")),
    remainingRequests: num(headers.get("x-ratelimit-remaining-requests")),
    resetAt: headers.get("x-ratelimit-reset-tokens") ?? undefined,
  };
}

export interface ProviderReply {
  text: string;
  toolCalls: ToolCall[];
  raw?: unknown; // native assistant content for verbatim replay (see Turn.raw)
  usage?: Usage; // for the pre-emptive context-depth warning
  rateLimit?: RateLimit; // account quota remaining (from response headers)
}

export type OnDelta = (text: string) => void;

export interface Provider {
  // When onDelta is given, the provider streams text chunks to it and still returns the full reply.
  send(sysPrompt: string, turns: Turn[], tools: ToolSpec[], onDelta?: OnDelta): Promise<ProviderReply>;
}
