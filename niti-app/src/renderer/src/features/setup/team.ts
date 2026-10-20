import type { AgentConfig } from "@/lib/types";

// The TUI picker's rules for turning a teammate into an AgentConfig (tui/internal/wizard/picker.go),
// so a team built here is byte-for-byte what the TUI would have written.

export const MAX_AGENTS = 6;
// `web`: web_fetch and lookup, plus web_search once a Tavily key is saved — every call still asks.
const DEFAULT_TOOLS = ["read_file", "write_file", "edit", "shell", "web"];

export function teamHint(n: number): string {
  if (n === 1) return "solo — one model does everything";
  if (n === 2) return "a lead and a builder";
  return `${n} models working in parallel`;
}

// Lowercase alphanumerics with single dashes; "agent" when nothing usable is left.
export function sanitize(s: string): string {
  let out = "";
  let dash = false;
  for (const ch of s.toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) {
      out += ch;
      dash = false;
    } else if (!dash) {
      out += "-";
      dash = true;
    }
  }
  out = out.replace(/^-+|-+$/g, "");
  return out || "agent";
}

export function systemPrompt(role: string, desc: string): string {
  let p = `You are the ${role}.`;
  if (desc.trim()) p += ` ${desc.trim()}`;
  return `${p} Implement your assigned tasks directly and efficiently — you have a limited number of tool calls, so spend them on the task rather than exploring around it. Stay inside the project.`;
}

export function buildAgent(d: { provider: string; model: string; role: string; desc: string; lead?: boolean; baseURL?: string }, used: Set<string>): AgentConfig {
  let id = sanitize(d.role);
  while (used.has(id)) id += "-2";
  used.add(id);
  return {
    id,
    provider: d.provider,
    model: d.model,
    role: d.role,
    systemPrompt: systemPrompt(d.role, d.desc),
    allowedTools: [...DEFAULT_TOOLS],
    ...(d.lead ? { lead: true } : {}),
    ...(d.baseURL ? { baseURL: d.baseURL } : {}),
  };
}

export const ROLE_SUGGESTIONS = [
  { role: "Architect", desc: "Plans the structure, keeps the design coherent, and reviews how the pieces fit." },
  { role: "Backend", desc: "Owns the server, APIs and data layer." },
  { role: "Frontend", desc: "Owns the UI: components, styling and client-side state." },
  { role: "Tester", desc: "Writes and runs tests, and reports failures with a clear reproduction." },
  { role: "Reviewer", desc: "Reviews changes for bugs, missed cases and unclear code before they're accepted." },
  { role: "DevOps", desc: "Owns builds, CI, scripts and deployment configuration." },
];
