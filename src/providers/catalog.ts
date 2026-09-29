import { GENERATED_CATALOG, GENERATED_CONTEXT } from "./catalog.generated.ts";

// Provider catalog — the single source of provider metadata (client, baseURL, env var, models).
// Anthropic and Google use native clients; everything else speaks the OpenAI chat API via baseURL,
// which is how opencode/models.dev cover dozens of providers with one client.
export type ClientKind = "anthropic" | "gemini" | "openai" | "copilot";

export type Category = "byok" | "local" | "login";

export interface CatalogEntry {
  label: string;
  client: ClientKind;
  baseURL?: string; // openai-compatible providers only
  envVar: string;
  keyOptional?: boolean; // local runtimes (Ollama, LM Studio) need no real key
  category?: Category; // undefined = "byok"
  context?: number; // approximate context window (for the 85% depth warning); default below
  models: string[]; // popular seeds; the selector always offers "custom…" for anything else
}

const DEFAULT_CONTEXT = 128_000;

// Model-name prefix → context window, for the hand-maintained providers models.dev doesn't cover
// here (Anthropic, OpenAI, Google) and for provider-prefixed ids routed through a gateway.
// Longest prefix wins. Compaction fires at 95% of this, so it has to be the model's real window:
// Haiku 4.5 under the provider-wide 1M guess would overflow long before it ever compacted.
const MODEL_CONTEXT: Record<string, number> = {
  claude: 1_000_000, // Opus/Sonnet 4.6 and later, Fable
  "claude-haiku": 200_000,
  "claude-3": 200_000,
  "claude-sonnet-4-5": 200_000,
  "claude-sonnet-4-0": 200_000,
  "claude-sonnet-4-2": 200_000,
  "claude-opus-4-5": 200_000,
  "claude-opus-4-1": 200_000,
  "claude-opus-4-0": 200_000,
  "claude-opus-4-2": 200_000,
  "gpt-4o": 128_000,
  "gpt-4.1": 1_047_576,
  "gpt-5": 400_000,
  o1: 200_000,
  o3: 200_000,
  "o4-mini": 200_000,
  gemini: 1_048_576,
  "deepseek-chat": 128_000,
  "deepseek-reasoner": 128_000,
  "llama-3": 128_000,
  "mistral-large": 128_000,
  grok: 256_000,
};

// Windows learned at runtime (see probeOllamaContext), keyed "provider/model". They win over every
// table below because they describe the server actually running, not the model in general.
const LEARNED_CONTEXT = new Map<string, number>();

// Ollama serves each model with its own num_ctx — often 4–8k, however large the model's trained
// window — and silently drops the oldest part of an oversized prompt (the system prompt first)
// instead of erroring. Read what it will really accept from /api/show so compaction fires in time.
// Fire-and-forget: a server that isn't up yet keeps the conservative table value.
export async function probeOllamaContext(model: string, baseURL = "http://localhost:11434/v1"): Promise<number | undefined> {
  try {
    const res = await fetch(`${baseURL.replace(/\/v1\/?$/, "")}/api/show`, {
      method: "POST",
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return undefined;
    const info = (await res.json()) as { parameters?: string; model_info?: Record<string, unknown> };
    const numCtx = Number(/(?:^|\n)num_ctx\s+(\d+)/.exec(info.parameters ?? "")?.[1]);
    const trained = Object.entries(info.model_info ?? {}).find(([k]) => k.endsWith(".context_length"))?.[1];
    // ponytail: without an explicit num_ctx the server-wide default applies, which the API doesn't
    // report; 8k is below every recent default, so the error is compacting early, never overflowing.
    const n = numCtx > 0 ? numCtx : Math.min(typeof trained === "number" ? trained : 8192, 8192);
    LEARNED_CONTEXT.set(`ollama/${model}`, n);
    return n;
  } catch {
    return undefined;
  }
}

// Context window for the depth warning and compaction. A window learned from the running server
// first, then the exact models.dev entry, then the model-name prefix table, then the provider's
// own figure, then a conservative default.
export function contextWindow(provider: string, model = ""): number {
  const exact = LEARNED_CONTEXT.get(`${provider}/${model}`) ?? GENERATED_CONTEXT[`${provider}/${model}`];
  if (exact) return exact;
  const name = (model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model).toLowerCase();
  let best = 0;
  let bestLen = 0;
  for (const [prefix, n] of Object.entries(MODEL_CONTEXT)) {
    if (name.startsWith(prefix) && prefix.length > bestLen) {
      best = n;
      bestLen = prefix.length;
    }
  }
  return best || (CATALOG[provider]?.context ?? DEFAULT_CONTEXT);
}

// ponytail: model lists are seeds, not exhaustive — provider catalogs drift. The selector's
// "custom…" entry is the escape hatch for any model id not listed here.
// Hand-maintained entries — native clients, local runtimes, and Copilot login — take priority
// over the generated list below on id collision (they carry client/category info the generator
// can't infer). Everything else (a curated slice of models.dev, incl. z.ai) comes from GENERATED_CATALOG.
const MANUAL_CATALOG: Record<string, CatalogEntry> = {
  anthropic: {
    label: "Anthropic",
    client: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    context: 1_000_000,
    models: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
  },
  openai: {
    label: "OpenAI",
    client: "openai",
    envVar: "OPENAI_API_KEY",
    models: ["gpt-4o", "gpt-4o-mini", "o3-mini", "o1"],
  },
  google: {
    label: "Google Gemini",
    client: "gemini",
    envVar: "GEMINI_API_KEY",
    context: 1_000_000,
    models: ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-pro-latest"],
  },
  openrouter: {
    label: "OpenRouter",
    client: "openai",
    baseURL: "https://openrouter.ai/api/v1",
    envVar: "OPENROUTER_API_KEY",
    models: ["anthropic/claude-opus-4-8", "openai/gpt-4o", "meta-llama/llama-3.3-70b-instruct"],
  },
  deepseek: {
    label: "DeepSeek",
    client: "openai",
    baseURL: "https://api.deepseek.com",
    envVar: "DEEPSEEK_API_KEY",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  moonshot: {
    label: "Moonshot (Kimi)",
    client: "openai",
    baseURL: "https://api.moonshot.ai/v1",
    envVar: "MOONSHOT_API_KEY",
    // Folded in from models.dev (the generator no longer emits a second "moonshotai" entry,
    // which put the same vendor in the picker twice).
    models: ["kimi-k2.5", "kimi-k2-thinking-turbo", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2-turbo-preview", "kimi-k2-0905-preview", "kimi-k2-0711-preview", "moonshot-v1-128k"],
  },
  groq: {
    label: "Groq",
    client: "openai",
    baseURL: "https://api.groq.com/openai/v1",
    envVar: "GROQ_API_KEY",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  },
  xai: {
    label: "xAI Grok",
    client: "openai",
    baseURL: "https://api.x.ai/v1",
    envVar: "XAI_API_KEY",
    models: ["grok-2", "grok-2-mini"],
  },
  mistral: {
    label: "Mistral",
    client: "openai",
    baseURL: "https://api.mistral.ai/v1",
    envVar: "MISTRAL_API_KEY",
    models: ["mistral-large-latest", "mistral-small-latest", "codestral-latest"],
  },
  together: {
    label: "Together",
    client: "openai",
    baseURL: "https://api.together.xyz/v1",
    envVar: "TOGETHER_API_KEY",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-Coder-32B-Instruct"],
  },
  fireworks: {
    label: "Fireworks",
    client: "openai",
    baseURL: "https://api.fireworks.ai/inference/v1",
    envVar: "FIREWORKS_API_KEY",
    // Folded in from models.dev, same reason as moonshot above.
    models: ["accounts/fireworks/routers/kimi-k3-fast", "accounts/fireworks/routers/glm-5p2-fast", "accounts/fireworks/routers/kimi-k2p7-code-fast", "accounts/fireworks/models/qwen3p7-plus", "accounts/fireworks/models/deepseek-v4-flash", "accounts/fireworks/models/gpt-oss-20b", "accounts/fireworks/models/llama-v3p3-70b-instruct"],
  },
  cerebras: {
    label: "Cerebras",
    client: "openai",
    baseURL: "https://api.cerebras.ai/v1",
    envVar: "CEREBRAS_API_KEY",
    models: ["llama-3.3-70b", "llama-3.1-8b"],
  },
  ollama: {
    label: "Ollama (local)",
    client: "openai",
    baseURL: "http://localhost:11434/v1",
    envVar: "OLLAMA_API_KEY",
    keyOptional: true,
    category: "local",
    models: ["llama3.3", "qwen2.5-coder", "deepseek-r1"],
  },
  lmstudio: {
    label: "LM Studio (local)",
    client: "openai",
    baseURL: "http://localhost:1234/v1",
    envVar: "LMSTUDIO_API_KEY",
    keyOptional: true,
    category: "local",
    models: ["local-model"], // LM Studio serves whatever model you loaded; use custom… for its id
  },
  "github-copilot": {
    label: "GitHub Copilot",
    client: "copilot",
    envVar: "GITHUB_COPILOT_TOKEN", // env fallback; normally set by `niti login copilot`
    category: "login",
    models: ["gpt-4o", "claude-3.7-sonnet", "o1", "gemini-2.0-flash"],
  },
  // Any OpenAI-compatible endpoint — baseURL is entered in the selector and stored on the agent.
  custom: {
    label: "Custom (OpenAI-compatible)",
    client: "openai",
    envVar: "CUSTOM_API_KEY",
    keyOptional: true,
    category: "byok",
    models: [], // no seeds — the selector prompts for a model id
  },
};

export const CATALOG: Record<string, CatalogEntry> = { ...GENERATED_CATALOG, ...MANUAL_CATALOG };

export function providerKeys(): string[] {
  return Object.keys(CATALOG);
}

export function providersByCategory(cat: Category): string[] {
  return Object.keys(CATALOG).filter((k) => (CATALOG[k]!.category ?? "byok") === cat);
}

// Canonical model ids are "provider/model". If an explicit provider is given, trust it; otherwise
// split on the first "/" only when the head is a known provider (model names can contain slashes).
export function splitModelId(provider: string | undefined, model: string): { provider: string; model: string } {
  if (provider) return { provider, model };
  const slash = model.indexOf("/");
  if (slash > 0) {
    const head = model.slice(0, slash);
    if (CATALOG[head]) return { provider: head, model: model.slice(slash + 1) };
  }
  return { provider: "", model };
}
