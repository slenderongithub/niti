import type { Provider, Turn, ToolResult, ToolSpec, ToolCall } from "../providers/provider.ts";
import { summarizeError } from "../providers/provider.ts";
import type { Bus } from "../events/bus.ts";
import type { Approve } from "../approval.ts";
import type { McpTools } from "../mcp/mcp.ts";
import type { UsageTracker } from "../usage.ts";
import type { LockRegistry } from "../orchestrator/locks.ts";
import type { Messenger, MessageKind } from "../messaging/message-bus.ts";
import { MAX_ASK_DEPTH } from "../messaging/message-bus.ts";
import { runTool, toolSpecs, toSandboxCall } from "../tools/tools.ts";
import { contextWindow } from "../providers/catalog.ts";
import { compactTurns } from "./context.ts";

const MAX_TURNS = 12; // bound the tool loop so a misbehaving model can't spin forever
const MAX_RESPOND_TURNS = 6; // shorter cap when answering a peer's question (see respond)
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

// Coordination tools — how an agent reaches teammates. Not sandboxed, not approval-gated (internal),
// but they DO consume a tool-call turn and are rate/depth-capped by the MessageBus.
const MESSAGING_TOOLS = new Set(["send_message", "ask_agent"]);

export interface AgentConfig {
  id: string; // "architect", "frontend"
  provider: string; // a key in the provider CATALOG
  model: string;
  role: string; // shown in TUI
  systemPrompt: string;
  allowedTools?: string[]; // "read_file" | "write_file" | "shell"
  lead?: boolean; // true = plans + integrates (the orchestrator)
  baseURL?: string; // for provider "custom" (any OpenAI-compatible endpoint)
  autoApprove?: string[]; // tool names pre-granted for this agent, no prompt (still gated for dangerous shell calls)
}

export interface AgentDeps {
  root?: string;
  approve?: Approve; // present → gated tools ask before running (interactive mode)
  mcp?: McpTools; // present → its namespaced tools are available alongside the sandbox
  usageTracker?: UsageTracker; // present → per-agent token + rate-limit stats for /usage
  locks?: LockRegistry; // present → write_file/shell wait their turn on a path/lock another agent holds
  messenger?: Messenger; // present → send_message/ask_agent tools + inbox injection
}

export class Agent {
  private root: string;
  private approve?: Approve;
  private mcp?: McpTools;
  private usageTracker?: UsageTracker;
  private locks?: LockRegistry;
  private messenger?: Messenger;
  private lastText = "";
  // A counter, not a boolean: run() and respond() can be concurrently in-flight on the same Agent
  // (ask_agent lets a peer answer while its own task is still running) — a boolean would let one
  // finishing clear "busy" while the other is still active.
  private inFlightCount = 0;

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
    this.messenger = deps.messenger;
  }

  // Final assistant text of the most recent run/respond — the scheduler uses it for hand-offs.
  get output(): string {
    return this.lastText;
  }

  // True while run()/respond() has a model call in flight. reconfigure() checks this — swapping
  // providers mid-loop would send a turn history built for one provider (e.g. Anthropic's opaque
  // `raw` thinking blocks) to a different provider's send(), which can reject or misinterpret it.
  get busy(): boolean {
    return this.inFlightCount > 0;
  }

  // Runs one task as an agentic loop: model call → execute any tool calls (sandboxed) → feed
  // results back → repeat until the model stops calling tools or the turn cap is hit.
  async run(task: string, askDepth = 0): Promise<RunOutcome> {
    const id = this.config.id;
    const allowed = this.config.allowedTools ?? [];
    const turns: Turn[] = [{ role: "user", text: task }];
    const onDelta = (text: string) =>
      this.bus.publish({ agentId: id, type: "delta", payload: text, time: Date.now() });
    const context = contextWindow(this.config.provider);
    let warned = false;
    let quotaWarned = false;
    this.inFlightCount++;
    try {
      for (let i = 0; i < MAX_TURNS; i++) {
        this.injectInbox(turns);
        const tools = this.buildTools(allowed, askDepth);
        const reply = await this.provider.send(this.config.systemPrompt, turns, tools, onDelta);
        if (reply.text) {
          this.lastText = reply.text;
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
          results.push({ id: call.id, name: call.name, output: await this.execTool(call, allowed, askDepth) });
        }
        turns.push({ role: "tool", results });
      }
      this.bus.publish({ agentId: id, type: "done", payload: "(turn cap reached)", time: Date.now() });
      return "done";
    } catch (err) {
      this.bus.publish({ agentId: id, type: "error", payload: summarizeError(err), time: Date.now() });
      return isExhaustion(err) ? "exhausted" : "failed";
    } finally {
      this.inFlightCount--;
    }
  }

  // Answer a teammate's question. A bounded agentic loop (can read files / call tools to ground the
  // answer) that returns the final text. askDepth bounds A→B→A→… chains via MAX_ASK_DEPTH.
  async respond(question: string, askDepth: number): Promise<string> {
    const id = this.config.id;
    const allowed = this.config.allowedTools ?? [];
    const turns: Turn[] = [{ role: "user", text: question }];
    const onDelta = (text: string) => this.bus.publish({ agentId: id, type: "delta", payload: text, time: Date.now() });
    this.inFlightCount++;
    try {
      let text = "";
      for (let i = 0; i < MAX_RESPOND_TURNS; i++) {
        this.injectInbox(turns);
        const reply = await this.provider.send(this.config.systemPrompt, turns, this.buildTools(allowed, askDepth), onDelta);
        if (reply.text) text = reply.text;
        if (reply.usage) this.usageTracker?.record(id, reply.usage.inputTokens, reply.usage.outputTokens);
        if (reply.toolCalls.length === 0) break;
        turns.push({ role: "assistant", text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw });
        const results: ToolResult[] = [];
        for (const call of reply.toolCalls) results.push({ id: call.id, name: call.name, output: await this.execTool(call, allowed, askDepth) });
        turns.push({ role: "tool", results });
      }
      // NB: respond() must NOT write this.lastText — a peer's ask can run concurrently with this
      // agent's own run(), and the scheduler reads run()'s output via `output`. Return locally.
      return text || "(no answer)";
    } catch (err) {
      return `error answering: ${summarizeError(err)}`;
    } finally {
      this.inFlightCount--;
    }
  }

  // Raw single call, no tools/events — used by the orchestrator to plan and to integrate.
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

  // Drain the inbox and inject any teammate messages as a user turn so the model reads and can reply.
  private injectInbox(turns: Turn[]): void {
    if (!this.messenger) return;
    const inbox = this.messenger.inbox(this.config.id);
    if (!inbox.length) return;
    const text = inbox.map((m) => `[from ${m.from} · ${m.kind}] ${m.subject}\n${m.body}`).join("\n\n");
    turns.push({ role: "user", text: `Messages from teammates:\n\n${text}` });
    this.bus.publish({ agentId: this.config.id, type: "thought", payload: `received ${inbox.length} message(s)`, time: Date.now() });
  }

  // Tool specs offered to the model: sandbox tools + MCP tools + (when a messenger is wired and
  // peers exist) the coordination tools. ask_agent disappears once the ask-depth cap is reached.
  private buildTools(allowed: string[], askDepth: number): ToolSpec[] {
    const specs = [...toolSpecs(allowed), ...(this.mcp?.toolSpecs() ?? [])];
    if (!this.messenger) return specs;
    const peers = this.messenger.peers(this.config.id);
    if (!peers.length) return specs;
    const roster = peers.map((p) => `"${p.id}" (${p.role})`).join(", ");
    specs.push({
      name: "send_message",
      description: `Send a message to a teammate (fire-and-forget) — for hand-offs, sharing an artifact, or an FYI. Teammates: ${roster}.`,
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "recipient teammate id" },
          kind: { type: "string", enum: ["handoff", "artifact", "review", "broadcast"] },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["to", "subject", "body"],
      },
    });
    if (askDepth < MAX_ASK_DEPTH) {
      specs.push({
        name: "ask_agent",
        description: `Ask a teammate a question and wait for their answer — e.g. align an interface. Teammates: ${roster}.`,
        parameters: {
          type: "object",
          properties: { to: { type: "string" }, question: { type: "string" } },
          required: ["to", "question"],
        },
      });
    }
    return specs;
  }

  // Execute one tool call: coordination tools first, then approval + MCP/sandbox dispatch. Publishes
  // the tool_call / file_edit / error telemetry. Returns the string result fed back to the model.
  private async execTool(call: ToolCall, allowed: string[], askDepth: number): Promise<string> {
    const id = this.config.id;
    this.bus.publish({ agentId: id, type: "tool_call", payload: `${call.name} ${JSON.stringify(call.input)}`.slice(0, 180), time: Date.now() });

    if (MESSAGING_TOOLS.has(call.name) && this.messenger) {
      return this.execMessaging(call, askDepth);
    }

    const isMcp = this.mcp?.has(call.name) ?? false;
    const needsApproval = GATED.has(call.name) || isMcp; // external/side-effecting tools ask
    const dangerous = isDangerousShellCall(call.name, call.input); // always prompts, even with a standing grant
    if (this.approve && needsApproval && !(await this.approve(call.name, call.input, dangerous))) {
      this.bus.publish({ agentId: id, type: "error", payload: `${call.name}: denied by user`, time: Date.now() });
      return "denied by user";
    }
    try {
      let output: string;
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
      this.bus.publish({ agentId: id, type: "file_edit", payload: `${call.name} → ${output.slice(0, 120).replace(/\n/g, " ")}`, time: Date.now() });
      return output;
    } catch (err) {
      const output = `error: ${err}`;
      this.bus.publish({ agentId: id, type: "error", payload: `${call.name}: ${output}`, time: Date.now() });
      return output;
    }
  }

  private async execMessaging(call: ToolCall, askDepth: number): Promise<string> {
    const m = this.messenger!;
    const to = String(call.input.to ?? "");
    if (call.name === "send_message") {
      const kind = (["handoff", "artifact", "review", "broadcast"].includes(String(call.input.kind)) ? call.input.kind : "handoff") as MessageKind;
      return m.send(this.config.id, to, kind, String(call.input.subject ?? ""), String(call.input.body ?? ""));
    }
    // ask_agent
    if (askDepth + 1 > MAX_ASK_DEPTH) return "ask-depth limit reached — answer from what you already know.";
    return m.ask(this.config.id, to, String(call.input.question ?? ""), askDepth + 1);
  }
}
