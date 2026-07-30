# Project Context: amux

`amux` is a TypeScript CLI tool for Bun (≥ 1.3) that runs multiple AI coding agents from different LLM providers concurrently on a single project. Agents coordinate via a shared task queue, communicate through a typed event bus, execute tools inside a root-sandboxed runtime, and render live streaming feedback in a React + Ink terminal UI.

---

## (1) System Architecture

### High-Level Architecture
```
                         ┌─────────────────────────────┐
                         │   .amux/agents.yaml         │
                         │   (Agent & MCP Configs)     │
                         └──────────────┬──────────────┘
                                        │
                                        ▼
                         ┌─────────────────────────────┐
                         │   Config Loader & Factory   │
                         │ (config.ts, factory.ts)     │
                         └──────────────┬──────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             amux CLI (cli.ts)                               │
│                                                                             │
│  ┌────────────────────┐    decompose   ┌─────────────────────────────────┐  │
│  │     Lead Agent     ├───────────────►│          Orchestrator           │  │
│  └─────────┬──────────┘                │      (Shared Task Queue)        │  │
│            │                           └────────────────┬────────────────┘  │
│            │                                            │ claim / requeue   │
│            ▼                                            ▼                   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                         Concurrent Workers                           │   │
│  │                 (Worker Loops in runner.ts)                          │   │
│  └───────┬──────────────────────────────┬───────────────────────┬───────┘   │
│          │                              │                       │           │
│          ▼                              ▼                       ▼           │
│  ┌──────────────┐              ┌────────────────┐       ┌───────────────┐   │
│  │ Provider SDK │              │  Tool Sandbox  │       │  MCP Client   │   │
│  │(OpenAI/Anth/ │              │(read/write/sh) │       │ (stdio transport)│ │
│  │ Gemini/Copilot)             └───────┬────────┘       └───────┬───────┘   │
│  └───────┬──────┘                      │                        │           │
└──────────┼─────────────────────────────┼────────────────────────┼───────────┘
           │                             │                        │
           │ publish events              │ acquire locks          │ mcp tools
           ▼                             ▼                        ▼
┌──────────────────────┐      ┌────────────────────┐   ┌──────────────────────┐
│  Event Bus (bus.ts)  │      │ Lock Registry      │   │ Approval Queue       │
└──────────┬───────────┘      │ (locks.ts)         │   │ (approval.ts)        │
           │                  └────────────────────┘   └──────────┬───────────┘
           │ subscribe                                            │ prompt/approve
           ▼                                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             Ink Terminal TUI                                │
│       (App.tsx, GraphView.tsx, UsageView.tsx, ModelSelector.tsx)            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Core Architectural Concepts
1. **Concurrency & Synchronization**:
   - Work is distributed across agents via a single-threaded in-memory `Orchestrator` task queue. `claimTask` operations are synchronous and atomic under Node/Bun's event loop.
   - Concurrent writes and shell commands are synchronized via an in-memory `LockRegistry`. File writes lock per relative path; shell calls lock on a global `*shell*` mutex. Stale locks expire after 60s.
2. **Failover & Token Safeguards**:
   - When an agent encounters rate limits (429/529), context limit exhaustion, or account quota depletion, its assigned task is requeued back to the orchestrator with an exponential backoff (`attempts * 500ms`, capped at 3000ms) and same-agent exclusion.
   - Tasks are failed permanently after 3 attempts (`MAX_ATTEMPTS = 3`).
   - Context usage warnings trigger at 85% context depth; automatic conversation compacting (`compactTurns`) occurs at 95% threshold using provider-based summarization.
3. **Security Boundary & Approval Gates**:
   - `write_file` and `shell` actions require permission via `ApprovalQueue` in interactive mode.
   - Shell calls are parsed for dangerous patterns (`rm -rf`, `git reset --hard`, `git push --force`, `drop table`, fork bombs) to force interactive confirmation even if standing grants exist.
   - File system access is jailed using `safePath` prefix validation against `process.cwd()`. Shell executions use `spawn` with array arguments to prevent string injection.
4. **Provider Abstraction & Keychain Storage**:
   - Providers implement a unified `Provider` interface.
   - Primary API keys are retrieved from the OS Keychain via `@napi-rs/keyring` with environment variable fallback.
   - GitHub Copilot authentication uses OAuth device code flow (`startDeviceFlow` / `pollForToken`).

---

## (2) Key File Map & Export Responsibilities

| File Path | Primary Responsibility | Exports |
|---|---|---|
| `src/cli.ts` | Command-line entry point (`amux`, `keys`, `login`, `resume`, one-shot, interactive session) | Command runner, process lifecycle |
| `src/config/config.ts` | Validates and parses YAML config (`.amux/agents.yaml`) | `loadAgents()`, `loadMcpServers()` |
| `src/keystore/keystore.ts` | Key management using OS Keychain (`@napi-rs/keyring`) & env vars | `getKey()`, `setKey()`, `envKey()`, `envVarName()` |
| `src/events/bus.ts` | Central typed event pub/sub mechanism wrapping `node:events` | `Bus` class, `AgentEvent`, `EventType` |
| `src/orchestrator/task.ts` | Defines task state types | `Task` interface, `TaskStatus` type |
| `src/orchestrator/orchestrator.ts` | Atomic shared task queue management and failover assignment | `Orchestrator` class |
| `src/orchestrator/runner.ts` | Project decomposition and concurrent agent worker task loops | `runProject()`, `runWorker()`, `parseTaskList()` |
| `src/orchestrator/locks.ts` | Mutex lock registry for concurrent file write and shell operations | `LockRegistry` class |
| `src/agent/agent.ts` | Multi-turn agent execution loop, tool dispatch, approval & quota checks | `Agent` class, `isDangerousShellCall()`, `overContextThreshold()`, `SHELL_LOCK`, `AgentConfig`, `AgentDeps`, `RunOutcome` |
| `src/agent/context.ts` | Summarizes older conversation turns when context window fills | `compactTurns()` |
| `src/providers/provider.ts` | Core provider contract, turn definitions, and rate-limit parsing | `Provider`, `ProviderReply`, `Turn`, `ToolSpec`, `ToolCall`, `ToolResult`, `Usage`, `RateLimit`, `summarizeError()`, `parseRateLimit()` |
| `src/providers/factory.ts` | Instantiates provider instances based on agent configuration and key storage | `makeProvider()` |
| `src/providers/catalog.ts` | Static catalog of supported providers, clients, categories, & model seeds | `CATALOG`, `providerKeys()`, `providersByCategory()`, `contextWindow()`, `CatalogEntry`, `ClientKind`, `Category` |
| `src/providers/catalog.generated.ts` | Auto-generated provider definitions (via `scripts/gen-catalog.ts`) | `GENERATED_CATALOG` |
| `src/providers/openai.ts` | Provider wrapper for OpenAI and OpenAI-compatible APIs | `OpenAIProvider` class |
| `src/providers/anthropic.ts` | Provider wrapper for Anthropic SDK | `AnthropicProvider` class |
| `src/providers/gemini.ts` | Provider wrapper for Google Gemini SDK (`@google/genai`) | `GeminiProvider` class |
| `src/providers/copilot.ts` | Copilot provider wrapper and OAuth device flow logic | `CopilotProvider` class, `startDeviceFlow()`, `pollForToken()`, `DeviceCodeResponse` |
| `src/tools/tools.ts` | Sandboxed tools execution (`read_file`, `write_file`, `shell`), path safety check | `runTool()`, `toolSpecs()`, `toSandboxCall()`, `safePath()`, `ToolCall` type |
| `src/mcp/mcp.ts` | MCP client manager connecting to external stdio MCP servers | `McpManager` class, `extractText()`, `McpTools`, `McpServerConfig` |
| `src/skills/skills.ts` | Discovers `.amux/skills/*/SKILL.md` frontmatter & builds system prompt addendum | `loadSkills()`, `skillsPrompt()`, `Skill` interface |
| `src/approval.ts` | Approval queue for human-in-the-loop tool execution gating | `ApprovalQueue` class, `ApprovalRequest`, `PermissionScope`, `Approve` type |
| `src/usage.ts` | Tracks session token usage and rate limit headers | `UsageTracker` class, `AgentUsage`, `RateLimitSnapshot` |
| `src/session.ts` | Persists and reloads task session state (`.amux/session.json`) | `saveTasks()`, `loadTasks()` |
| `src/tui/App.tsx` | Main Ink terminal interface component and view router | `renderTui()`, `App` component |
| `src/tui/GraphView.tsx` | Visual task dependency tree & failover status view (`/graph`) | `GraphView` component |
| `src/tui/UsageView.tsx` | Live token and rate limit analytics dashboard (`/usage`) | `UsageView` component |
| `src/tui/ModelSelector.tsx` | Live model/provider switcher dialog (`/model`) | `ModelSelector` component |
| `src/tui/theme.ts` | Color palettes and 8-bit avatars per agent role | `themeFor()`, `AVATARS` |

---

## (3) Data Models / Schemas

### 1. Configuration Schema (`.amux/agents.yaml`)
```yaml
agents:
  - id: string               # Required. Unique agent identifier (e.g. "architect")
    provider: string         # Required. Catalog key (e.g. "anthropic", "openai", "custom")
    model: string            # Required. Model name (e.g. "claude-opus-4-8", "gpt-4o")
    role: string             # Required. Role display title (e.g. "Architect")
    systemPrompt: string     # Required. System instruction
    allowedTools: string[]   # Optional. Allowed built-in tools ("read_file" | "write_file" | "shell")
    lead: boolean            # Optional. If true, decomposes initial goal into tasks
    baseURL: string          # Optional. Custom base URL for provider: "custom" or OpenAI-compatible endpoints
    autoApprove: string[]    # Optional. Tools pre-granted for this agent

mcpServers:                  # Optional list of stdio MCP servers
  - name: string             # Required. Server identifier
    command: string          # Required. Binary/executable path
    args: string[]           # Optional. Command arguments
```

### 2. Task Model (`Task`)
```typescript
type TaskStatus = "pending" | "in_progress" | "done" | "failed";

interface Task {
  id: string;                // Formatted as "t1", "t2", etc.
  description: string;       // Subtask description
  assignedTo?: string;       // Currently assigned agent ID
  status: TaskStatus;        // Lifecycle status
  attempts?: number;         // Number of failover retries
  lastFailedBy?: string;     // Agent ID that most recently failed/exhausted this task
  availableAt?: number;      // Epoch ms timestamp before which task cannot be claimed
}
```

### 3. Event Model (`AgentEvent`)
```typescript
type EventType =
  | "thought"     // Agent status / planning log
  | "tool_call"   // Tool invocation notification
  | "file_edit"   // Successful tool execution outcome
  | "delta"       // Streaming response chunk
  | "message"     // Final agent text output
  | "failover"    // Task reassignment notification
  | "warning"     // Token limit or rate limit warning
  | "done"        // Agent task loop completed
  | "error";      // Error encountered

interface AgentEvent {
  agentId: string;
  type: EventType;
  payload: string;
  time: number;   // Epoch ms timestamp
}
```

### 4. Turn & Tool Provider Models
```typescript
type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: "tool"; results: ToolResult[] };

interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
}

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResult {
  id: string;
  name: string;
  output: string;
}

interface ProviderReply {
  text: string;
  toolCalls: ToolCall[];
  raw?: unknown;
  usage?: Usage;
  rateLimit?: RateLimit;
}
```

### 5. Session State Schema (`.amux/session.json`)
```json
{
  "tasks": [
    {
      "id": "t1",
      "description": "Add /health route",
      "assignedTo": "architect",
      "status": "done",
      "attempts": 0
    }
  ]
}
```

---

## (4) Current API Contracts

### 1. Provider Core Contract
```typescript
interface Provider {
  send(
    sysPrompt: string,
    turns: Turn[],
    tools: ToolSpec[],
    onDelta?: (text: string) => void
  ): Promise<ProviderReply>;
}
```

### 2. Orchestrator Contract
```typescript
class Orchestrator {
  addTask(description: string): Task;
  load(tasks: Task[]): void;
  clear(): void;
  claimTask(agentId: string): Task | undefined;
  complete(task: Task, ok: boolean): void;
  requeue(task: Task, agentId: string): void;
  hasUnfinished(): boolean;
  get all(): readonly Task[];
}
```

### 3. Tool Sandbox Executable Contract
```typescript
type ToolCall =
  | { tool: "read_file"; path: string }
  | { tool: "write_file"; path: string; content: string }
  | { tool: "shell"; command: string; args: string[] };

function runTool(call: ToolCall, allowed: string[], root?: string): Promise<string>;
```

### 4. MCP Tools Management Contract
```typescript
interface McpTools {
  toolSpecs(): ToolSpec[];
  has(name: string): boolean;
  call(name: string, input: Record<string, unknown>): Promise<string>;
}
```

### 5. Approval Queue Contract
```typescript
class ApprovalQueue {
  grant(agentId: string, tool: string, pathPattern?: string): void;
  isAllowed(agentId: string, tool: string, input?: Record<string, unknown>): boolean;
  request(agentId: string, tool: string, input: Record<string, unknown>, forceAsk?: boolean): Promise<boolean>;
  current(): ApprovalRequest | undefined;
  currentBatch(): readonly ApprovalRequest[] | undefined;
  answer(ok: boolean, scope?: "agent" | "path"): void;
  approveAll(): void;
  denyAll(): void;
  approveAgent(agentId: string): void;
}
```

### 6. Event Bus Contract
```typescript
class Bus {
  publish(e: AgentEvent): void;
  subscribe(fn: (e: AgentEvent) => void): () => void;
}
```

### 7. CLI Invocation Contracts
```sh
amux                         # Launches interactive session with TUI
amux "<prompt>"              # Executes one-shot task and exits
amux resume                  # Reloads prior task list from .amux/session.json
amux keys set <provider>     # Stores API key in OS keychain
amux login copilot           # Executes GitHub Copilot OAuth device code login
```

### 8. Interactive TUI Commands
- `/model`: Opens interactive modal to select agent, provider, and model live.
- `/usage`: Toggles live per-agent token consumption & rate-limit quotas view.
- `/graph`: Toggles live agent-to-task tree execution graph.
- `/clear`: Clears task list and resets task queue for fresh prompt submission.
