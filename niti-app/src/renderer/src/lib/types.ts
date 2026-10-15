// The niti-core client contract, mirrored from the engine (src/server/events.ts, src/events/bus.ts,
// src/orchestrator/*, src/usage.ts) the way the Go TUI mirrors it in tui/internal/api/client.go.
// Mirrored rather than imported: the app must build against an installed core, not a checkout.

export interface AgentConfig {
  id: string;
  provider: string;
  model: string;
  role: string;
  systemPrompt: string;
  allowedTools?: string[];
  lead?: boolean;
  reviewer?: string;
  baseURL?: string;
  autoApprove?: string[];
  permissions?: unknown;
  reasoning?: unknown;
  maxOutput?: number;
  editFormat?: "hashline"; // anchored edits (src/agent/agent.ts AgentConfig.editFormat)
}

export type TaskStatus = "pending" | "in_progress" | "done" | "failed";

export interface Task {
  id: string;
  description: string;
  assignedTo?: string;
  status: TaskStatus;
  attempts?: number;
  role?: string;
  dependsOn?: string[];
  handoffTo?: string[];
  acceptance?: string;
  output?: string;
}

export interface Prefs {
  lightMode: boolean;
  reduceMotion: boolean;
  showTurnDuration: boolean;
  openAgentsView: boolean;
  projectInstructions: boolean;
  notifyOnDone: boolean;
}

interface EngineSettings {
  autoCompact: boolean;
  thinkingMode: boolean;
}

export interface SessionInfo {
  agents: AgentConfig[];
  tasks: Task[];
  lastSeq: number;
  running: boolean;
  root: string;
  lsp: { name: string; command: string; extensions: string[]; running: boolean }[];
  mcp: { name: string; tools: number }[];
  contextLimits: Record<string, number>;
  settings: EngineSettings;
  prefs: Prefs;
  auto: boolean;
  theme?: string;
  awake?: AwakeState; // absent from an older core
  goal?: GoalStatus | null; // /goal; absent from an older core
  remote?: RemoteState | null; // remote control; absent from an older core
}

// Remote control (src/remote/bridge.ts RemoteState).
export interface RemoteState {
  signedIn: boolean;
  email?: string;
  relay?: string;
  enabled: boolean;
  link: "up" | "connecting" | "off";
  phones: { id: string; name: string; online: boolean }[];
}

// /goal: the persistent objective (src/goal.ts GoalStatus).
export type GoalState = "running" | "paused" | "done" | "blocked" | "budget" | "rounds" | "stopped";
export interface GoalStatus {
  objective: string;
  state: GoalState;
  reason: string;
  round: number;
  maxRounds: number;
  used: { tokens: number; cost: number };
  budget: { tokens?: number; usd?: number };
  verdicts: { round: number; done: boolean; reason: string; next: string; changed: boolean }[];
  notes: string[];
  error: boolean;
}

// Running, or paused waiting to be resumed: the goal still holds the session.
export const goalLive = (g: GoalStatus | null | undefined): boolean => !!g && (g.state === "running" || g.state === "paused");

// /awake: "lid" = awake with the lid closed too, "open" = lid-open only (admin prompt declined).
export type AwakeState = "off" | "lid" | "open";

type AgentEventType =
  | "thought"
  | "tool_call"
  | "file_edit"
  | "delta"
  | "message"
  | "failover"
  | "warning"
  | "external_change"
  | "done"
  | "error"
  | "tool_output"
  | "tool_end"
  | "todo";

export interface HunkLine {
  k: "+" | "-" | " ";
  t: string;
  o?: number;
  n?: number;
}

export interface Todo {
  text: string;
  status: string; // pending | doing | done
}

export interface AgentEvent {
  agentId: string;
  type: AgentEventType;
  payload: string;
  time: number;
  path?: string;
  diff?: string;
  callId?: string;
  phase?: "start" | "end";
  tool?: string;
  ok?: boolean;
  durationMs?: number;
  exitCode?: number;
  outcome?: string;
  lines?: number;
  head?: string[];
  tail?: string[];
  body?: string[];
  hunks?: { lines: HunkLine[] }[];
  added?: number;
  removed?: number;
  more?: number;
  todos?: Todo[];
}

export type MessageKind = "handoff" | "question" | "answer" | "artifact" | "review" | "broadcast" | "note";

export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  kind: MessageKind;
  subject: string;
  body: string;
  refs?: string[];
  time: number;
}

export type OrchestrationEvent =
  | { type: "plan"; goal: string; tasks: { id: string; description: string; role: string; dependsOn: string[] }[]; time: number }
  | { type: "task_ready"; taskId: string; role: string; time: number }
  | { type: "task_started"; taskId: string; role: string; time: number }
  | { type: "task_done"; taskId: string; role: string; ok: boolean; completed: number; total: number; time: number }
  | { type: "handoff"; taskId: string; from: string; to: string[]; time: number }
  | { type: "replan"; taskId: string; role: string; action: "retry" | "redirect" | "inject" | "accept"; reason?: string; time: number }
  | { type: "review"; taskId: string; reviewer: string; phase: "requested" | "approved" | "changes_requested"; time: number }
  | { type: "reassign"; taskId: string; role: string; time: number }
  | { type: "integrate"; summary: string; next?: string[]; time: number }
  | { type: "complete"; completed: number; total: number; cancelled?: boolean; time: number };

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  lastInput: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface RateLimitSnapshot {
  provider: string;
  remainingTokens?: number;
  remainingRequests?: number;
}

export interface Totals {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ApprovalRequest {
  id?: number; // absent from cores that predate request ids: answers then go to the queue's front
  agentId: string;
  tool: string;
  input: Record<string, unknown>;
  dangerous?: boolean; // must be decided on its own: never part of "allow all" (absent from older cores)
}

export interface TurnSummary {
  goal: string;
  ok: boolean;
  cancelled: boolean;
  summary: string;
  next: string[];
  files: { path: string; added: number; removed: number }[];
  durationMs: number;
  tokens: number;
  cost: number;
  costKnown: boolean;
}

type ServerEventBody =
  | { kind: "agent_event"; event: AgentEvent }
  | { kind: "agent_message"; message: AgentMessage }
  | { kind: "orchestration"; event: OrchestrationEvent }
  | { kind: "usage"; agents: { agentId: string; usage: AgentUsage }[]; totals: Totals; rateLimits: RateLimitSnapshot[]; cost: number; costKnown: boolean }
  | { kind: "approval_request"; requests: ApprovalRequest[] }
  | { kind: "lock"; holders: { path: string; holder: string }[] }
  | { kind: "session"; state: "started" | "ended" | "cancelled" | "idle"; goal?: string }
  | { kind: "theme"; theme: string }
  | { kind: "awake"; state: AwakeState }
  | { kind: "goal"; status: GoalStatus | null }
  | { kind: "remote"; remote: RemoteState }
  | { kind: "session_reset" }
  | ({ kind: "turn_summary" } & TurnSummary)
  | { kind: "resync"; missed: number }
  // Synthesized by the client's SSE layer — the core never sends this.
  | { kind: "connection"; state: "lost" | "restored" };

export type ServerEvent = ServerEventBody & { seq: number; time: number };

export interface CommandInfo {
  name: string;
  description: string;
}

export interface CommandResult {
  ok: boolean;
  message: string;
  view?: string;
  error?: string;
}

export interface Stats {
  perDay: { date: string; tokens: number; msgs: number }[];
  perModel: { name: string; inTokens: number; outTokens: number; msgs: number; usd: number; priced: boolean }[];
  sessions: number;
  inTokens: number;
  outTokens: number;
  longestSessionMs: number;
  totalUsd: number;
  costComplete: boolean;
}

export interface FileGraph {
  nodes: { id: string; label: string; group: string }[];
  edges: { from: string; to: string }[];
}

export interface Providers {
  byok: { id: string; label: string }[];
  local: { id: string; label: string }[];
  login: { id: string; label: string }[];
}

export interface Credential {
  provider: string;
  type: "api" | "oauth" | "local";
}

export interface Checkpoint {
  id: number;
  path: string;
  createdAt: number;
}

export interface SessionRow {
  id: string;
  agentId: string;
  taskId?: string;
  kind: string;
  provider: string;
  model: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export type WorktreeStatus = { active: false } | { active?: undefined; path: string; branch: string; diffStat: string };
