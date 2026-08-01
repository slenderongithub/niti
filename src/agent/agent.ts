import type { Provider, Turn, ToolResult, ToolSpec, ToolCall, Usage } from "../providers/provider.ts";
import { summarizeError } from "../providers/provider.ts";
import type { Bus } from "../events/bus.ts";
import type { Approve } from "../approval.ts";
import type { McpTools } from "../mcp/mcp.ts";
import type { UsageTracker } from "../usage.ts";
import type { LockRegistry } from "../orchestrator/locks.ts";
import type { Messenger, MessageKind } from "../messaging/message-bus.ts";
import { MAX_ASK_DEPTH } from "../messaging/message-bus.ts";
import type { SessionStore, SessionKind } from "../store/session-store.ts";
import { toParts } from "../store/session-store.ts";
import { resolve as resolvePermission, DEFAULT_RULES, type PermissionRules } from "../permissions.ts";
import { runTool, toolSpecs, toSandboxCall, safePath, editDiff, WRITE_TOOLS } from "../tools/tools.ts";
import { lspToolSpecs, runLspTool, LSP_TOOLS } from "../tools/lsp-tools.ts";
import type { LspRegistry } from "../lsp/registry.ts";
import { readFile } from "node:fs/promises";
import { contextWindow } from "../providers/catalog.ts";
import { compactTurns } from "./context.ts";

const MAX_TURNS = 12; // bound the tool loop so a misbehaving model can't spin forever (maxTurns: in agents.yaml raises it)
const MAX_RESPOND_TURNS = 6; // shorter cap when answering a peer's question (see respond)
// Mirrors MAX_ASK_DEPTH's role for A→B→A chains: a fork may fork, but not indefinitely. Lower,
// because each level is a full MAX_TURNS loop rather than a single answer.
export const MAX_FORK_DEPTH = 2;
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

// Rate-limit (429), overload (529 Anthropic, 503 Google), or context-window errors → the task
// should fail over to another agent rather than being marked failed outright.
function isExhaustion(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  if (e?.status === 429 || e?.status === 529 || e?.status === 503) return true;
  const m = String(e?.message ?? err).toLowerCase();
  return (
    m.includes("rate limit") ||
    m.includes("rate_limit") ||
    m.includes("overloaded") ||
    m.includes("unavailable") ||
    m.includes("high demand") ||
    (m.includes("context") && m.includes("exceed"))
  );
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
  reviewer?: string; // agent id that reviews this role's completed task output before it's accepted
  baseURL?: string; // for provider "custom" (any OpenAI-compatible endpoint)
  autoApprove?: string[]; // tool names pre-granted for this agent, no prompt (still gated for dangerous shell calls)
  permissions?: PermissionRules; // per-agent tool policy; overrides the project-level block
}

export interface AgentDeps {
  root?: string;
  approve?: Approve; // present → gated tools ask before running (interactive mode)
  mcp?: McpTools; // present → its namespaced tools are available alongside the sandbox
  usageTracker?: UsageTracker; // present → per-agent token + rate-limit stats for /usage
  locks?: LockRegistry; // present → write_file/shell wait their turn on a path/lock another agent holds
  messenger?: Messenger; // present → send_message/ask_agent tools + inbox injection
  store?: SessionStore; // present → every turn is mirrored to SQLite (resume, undo, session history)
  permissionLayers?: PermissionRules[]; // project-level policy (and --auto), consulted after the agent's own
  lsp?: LspRegistry; // present → diagnostics/hover tools, alongside (not instead of) MCP
  onWrite?: (relPath: string) => void; // called just before a file write, so the watcher can ignore our own echo
  maxTurns?: number; // tool-loop cap for this agent; defaults to MAX_TURNS
}

export interface RunOptions {
  askDepth?: number; // inherited when a run is triggered from a peer's ask chain
  taskId?: string; // links this run's session row to the DAG task it belongs to
  priorTurns?: Turn[]; // seeded conversation history (resume) — already persisted, not re-mirrored
}

// What one turn of a loop needs to know about where it sits: how deep in an ask chain, how deep in
// a fork chain, and which session row its turns and checkpoints belong to.
export interface LoopCtx {
  askDepth: number;
  forkDepth: number;
  sessionId?: string;
}

export class Agent {
  private root: string;
  private approve?: Approve;
  private mcp?: McpTools;
  private usageTracker?: UsageTracker;
  private locks?: LockRegistry;
  private messenger?: Messenger;
  private store?: SessionStore;
  private permissionLayers: PermissionRules[];
  private lsp?: LspRegistry;
  private onWrite?: (relPath: string) => void;
  private maxTurns: number;
  private lastText = "";
  private lastError = "";
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
    this.maxTurns = deps.maxTurns && deps.maxTurns > 0 ? deps.maxTurns : MAX_TURNS;
    this.approve = deps.approve;
    this.mcp = deps.mcp;
    this.usageTracker = deps.usageTracker;
    this.locks = deps.locks;
    this.messenger = deps.messenger;
    this.store = deps.store;
    this.permissionLayers = deps.permissionLayers ?? [];
    this.lsp = deps.lsp;
    this.onWrite = deps.onWrite;
  }

  // Final assistant text of the most recent run/respond — the scheduler uses it for hand-offs.
  get output(): string {
    return this.lastText;
  }

  // Last error from run() — empty until a run() actually throws. The scheduler reads this to give
  // the replanning lead a concrete reason for a task's failure/exhaustion, not just a status code.
  get error(): string {
    return this.lastError;
  }

  // True while run()/respond() has a model call in flight. reconfigure() checks this — swapping
  // providers mid-loop would send a turn history built for one provider (e.g. Anthropic's opaque
  // `raw` thinking blocks) to a different provider's send(), which can reject or misinterpret it.
  get busy(): boolean {
    return this.inFlightCount > 0;
  }

  // Runs one task as an agentic loop: model call → execute any tool calls (sandboxed) → feed
  // results back → repeat until the model stops calling tools or the turn cap is hit.
  async run(task: string, opts: RunOptions = {}): Promise<RunOutcome> {
    const id = this.config.id;
    const askDepth = opts.askDepth ?? 0;
    const allowed = this.config.allowedTools ?? [];
    // priorTurns come back out of the store on resume — seed them into the loop, but don't mirror
    // them again (they're already persisted under their original session).
    const turns: Turn[] = [...(opts.priorTurns ?? [])];
    const sessionId = this.store?.createSession({
      agentId: id,
      kind: "task",
      provider: this.config.provider,
      model: this.config.model,
      taskId: opts.taskId,
    });
    const ctx: LoopCtx = { askDepth, forkDepth: 0, sessionId };
    this.push(turns, { role: "user", text: task }, sessionId);
    const onDelta = (text: string) =>
      this.bus.publish({ agentId: id, type: "delta", payload: text, time: Date.now() });
    const context = contextWindow(this.config.provider);
    let warned = false;
    let quotaWarned = false;
    this.inFlightCount++;
    try {
      for (let i = 0; i < this.maxTurns; i++) {
        this.injectInbox(turns, sessionId);
        const tools = this.buildTools(allowed, ctx);
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
          if (reply.text) this.push(turns, { role: "assistant", text: reply.text, toolCalls: [], raw: reply.raw }, sessionId, reply.usage);
          if (sessionId) this.store?.setStatus(sessionId, "done");
          this.bus.publish({ agentId: id, type: "done", payload: "", time: Date.now() });
          return "done";
        }
        this.push(turns, { role: "assistant", text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw }, sessionId, reply.usage);

        const results: ToolResult[] = [];
        for (const call of reply.toolCalls) {
          results.push({ id: call.id, name: call.name, output: await this.execTool(call, allowed, ctx) });
        }
        this.push(turns, { role: "tool", results }, sessionId);
      }
      if (sessionId) this.store?.setStatus(sessionId, "done");
      this.bus.publish({ agentId: id, type: "done", payload: "(turn cap reached)", time: Date.now() });
      return "done";
    } catch (err) {
      const outcome: RunOutcome = isExhaustion(err) ? "exhausted" : "failed";
      this.lastError = summarizeError(err);
      if (sessionId) this.store?.setStatus(sessionId, outcome);
      this.bus.publish({ agentId: id, type: "error", payload: this.lastError, time: Date.now() });
      return outcome;
    } finally {
      this.inFlightCount--;
    }
  }

  // Answer a teammate's question. A bounded agentic loop (can read files / call tools to ground the
  // answer) that returns the final text. askDepth bounds A→B→A→… chains via MAX_ASK_DEPTH.
  async respond(question: string, askDepth: number, parentSessionId?: string): Promise<string> {
    return this.subLoop(question, { kind: "ask", maxTurns: MAX_RESPOND_TURNS, askDepth, forkDepth: 0, parentSessionId });
  }

  // Spawn a sub-agent on this agent's own model to chase down one sub-goal, and return what it
  // found. Deliberately invisible to the DAG scheduler: a fork only matters to the conversation
  // that spawned it, so it's a child *session*, not a new TaskNode — pushing a mid-run task through
  // detectCycle/the ready queue would be a far larger blast radius for no gain to sibling tasks.
  // Same provider, same tools, same permissions (no privilege escalation), bounded by MAX_TURNS.
  async fork(goal: string, ctx: LoopCtx): Promise<string> {
    if (ctx.forkDepth + 1 > MAX_FORK_DEPTH) return "fork-depth limit reached — do this work yourself.";
    this.bus.publish({ agentId: this.config.id, type: "thought", payload: `fork: ${goal.slice(0, 80)}`, time: Date.now() });
    return this.subLoop(goal, {
      kind: "fork",
      maxTurns: this.maxTurns,
      askDepth: ctx.askDepth,
      forkDepth: ctx.forkDepth + 1,
      parentSessionId: ctx.sessionId,
    });
  }

  // The shared body behind respond() and fork(): the same loop run() uses, but it returns text
  // instead of an outcome and never writes this.lastText — a peer's ask (or a fork) can be in
  // flight while this agent's own run() is going, and the scheduler reads run()'s output via
  // `output`. inFlightCount is a counter precisely so these can overlap.
  private async subLoop(
    prompt: string,
    o: { kind: SessionKind; maxTurns: number; askDepth: number; forkDepth: number; parentSessionId?: string },
  ): Promise<string> {
    const id = this.config.id;
    const allowed = this.config.allowedTools ?? [];
    const turns: Turn[] = [];
    const sessionId = this.store?.createSession({
      agentId: id,
      kind: o.kind,
      provider: this.config.provider,
      model: this.config.model,
      parentSessionId: o.parentSessionId,
    });
    const ctx: LoopCtx = { askDepth: o.askDepth, forkDepth: o.forkDepth, sessionId };
    this.push(turns, { role: "user", text: prompt }, sessionId);
    const onDelta = (text: string) => this.bus.publish({ agentId: id, type: "delta", payload: text, time: Date.now() });
    this.inFlightCount++;
    try {
      let text = "";
      for (let i = 0; i < o.maxTurns; i++) {
        this.injectInbox(turns, sessionId);
        const reply = await this.provider.send(this.config.systemPrompt, turns, this.buildTools(allowed, ctx), onDelta);
        if (reply.text) text = reply.text;
        if (reply.usage) this.usageTracker?.record(id, reply.usage.inputTokens, reply.usage.outputTokens);
        if (reply.toolCalls.length === 0) {
          if (reply.text) this.push(turns, { role: "assistant", text: reply.text, toolCalls: [], raw: reply.raw }, sessionId, reply.usage);
          break;
        }
        this.push(turns, { role: "assistant", text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw }, sessionId, reply.usage);
        const results: ToolResult[] = [];
        for (const call of reply.toolCalls) results.push({ id: call.id, name: call.name, output: await this.execTool(call, allowed, ctx) });
        this.push(turns, { role: "tool", results }, sessionId);
      }
      if (sessionId) this.store?.setStatus(sessionId, "done");
      return text || "(no answer)";
    } catch (err) {
      if (sessionId) this.store?.setStatus(sessionId, "failed");
      return `${o.kind === "fork" ? "fork failed" : "error answering"}: ${summarizeError(err)}`;
    } finally {
      this.inFlightCount--;
    }
  }

  // Raw single call, no tools/events — used by the orchestrator to plan and to integrate.
  async ask(prompt: string): Promise<string> {
    const reply = await this.provider.send(this.config.systemPrompt, [{ role: "user", text: prompt }], []);
    return reply.text;
  }

  // Repoint this agent's sandbox root (worktree isolation) — a plain field, same shape as
  // reconfigure(). The caller (Engine) only calls this between runs, never mid-flight.
  setRoot(path: string): void {
    this.root = path;
  }

  // Swap this agent's provider/model live (used by the interactive model selector).
  reconfigure(providerName: string, model: string, provider: Provider, baseURL?: string): void {
    this.config.provider = providerName;
    this.config.model = model;
    this.config.baseURL = baseURL;
    this.provider = provider;
  }

  // Every turn the loop appends goes through here: the in-memory array still drives the model call;
  // the store append is a side-effect mirror (no session → no mirror, behaviour identical to before).
  private push(turns: Turn[], turn: Turn, sessionId?: string, usage?: Usage): void {
    turns.push(turn);
    if (sessionId) this.store?.appendMessage(sessionId, turn.role, toParts(turn), usage);
  }

  // Drain the inbox and inject any teammate messages as a user turn so the model reads and can reply.
  private injectInbox(turns: Turn[], sessionId?: string): void {
    if (!this.messenger) return;
    const inbox = this.messenger.inbox(this.config.id);
    if (!inbox.length) return;
    const text = inbox.map((m) => `[from ${m.from} · ${m.kind}] ${m.subject}\n${m.body}`).join("\n\n");
    this.push(turns, { role: "user", text: `Messages from teammates:\n\n${text}` }, sessionId);
    this.bus.publish({ agentId: this.config.id, type: "thought", payload: `received ${inbox.length} message(s)`, time: Date.now() });
  }

  // Tool specs offered to the model: sandbox tools + MCP tools + (when a messenger is wired and
  // peers exist) the coordination tools. ask_agent disappears once the ask-depth cap is reached.
  private buildTools(allowed: string[], ctx: LoopCtx): ToolSpec[] {
    // Three independent tool sources, concatenated: the sandbox, MCP servers, and LSP servers.
    // Adding LSP takes nothing away from MCP — both are live for every agent at once.
    const specs = [...toolSpecs(allowed), ...(this.mcp?.toolSpecs() ?? []), ...lspToolSpecs(this.lsp)];
    if (ctx.forkDepth < MAX_FORK_DEPTH) {
      specs.push({
        name: "spawn_fork",
        description:
          "Delegate one self-contained sub-goal to a copy of yourself and get its findings back. Use it to explore or verify something without filling this conversation with the details. It has your tools and permissions, and cannot see this conversation — state the goal in full.",
        parameters: { type: "object", properties: { goal: { type: "string" } }, required: ["goal"] },
      });
    }
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
    if (ctx.askDepth < MAX_ASK_DEPTH) {
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
  private async execTool(call: ToolCall, allowed: string[], ctx: LoopCtx): Promise<string> {
    const id = this.config.id;
    const sessionId = ctx.sessionId;
    this.bus.publish({ agentId: id, type: "tool_call", payload: `${call.name} ${JSON.stringify(call.input)}`.slice(0, 180), time: Date.now() });

    // Internal coordination tools: not sandboxed and not approval-gated (whatever the fork or the
    // peer then does goes through these same gates on its own).
    if (call.name === "spawn_fork") return this.fork(String(call.input.goal ?? ""), ctx);
    if (MESSAGING_TOOLS.has(call.name) && this.messenger) {
      return this.execMessaging(call, ctx);
    }

    const isMcp = this.mcp?.has(call.name) ?? false;
    const dangerous = isDangerousShellCall(call.name, call.input); // always prompts, even with a standing grant
    // The file as it stands right now — used for the approval diff and, once approved, the undo
    // checkpoint. Read once: re-reading after the prompt would race the user's own edits.
    const before = WRITE_TOOLS.has(call.name) ? await this.readForCheckpoint(String(call.input.path ?? "")) : undefined;
    if (call.name === "edit" && before) {
      // Additive: the TUI/dashboard render input.diff when it's there, and fall back to the raw
      // input display when it isn't.
      call.input.diff = editDiff(before, String(call.input.oldString ?? ""), String(call.input.newString ?? ""));
    }
    // agent config → project config (+ --auto) → built-in defaults → "ask".
    const decision = resolvePermission([this.config.permissions, ...this.permissionLayers, DEFAULT_RULES], call.name, call.input);
    // A deny is policy, not a question: it short-circuits without queuing an approval, and it holds
    // in headless mode too (where there is no approver and everything else would just run).
    if (decision === "deny") {
      this.bus.publish({ agentId: id, type: "error", payload: `${call.name}: denied by permission policy`, time: Date.now() });
      return "denied by permission policy";
    }
    const mustAsk = dangerous || decision !== "allow"; // a config `allow` can never downgrade a dangerous command
    if (this.approve && mustAsk && !(await this.approve(call.name, call.input, dangerous))) {
      this.bus.publish({ agentId: id, type: "error", payload: `${call.name}: denied by user`, time: Date.now() });
      return "denied by user";
    }
    try {
      let output: string;
      if (isMcp) {
        output = await this.mcp!.call(call.name, call.input);
      } else if (LSP_TOOLS.has(call.name) && this.lsp) {
        output = await runLspTool(this.lsp, call.name, call.input, this.root);
      } else {
        const sandboxCall = toSandboxCall(call);
        const lockPath =
          WRITE_TOOLS.has(sandboxCall.tool) && "path" in sandboxCall ? sandboxCall.path : sandboxCall.tool === "shell" ? SHELL_LOCK : undefined;
        if (lockPath && this.locks) await this.locks.acquire(lockPath, id);
        try {
          // Checkpoint under the lock and after approval: the write is next, so nothing can slip
          // in between the snapshot and the change it's meant to undo.
          if (lockPath && lockPath !== SHELL_LOCK) {
            if (sessionId) this.store?.checkpoint(sessionId, safePath(this.root, lockPath), before ?? null);
            this.onWrite?.(lockPath); // the watcher must not report our own write as an external change
          }
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

  // Current file contents, or undefined when the file doesn't exist yet / the path is invalid —
  // an unreadable file simply means "no before state", never a failed tool call.
  private async readForCheckpoint(path: string): Promise<string | undefined> {
    if (!path) return undefined;
    try {
      return await readFile(safePath(this.root, path), "utf8");
    } catch {
      return undefined;
    }
  }

  private async execMessaging(call: ToolCall, ctx: LoopCtx): Promise<string> {
    const m = this.messenger!;
    const to = String(call.input.to ?? "");
    if (call.name === "send_message") {
      const kind = (["handoff", "artifact", "review", "broadcast"].includes(String(call.input.kind)) ? call.input.kind : "handoff") as MessageKind;
      return m.send(this.config.id, to, kind, String(call.input.subject ?? ""), String(call.input.body ?? ""), undefined, ctx.sessionId);
    }
    // ask_agent
    if (ctx.askDepth + 1 > MAX_ASK_DEPTH) return "ask-depth limit reached — answer from what you already know.";
    return m.ask(this.config.id, to, String(call.input.question ?? ""), ctx.askDepth + 1, ctx.sessionId);
  }
}
