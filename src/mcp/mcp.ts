import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolSpec } from "../providers/provider.ts";
import { childEnv } from "../tools/tools.ts";

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
}

// The subset the agent needs — lets the agent depend on an interface, not the concrete manager.
export interface McpTools {
  toolSpecs(): ToolSpec[];
  has(name: string): boolean;
  call(name: string, input: Record<string, unknown>): Promise<string>;
  servers?(): { name: string; tools: number }[]; // optional: display only, so test fakes needn't implement it
  close?(): Promise<void>; // optional for the same reason; the shutdown path is what reaps stdio children
}

// Flatten MCP tool-result content blocks to a string for feeding back to the model.
export function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? (c as { text: string }).text : JSON.stringify(c)))
    .join("\n");
}

export class McpManager implements McpTools {
  private clients = new Map<string, Client>();
  private routes = new Map<string, { server: string; tool: string }>(); // namespaced name → server+tool
  private specs: ToolSpec[] = [];

  // Connect each server and gather its tools, namespaced as mcp__<server>__<tool>.
  // A server that fails to connect is skipped (logged), never fatal.
  async connect(servers: McpServerConfig[], onError?: (name: string, err: unknown) => void): Promise<void> {
    for (const s of servers) {
      try {
        const client = new Client({ name: "niti", version: "0.0.1" }, { capabilities: {} });
        // Explicit allowlist, same one `shell()` uses — the SDK's own default (getDefaultEnvironment())
        // is already curated, but pin it to niti's own policy rather than an SDK implementation detail.
        await client.connect(new StdioClientTransport({ command: s.command, args: s.args ?? [], env: childEnv() }));
        this.clients.set(s.name, client);
        const { tools } = await client.listTools();
        for (const t of tools) {
          const ns = `mcp__${s.name}__${t.name}`;
          this.routes.set(ns, { server: s.name, tool: t.name });
          this.specs.push({
            name: ns,
            description: t.description ?? "",
            parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
          });
        }
      } catch (err) {
        onError?.(s.name, err);
      }
    }
  }

  toolSpecs(): ToolSpec[] {
    return this.specs;
  }

  // Connected servers and how many tools each contributed — for the TUI's MCP panel. Only servers
  // that actually connected appear (connect() skips the ones that failed).
  servers(): { name: string; tools: number }[] {
    const counts = new Map<string, number>();
    for (const { server } of this.routes.values()) counts.set(server, (counts.get(server) ?? 0) + 1);
    return [...this.clients.keys()].map((name) => ({ name, tools: counts.get(name) ?? 0 }));
  }

  has(name: string): boolean {
    return this.routes.has(name);
  }

  async call(name: string, input: Record<string, unknown>): Promise<string> {
    const ref = this.routes.get(name);
    if (!ref) throw new Error(`unknown MCP tool: ${name}`);
    const res = await this.clients.get(ref.server)!.callTool({ name: ref.tool, arguments: input });
    return extractText(res.content);
  }

  async close(): Promise<void> {
    for (const c of this.clients.values()) await c.close();
  }
}
