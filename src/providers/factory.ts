import type { Provider } from "./provider.ts";
import type { AgentConfig } from "../agent/agent.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { OpenAIProvider } from "./openai.ts";
import { GeminiProvider } from "./gemini.ts";
import { CopilotProvider } from "./copilot.ts";
import { CATALOG, providerKeys } from "./catalog.ts";
import { getKey } from "../keystore/keystore.ts";

export function makeProvider(cfg: AgentConfig): Provider {
  const entry = CATALOG[cfg.provider];
  if (!entry) {
    throw new Error(`unknown provider '${cfg.provider}' (known: ${providerKeys().join(", ")})`);
  }
  let apiKey = getKey(cfg.provider);
  if (!apiKey && entry.keyOptional) apiKey = "local"; // Ollama/LM Studio/custom need no real key
  if (!apiKey) {
    if (entry.client === "copilot") throw new Error(`not signed in to ${entry.label}. Run: amux login copilot`);
    throw new Error(`no API key for '${cfg.provider}'. Run: amux keys set ${cfg.provider} (or export ${entry.envVar})`);
  }
  switch (entry.client) {
    case "anthropic":
      return new AnthropicProvider(cfg.model, apiKey, cfg.baseURL ?? entry.baseURL);
    case "gemini":
      return new GeminiProvider(cfg.model, apiKey);
    case "openai":
      return new OpenAIProvider(cfg.model, apiKey, cfg.baseURL ?? entry.baseURL);
    case "copilot":
      return new CopilotProvider(cfg.model, apiKey); // apiKey is the GitHub OAuth token
  }
}
