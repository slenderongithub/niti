import type { Provider, Turn, ToolResult } from "../providers/provider.ts";
import { summarizeError } from "../providers/provider.ts";
import type { Bus } from "../events/bus.ts";
import type { Approve } from "../approval.ts";
import type { McpTools } from "../mcp/mcp.ts";
import type { UsageTracker } from "../usage.ts";
import type { LockRegistry } from "../orchestrator/locks.ts";
import { runTool, toolSpecs, toSandboxCall } from "../tools/tools.ts";
import { contextWindow } from "../providers/catalog.ts";
import { compactTurns } from "./context.ts";

const MAX_TURNS = 12; // bound the tool loop so a misbehaving model can't spin forever
const GATED = new Set(["write_file", "shell"]); // require approval before these run
const WARN_RATIO = 0.85; // heads-up when input tokens pass this fraction of the context window
const COMPACT_RATIO = 0.95; // auto-compact past this fraction — a long task's turns can otherwise fill the window
// shell can touch anything (redirects, git, mv, rm…) and args are opaque to us — parsing them for
// real paths is a guessing game. ponytail: one global lock for all shell calls instead of per-path;
// upgrade to real path extraction only if shell contention actually shows up in practice.
export const SHELL_LOCK = "*shell*";

// Commands that must always prompt, even if this agent has a standing "always allow shell" grant.
const DANGEROUS_PATTERNS = [
  /rm\s+-rf/,
  /git\s+reset\s+--hard/,
  /drop\s+table/i,
  /git\s+push\s+--force/,
  /:\(\)\s*\{/, // fork bomb
];

export function isDangerousShellCall(name: string, input: Record<string, unknown>): boolean {
  if (name !== "shell") return false;
  const args = Array.isArray(input.args) ? input.args.map(String) : [];
  const full = `${String(input.command ?? "")} ${args.join(" ")}`;
  return DANGEROUS_PATTERNS.some((p) => p.test(full));
}

export function overContextThreshold(inputTokens: number, context: number, ratio = WARN_RATIO): boolean {
  return context > 0 && inputTokens > context * ratio;
}

export type RunOutcome = "done" | "failed" | "exhausted";

// Rate-limit (429), overload (529), or context-window errors → the task should fail over to another agent.
function isExhaustion(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  if (e?.status === 429 || e?.status === 529) return true;
  const m = String(e?.message ?? err).toLowerCase();
  return m.includes("rate limit") || m.includes("rate_limit") || m.includes("overloaded") || (m.includes("context") && m.includes("exceed"));
}

export interface AgentConfig {
  id: string; // "architect", "frontend"
  provider: string; // a key in the provider CATALOG
  model: string;
  role: string; // shown in TUI
  systemPrompt: string;
  allowedTools?: string[]; // "read_file" | "write_file" | "shell"
  lead?: boolean; // true = decomposes the initial prompt into tasks
  baseURL?: string; // for provider "custom" (any OpenAI-compatible endpoint)
  autoApprove?: string[]; // tool names pre-granted for this agent, no prompt (still gated for dangerous shell calls)
}

export interface AgentDeps {
  root?: string;
  approve?: Approve; // present → gated tools ask before running (interactive mode)
  mcp?: McpTools; // present → its namespaced tools are available alongside the sandbox
  usageTracker?: UsageTracker; // present → per-agent token + rate-limit stats for /usage
  locks?: LockRegistry; // present → write_file/shell wait their turn on a path/lock another agent holds
}

export class Agent {
  private root: string;
  private approve?: Approve;
  private mcp?: McpTools;
  private usageTracker?: UsageTracker;
  private locks?: LockRegistry;

  constructor(
    readonly config: AgentConfig,
    private provider: Provider,
    private bus: Bus,
    deps: AgentDeps = {},
  ) {
    this.root = deps.root ?? process.cwd();
    this.approve = deps.approve;
    this.mcp = deps.mcp;
    this.usageTracker = deps.usageTracker;
    this.locks = deps.locks;
  }

  // Runs one task as an agentic loop: model call → execute any tool calls (sandboxed) → feed
  // results back → repeat until the model stops calling tools or the turn cap is hit.
  async run(task: string): Promise<RunOutcome> {
    const id = this.config.id;
    const allowed = this.config.allowedTools ?? [];
    const tools = [...toolSpecs(allowed), ...(this.mcp?.toolSpecs() ?? [])];
    const turns: Turn[] = [{ role: "user", text: task }];
    const onDelta = (text: string) =>
      this.bus.publish({ agentId: id, type: "delta", payload: text, time: Date.now() });
    const context = contextWindow(this.config.provider);
    let warned = false;
    let quotaWarned = false;
    try {
      for (let i = 0; i < MAX_TURNS; i++) {
        const reply = await this.provider.send(this.config.systemPrompt, turns, tools, onDelta);
        if (reply.text) {
          this.bus.publish({ agentId: id, type: "message", payload: reply.text, time: Date.now() });
        }
        if (reply.usage) this.usageTracker?.record(id, reply.usage.inputTokens, reply.usage.outputTokens);
        if (reply.rateLimit) this.usageTracker?.recordRateLimit(this.config.provider, reply.rateLimit);

        // Pre-emptive heads-up: fire once when the conversation nears the context window.
        if (!warned && reply.usage && overContextThreshold(reply.usage.inputTokens, context)) {
          warned = true;
          const pct = Math.round((reply.usage.inputTokens / context) * 100);
          this.bus.publish({ agentId: id, type: "warning", payload: `context ~${pct}% full (${reply.usage.inputTokens}/${context} tokens)`, time: Date.now() });
        }
        // Account-quota heads-up: fire once when requests-remaining is about to hit zero.
        const rr = reply.rateLimit?.remainingRequests;
        if (!quotaWarned && rr != null && rr <= 1) {
          quotaWarned = true;
          this.bus.publish({ agentId: id, type: "warning", payload: `${this.config.provider} rate limit low — ${rr} requests remaining`, time: Date.now() });
        }
        // Past 95%, summarize older turns instead of letting the next call overflow the window.
        if (reply.usage && overContextThreshold(reply.usage.inputTokens, context, COMPACT_RATIO)) {
          const before = turns.length;
          turns.splice(0, turns.length, ...(await compactTurns(turns, this.provider)));
          if (turns.length < before) {
            this.bus.publish({ agentId: id, type: "warning", payload: `context compacted automatically (${before} → ${turns.length} turns)`, time: Date.now() });
          }
        }
        if (reply.toolCalls.length === 0) {
          this.bus.publish({ agentId: id, type: "done", payload: "", time: Date.now() });
          return "done";
        }
        turns.push({ role: "assistant", text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw });

        const results: ToolResult[] = [];
        for (const call of reply.toolCalls) {
          this.bus.publish({
            agentId: id,
            type: "tool_call",
            payload: `${call.name} ${JSON.stringify(call.input)}`.slice(0, 180),
            time: Date.now(),
          });
          const isMcp = this.mcp?.has(call.name) ?? false;
          const needsApproval = GATED.has(call.name) || isMcp; // external/side-effecting tools ask
          const dangerous = isDangerousShellCall(call.name, call.input); // always prompts, even with a standing grant
          let output: string;
          if (this.approve && needsApproval && !(await this.approve(call.name, call.input, dangerous))) {
            output = "denied by user";
            this.bus.publish({ agentId: id, type: "error", payload: `${call.name}: denied by user`, time: Date.now() });
          } else {
            try {
              if (isMcp) {
                output = await this.mcp!.call(call.name, call.input);
              } else {
                const sandboxCall = toSandboxCall(call);
                const lockPath =
                  sandboxCall.tool === "write_file" ? sandboxCall.path : sandboxCall.tool === "shell" ? SHELL_LOCK : undefined;
                if (lockPath && this.locks) await this.locks.acquire(lockPath, id);
                try {
                  output = await runTool(sandboxCall, allowed, this.root);
                } finally {
                  if (lockPath && this.locks) this.locks.release(lockPath, id);
                }
              }
              this.bus.publish({
                agentId: id,
                type: "file_edit",
                payload: `${call.name} → ${output.slice(0, 120).replace(/\n/g, " ")}`,
                time: Date.now(),
              });
            } catch (err) {
              output = `error: ${err}`;
              this.bus.publish({ agentId: id, type: "error", payload: `${call.name}: ${output}`, time: Date.now() });
            }
          }
          results.push({ id: call.id, name: call.name, output });
        }
        turns.push({ role: "tool", results });
      }
      this.bus.publish({ agentId: id, type: "done", payload: "(turn cap reached)", time: Date.now() });
      return "done";
    } catch (err) {
      this.bus.publish({ agentId: id, type: "error", payload: summarizeError(err), time: Date.now() });
      return isExhaustion(err) ? "exhausted" : "failed";
    }
  }

  // Raw single call, no tools/events — used by the lead agent to decompose the initial prompt.
  async ask(prompt: string): Promise<string> {
    const reply = await this.provider.send(this.config.systemPrompt, [{ role: "user", text: prompt }], []);
    return reply.text;
  }

  // Swap this agent's provider/model live (used by the interactive model selector).
  reconfigure(providerName: string, model: string, provider: Provider, baseURL?: string): void {
    this.config.provider = providerName;
    this.config.model = model;
    this.config.baseURL = baseURL;
    this.provider = provider;
  }
}
