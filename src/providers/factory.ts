import type { Provider } from "./provider.ts";
import type { AgentConfig } from "../agent/agent.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { OpenAIProvider } from "./openai.ts";
import { GeminiProvider } from "./gemini.ts";
import { CopilotProvider } from "./copilot.ts";
import { CATALOG, providerKeys } from "./catalog.ts";
import { resolveApiKey, resolveBaseURL } from "../auth/auth-store.ts";

export function makeProvider(cfg: AgentConfig): Provider {
  // Own-property lookup: a plain-object index signature also resolves "constructor", "toString"
  // and friends off the prototype chain, so those names passed the unknown-provider check and
  // reached the switch below as a truthy non-entry.
  const entry = Object.hasOwn(CATALOG, cfg.provider) ? CATALOG[cfg.provider] : undefined;
  if (!entry) {
    throw new Error(`unknown provider '${cfg.provider}' (known: ${providerKeys().join(", ")})`);
  }
  let apiKey = resolveApiKey(cfg.provider); // typed auth store → keychain → env
  if (!apiKey && entry.keyOptional) apiKey = "local"; // Ollama/LM Studio/custom need no real key
  if (!apiKey) {
    if (entry.client === "copilot") throw new Error(`not signed in to ${entry.label}. Run: niti-core login copilot`);
    throw new Error(`no API key for '${cfg.provider}'. Run: niti-core auth login ${cfg.provider} (or export ${entry.envVar})`);
  }
  const baseURL = cfg.baseURL ?? resolveBaseURL(cfg.provider) ?? entry.baseURL;
  // `custom` exists precisely to point at an arbitrary OpenAI-compatible endpoint. With no URL it
  // fell through to the SDK default and sent the literal string "local" to api.openai.com as a
  // bearer token — a confusing 401 from a vendor the user never chose.
  if (!baseURL && entry.keyOptional) {
    throw new Error(`provider '${cfg.provider}' needs a baseURL — set it on the agent in .niti/agents.yaml, or run: niti-core auth login ${cfg.provider}`);
  }
  switch (entry.client) {
    case "anthropic":
      return new AnthropicProvider(cfg.model, apiKey, baseURL);
    case "gemini":
      return new GeminiProvider(cfg.model, apiKey, baseURL, cfg.reasoning);
    case "openai":
      return new OpenAIProvider(cfg.model, apiKey, baseURL, undefined, cfg.reasoning);
    case "copilot":
      return new CopilotProvider(cfg.model, apiKey); // apiKey is the GitHub OAuth token
  }
}
