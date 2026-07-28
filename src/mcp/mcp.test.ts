import { test, expect } from "bun:test";
import { extractText, type McpTools } from "./mcp.ts";
import { Agent, type AgentConfig } from "../agent/agent.ts";
import { Bus } from "../events/bus.ts";
import type { Provider } from "../providers/provider.ts";

test("extractText flattens text content blocks", () => {
  expect(extractText([{ type: "text", text: "hello" }, { type: "text", text: "world" }])).toBe("hello\nworld");
  expect(extractText("nope")).toBe("");
});

// Fake MCP surface — no real server. Records calls to prove routing.
function fakeMcp(): McpTools & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    toolSpecs: () => [{ name: "mcp__demo__ping", description: "ping", parameters: { type: "object", properties: {} } }],
    has: (n) => n === "mcp__demo__ping",
    async call(n, input) {
      calls.push(`${n}:${JSON.stringify(input)}`);
      return "pong";
    },
  };
}

const cfg: AgentConfig = { id: "a", provider: "anthropic", model: "x", role: "r", systemPrompt: "s", allowedTools: [] };

test("agent routes an MCP tool call to the manager, not the sandbox, and feeds the result back", async () => {
  const mcp = fakeMcp();
  let n = 0;
  const seenResults: string[] = [];
  const stub: Provider = {
    async send(_sys, turns) {
      n++;
      // capture the tool result fed back on the 2nd call
      for (const t of turns) if (t.role === "tool") for (const r of t.results) seenResults.push(r.output);
      if (n === 1) return { text: "", toolCalls: [{ id: "1", name: "mcp__demo__ping", input: { x: 1 } }] };
      return { text: "done", toolCalls: [] };
    },
  };

  const agent = new Agent(cfg, stub, new Bus(), { mcp });
  const outcome = await agent.run("use the tool");

  expect(outcome).toBe("done");
  expect(mcp.calls).toEqual(['mcp__demo__ping:{"x":1}']); // routed to MCP
  expect(seenResults).toContain("pong"); // MCP result fed back to the model
});
