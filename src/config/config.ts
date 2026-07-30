import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import type { AgentConfig } from "../agent/agent.ts";
import type { McpServerConfig } from "../mcp/mcp.ts";
import { CATALOG, providerKeys } from "../providers/catalog.ts";

// Loads and validates .amux/agents.yaml. User-authored → validate required fields with clear errors.
export function loadAgents(path = ".amux/agents.yaml"): AgentConfig[] {
  const raw = parse(readFileSync(path, "utf8"));
  const agents = raw?.agents;
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error(`${path}: expected a non-empty 'agents:' list`);
  }
  return agents.map((a, i) => validate(a, i, path));
}

// MCP servers declared under `mcpServers:` in the same file. Skips malformed entries.
export function loadMcpServers(path = ".amux/agents.yaml"): McpServerConfig[] {
  if (!existsSync(path)) return [];
  const raw = parse(readFileSync(path, "utf8")) as { mcpServers?: unknown };
  if (!Array.isArray(raw.mcpServers)) return [];
  return raw.mcpServers.flatMap((s: unknown) => {
    const r = (s ?? {}) as Record<string, unknown>;
    if (typeof r.name !== "string" || typeof r.command !== "string") return [];
    return [{ name: r.name, command: r.command, args: Array.isArray(r.args) ? (r.args as string[]) : undefined }];
  });
}

// Persist role assignments back to .amux/agents.yaml (written by the onboarding wizard and the
// live /model switcher so changes survive a restart). Keys never land here — they're in auth.json.
export function saveAgents(agents: AgentConfig[], path = ".amux/agents.yaml"): void {
  mkdirSync(dirname(path), { recursive: true });
  const doc = {
    agents: agents.map((a) => ({
      id: a.id,
      provider: a.provider,
      model: a.model,
      role: a.role,
      ...(a.lead ? { lead: true } : {}),
      systemPrompt: a.systemPrompt,
      ...(a.allowedTools ? { allowedTools: a.allowedTools } : {}),
      ...(a.baseURL ? { baseURL: a.baseURL } : {}),
      ...(a.autoApprove ? { autoApprove: a.autoApprove } : {}),
    })),
  };
  writeFileSync(path, stringify(doc));
}

function validate(a: unknown, i: number, path: string): AgentConfig {
  const rec = (a ?? {}) as Record<string, unknown>;
  const str = (k: string): string => {
    const v = rec[k];
    if (typeof v !== "string" || v === "") throw new Error(`${path} agent[${i}]: missing '${k}'`);
    return v;
  };
  const provider = str("provider");
  if (!CATALOG[provider]) {
    throw new Error(`${path} agent[${i}]: unknown provider '${provider}' (known: ${providerKeys().join(", ")})`);
  }
  const baseURL = typeof rec.baseURL === "string" ? rec.baseURL : undefined;
  if (provider === "custom" && !baseURL) {
    throw new Error(`${path} agent[${i}]: provider 'custom' requires a 'baseURL'`);
  }
  return {
    id: str("id"),
    provider,
    model: str("model"),
    role: str("role"),
    systemPrompt: str("systemPrompt"),
    allowedTools: Array.isArray(rec.allowedTools) ? (rec.allowedTools as string[]) : undefined,
    lead: rec.lead === true,
    baseURL,
    autoApprove: Array.isArray(rec.autoApprove) ? (rec.autoApprove as string[]) : undefined,
  };
}
