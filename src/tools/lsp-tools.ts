import type { ToolSpec } from "../providers/provider.ts";
import type { LspRegistry } from "../lsp/registry.ts";
import { safePath } from "./tools.ts";

// LSP-backed tools, offered alongside (never instead of) the MCP tools. Read-only: they answer
// questions about code, they never change it.
export const LSP_TOOLS = new Set(["diagnostics", "hover"]);

export const LSP_SPECS: ToolSpec[] = [
  {
    name: "diagnostics",
    description: "Type errors, warnings and lints for a file, from the project's language server. Use it to check your own edits compile before moving on.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "hover",
    description: "The type signature and documentation at a position in a file (1-based line and column), from the project's language server.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, line: { type: "number" }, column: { type: "number" } },
      required: ["path", "line"],
    },
  },
];

export function lspToolSpecs(registry?: LspRegistry): ToolSpec[] {
  return registry?.configured ? LSP_SPECS : [];
}

export function formatDiagnostics(path: string, diags: { line: number; column: number; severity: string; message: string; source?: string }[]): string {
  if (!diags.length) return `${path}: no diagnostics`;
  return diags.map((d) => `${path}:${d.line}:${d.column} ${d.severity}: ${d.message}${d.source ? ` (${d.source})` : ""}`).join("\n");
}

// Dispatch one LSP tool call. A missing/failed server is reported as a string the model can read
// and work around — same posture as an unavailable MCP server, never a thrown agent error.
export async function runLspTool(
  registry: LspRegistry,
  name: string,
  input: Record<string, unknown>,
  root: string,
): Promise<string> {
  const rel = String(input.path ?? "");
  const abs = safePath(root, rel); // agent-supplied path: same jail as every other tool
  const client = registry.clientFor(abs);
  if (!client) return `no language server configured for ${rel} — add one under 'lsp:' in .amux/agents.yaml`;
  try {
    if (name === "diagnostics") return formatDiagnostics(rel, await client.diagnostics(abs));
    const text = await client.hover(abs, Number(input.line ?? 1), Number(input.column ?? 1));
    return text || `no hover information at ${rel}:${input.line ?? 1}:${input.column ?? 1}`;
  } catch (err) {
    return `language server unavailable: ${err instanceof Error ? err.message : err}`;
  }
}
