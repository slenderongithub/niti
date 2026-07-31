import { GENERATED_CATALOG } from "./catalog.generated.ts";

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

// Approximate context window for the depth warning. ponytail: per-provider, not per-model — models
// within a provider vary; a heads-up warning doesn't need exactness.
export function contextWindow(provider: string): number {
  return CATALOG[provider]?.context ?? DEFAULT_CONTEXT;
}

// ponytail: model lists are seeds, not exhaustive — provider catalogs drift. The selector's
// "custom…" entry is the escape hatch for any model id not listed here.
// Hand-maintained entries — native clients, local runtimes, and Copilot login — take priority
// over the generated list below on id collision (they carry client/category info the generator
// can't infer). Everything else (161+ providers, incl. z.ai) comes from GENERATED_CATALOG.
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
    models: ["gemini-2.0-flash", "gemini-2.0-pro", "gemini-1.5-pro"],
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
    models: ["kimi-k2-0711-preview", "moonshot-v1-128k", "moonshot-v1-32k"],
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
    models: ["accounts/fireworks/models/llama-v3p3-70b-instruct"],
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
    envVar: "GITHUB_COPILOT_TOKEN", // env fallback; normally set by `amux login copilot`
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
