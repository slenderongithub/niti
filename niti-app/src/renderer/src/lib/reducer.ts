import { describeCall, noteFor, parseCall, truncate, type NoteTone } from "./humanize";
import { agentAvatar, agentColor, type AgentStatus } from "./identity";
import type {
  AcceptCheck,
  AgentConfig,
  AgentEvent,
  AgentMessage,
  AgentUsage,
  ApprovalRequest,
  AwakeState,
  DownloadProgress,
  RuntimeStatus,
  GoalStatus,
  RemoteState,
  HunkLine,
  OrchestrationEvent,
  RateLimitSnapshot,
  ServerEvent,
  SessionInfo,
  Task,
  Todo,
  Totals,
  TurnSummary,
} from "./types";

// The session as the app shows it: niti-core's event stream folded into per-agent transcripts,
// the task board, usage, approvals and the activity feed. A port of the TUI's reducer
// (tui/internal/session/session.go:853-1098) that keeps *structure* instead of styled lines — a
// tool call stays a tool call, a diff stays hunks — so the UI can render and animate each kind.
//
// Pure and immutable at the edges: applyEvents returns a new state object, replacing only what an
// event touched, so React re-renders exactly the agents and panels that changed.

export type Item =
  | { id: number; kind: "text"; text: string; streaming: boolean; time: number }
  | {
      id: number;
      kind: "tool";
      callId?: string;
      tool: string;
      verb: string;
      target: string;
      status: "running" | "ok" | "fail";
      startedAt: number;
      durationMs?: number;
      live?: string[];
      outcome?: string;
      error?: string;
    }
  | {
      id: number;
      kind: "shell";
      callId?: string;
      command: string;
      ok: boolean;
      durationMs: number;
      outcome?: string;
      body: string[];
      lines: number;
      exitCode?: number;
    }
  | {
      id: number;
      kind: "diff";
      callId?: string;
      path: string;
      created: boolean;
      added: number;
      removed: number;
      hunks: { lines: HunkLine[] }[];
      more: number;
      durationMs?: number;
      time: number;
    }
  | { id: number; kind: "note"; tone: NoteTone; text: string; keyError?: boolean; time: number }
  | { id: number; kind: "plan-done"; steps: number }
  | { id: number; kind: "checks"; checks: AcceptCheck[]; time: number };

export interface AgentView {
  id: string;
  index: number;
  cfg: AgentConfig;
  color: string;
  avatar: string;
  status: AgentStatus;
  activity: string;
  usage: AgentUsage;
  ctxLimit: number;
  items: Item[];
  todos: Todo[] | null;
  lastActive: number;
}

type FeedInput =
  | { kind: "message"; message: AgentMessage; time: number }
  | { kind: "event"; text: string; tone: "handoff" | "review" | "replan" | "integrate" | "info"; time: number };
export type FeedItem = FeedInput & { id: number };

export interface SessionState {
  ready: boolean;
  root: string;
  agents: Record<string, AgentView>;
  order: string[];
  leadId?: string;
  tasks: Task[];
  goal: string;
  active: boolean;
  awake: AwakeState; // /awake — the status-bar chip
  goalStatus: GoalStatus | null; // /goal — the status-bar chip, and where the composer sends text while it is live
  remote: RemoteState | null; // remote control — the status-bar chip
  // Local models: downloads in flight (and how each ended), and what the runtime has loaded.
  local: { downloads: Record<string, DownloadProgress>; runtime: Record<string, RuntimeStatus> };
  progress: number;
  status: string;
  plannedGoal: string; // the goal last planned in Plan mode: sending it in Build runs that plan
  messages: AgentMessage[];
  feed: FeedItem[];
  approvals: ApprovalRequest[];
  totals: Totals;
  cost: number;
  costKnown: boolean;
  rateLimits: RateLimitSnapshot[];
  summary: TurnSummary | null;
  runs: (TurnSummary & { at: number })[];
  touched: Record<string, "R" | "M" | "A">;
  locks: Record<string, string>; // project-relative path → agent holding its write lock
  changedLines: Record<string, number[]>;
  connection: "online" | "lost";
  missed: number;
  fileEpoch: number; // bumps on any file change: the graph and file views refetch on it
  system: Item[]; // orchestrator/system notes (run failures, sandbox warnings)
  lastSeq: number;
  nextId: number;
  runStartedAt: number;
}

const ITEM_MAX = 800;
const FEED_MAX = 300;
const DEFAULT_CTX = 128_000;
const zeroUsage = (): AgentUsage => ({ inputTokens: 0, outputTokens: 0, calls: 0, lastInput: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });

export function emptyState(): SessionState {
  return {
    ready: false,
    root: "",
    agents: {},
    order: [],
    tasks: [],
    goal: "",
    active: false,
    awake: "off",
    goalStatus: null,
    remote: null,
    local: { downloads: {}, runtime: {} },
    progress: 0,
    status: "",
    plannedGoal: "",
    messages: [],
    feed: [],
    approvals: [],
    totals: { inputTokens: 0, outputTokens: 0, calls: 0 },
    cost: 0,
    costKnown: true,
    rateLimits: [],
    summary: null,
    runs: [],
    touched: {},
    locks: {},
    changedLines: {},
    connection: "online",
    missed: 0,
    fileEpoch: 0,
    system: [],
    lastSeq: 0,
    nextId: 1,
    runStartedAt: 0,
  };
}

export function fromSession(info: SessionInfo, prev?: SessionState): SessionState {
  const s = emptyState();
  s.ready = true;
  s.root = info.root;
  s.lastSeq = info.lastSeq;
  s.active = info.running;
  s.awake = info.awake ?? "off";
  s.goalStatus = info.goal ?? null;
  s.remote = info.remote ?? null;
  s.tasks = info.tasks ?? [];
  info.agents.forEach((cfg, i) => {
    const old = prev?.agents[cfg.id];
    s.agents[cfg.id] = {
      id: cfg.id,
      index: i,
      cfg,
      color: agentColor(i),
      avatar: agentAvatar(i),
      status: old?.status ?? "idle",
      activity: old?.activity ?? "",
      usage: old?.usage ?? zeroUsage(),
      ctxLimit: info.contextLimits?.[cfg.id] || DEFAULT_CTX,
      items: old?.items ?? [],
      todos: old?.todos ?? null,
      lastActive: old?.lastActive ?? 0,
    };
    s.order.push(cfg.id);
  });
  s.leadId = info.agents.find((a) => a.lead)?.id ?? info.agents[0]?.id;
  if (prev) {
    // A re-fetch of /session (model switch, settings) keeps everything the stream already built.
    for (const k of ["messages", "feed", "approvals", "totals", "cost", "costKnown", "rateLimits", "summary", "runs", "touched", "changedLines", "system", "goal", "plannedGoal", "progress", "status", "nextId", "fileEpoch", "runStartedAt"] as const) {
      (s as unknown as Record<string, unknown>)[k] = prev[k];
    }
    s.lastSeq = Math.max(prev.lastSeq, info.lastSeq);
  }
  return s;
}

// ---------------------------------------------------------------------------------------------

function capItems(items: Item[]): Item[] {
  return items.length > ITEM_MAX ? items.slice(items.length - ITEM_MAX) : items;
}

class Draft {
  s: SessionState;
  private agentsCopied = false;
  private touchedAgents = new Set<string>();
  constructor(prev: SessionState) {
    this.s = { ...prev };
  }
  id(): number {
    return this.s.nextId++;
  }
  agent(id: string): AgentView | undefined {
    const a = this.s.agents[id];
    if (!a) return undefined;
    if (!this.agentsCopied) {
      this.s.agents = { ...this.s.agents };
      this.agentsCopied = true;
    }
    if (!this.touchedAgents.has(id)) {
      this.touchedAgents.add(id);
      const copy = { ...a, items: [...a.items] };
      this.s.agents[id] = copy;
      return copy;
    }
    return a;
  }
  feed(item: FeedInput) {
    const next = [...this.s.feed, { ...item, id: this.id() } as FeedItem];
    this.s.feed = next.length > FEED_MAX ? next.slice(next.length - FEED_MAX) : next;
  }
}

function findTool(a: AgentView, callId?: string): number {
  for (let i = a.items.length - 1; i >= 0; i--) {
    const it = a.items[i]!;
    if (it.kind === "tool" && (callId ? it.callId === callId : it.status === "running")) return i;
  }
  return -1;
}

function closeStreaming(a: AgentView) {
  const last = a.items[a.items.length - 1];
  if (last?.kind === "text" && last.streaming) a.items[a.items.length - 1] = { ...last, streaming: false };
}

// Running tools the agent has moved past are done — the core sends no end for some calls on older
// versions, and nothing may spin forever.
function settleRunning(a: AgentView, time: number, except?: string) {
  for (let i = a.items.length - 1; i >= Math.max(0, a.items.length - 20); i--) {
    const it = a.items[i]!;
    if (it.kind === "tool" && it.status === "running" && it.callId !== except) {
      a.items[i] = { ...it, status: "ok", durationMs: it.durationMs ?? Math.max(0, time - it.startedAt), live: undefined };
    }
  }
}

function isCreate(ae: AgentEvent): boolean {
  const first = ae.hunks?.[0]?.lines?.[0];
  return (ae.removed ?? 0) === 0 && !!first && first.k === "+" && (first.o ?? 0) === 0;
}

function markTouched(d: Draft, path: string, kind: "R" | "M" | "A") {
  const p = path.replace(/^\.\//, "");
  const cur = d.s.touched[p];
  if (cur === "A" || (cur === "M" && kind === "R")) return; // created stays created; a read never downgrades an edit
  d.s.touched = { ...d.s.touched, [p]: kind };
}

function noteChangedLines(d: Draft, ae: AgentEvent) {
  if (!ae.path || !ae.hunks) return;
  const set = new Set(d.s.changedLines[ae.path] ?? []);
  for (const h of ae.hunks) for (const l of h.lines) if (l.k === "+" && l.n) set.add(l.n);
  d.s.changedLines = { ...d.s.changedLines, [ae.path]: [...set].sort((x, y) => x - y) };
}

function applyAgentEvent(d: Draft, ae: AgentEvent) {
  if (ae.type === "external_change") {
    d.s.fileEpoch++;
    return;
  }
  if (ae.agentId === "orchestrator" || ae.agentId === "system" || !d.s.agents[ae.agentId]) {
    const n = noteFor(ae.type, ae.payload);
    if (n && (ae.type === "error" || ae.type === "warning")) {
      const next = [...d.s.system, { id: d.id(), kind: "note" as const, ...n, time: ae.time }];
      d.s.system = next.slice(-50);
    }
    return;
  }
  const a = d.agent(ae.agentId)!;
  a.lastActive = ae.time;

  // Live-view events first: they carry their own detail and don't mean "the agent moved on".
  if (ae.type === "tool_output") {
    const i = findTool(a, ae.callId);
    if (i >= 0) a.items[i] = { ...(a.items[i] as Extract<Item, { kind: "tool" }>), live: ae.payload.split("\n") };
    return;
  }
  if (ae.type === "todo") {
    const todos = ae.todos ?? [];
    const done = todos.filter((t) => t.status === "done").length;
    if (!todos.length) a.todos = null;
    else if (done === todos.length) {
      a.todos = null;
      a.items.push({ id: d.id(), kind: "plan-done", steps: todos.length });
    } else a.todos = todos;
    return;
  }
  if (ae.type === "tool_end") {
    const i = findTool(a, ae.callId);
    if (i >= 0) {
      const it = a.items[i] as Extract<Item, { kind: "tool" }>;
      a.items[i] = { ...it, status: ae.ok === false ? "fail" : "ok", durationMs: ae.durationMs ?? it.durationMs, live: undefined };
    }
    return;
  }

  // A tool call starting.
  if (ae.type === "tool_call" && ae.phase !== "end") {
    const { name, args } = parseCall(ae.payload);
    const tool = ae.tool ?? name;
    if (tool === "todo") return; // the checklist itself is the news
    if (a.status !== "done" && a.status !== "failed") a.status = "working";
    closeStreaming(a);
    settleRunning(a, ae.time, ae.callId);
    const { verb, target } = describeCall(tool, args);
    if (tool === "read_file" && target) markTouched(d, target, "R");
    a.items.push({ id: d.id(), kind: "tool", callId: ae.callId, tool, verb, target, status: "running", startedAt: ae.time });
    a.activity = truncate(`${verb} ${target}`.trim(), 60);
    a.items = capItems(a.items);
    return;
  }

  // A tool call ending, with its result.
  if (ae.phase === "end") {
    const i = findTool(a, ae.callId);
    const running = i >= 0 ? (a.items[i] as Extract<Item, { kind: "tool" }>) : undefined;
    if (ae.type === "file_edit" && ae.path) {
      d.s.fileEpoch++;
      if ((ae.added ?? 0) > 0 || (ae.removed ?? 0) > 0 || (ae.hunks?.length ?? 0) > 0) {
        const created = isCreate(ae);
        markTouched(d, ae.path, created ? "A" : "M");
        noteChangedLines(d, ae);
        const item: Item = {
          id: running?.id ?? d.id(),
          kind: "diff",
          callId: ae.callId,
          path: ae.path,
          created,
          added: ae.added ?? 0,
          removed: ae.removed ?? 0,
          hunks: ae.hunks ?? [],
          more: ae.more ?? 0,
          durationMs: ae.durationMs,
          time: ae.time,
        };
        if (i >= 0) a.items[i] = item;
        else a.items.push(item);
        a.activity = truncate(`${created ? "Created" : "Updated"} ${ae.path}`, 60);
        return;
      }
      // A rewind/restore: a file changed without a diff — say so plainly.
      markTouched(d, ae.path, "M");
      const text = ae.payload.replace(/^\S+ → /, "");
      if (i >= 0) a.items[i] = { ...running!, status: "ok", durationMs: ae.durationMs, outcome: text };
      else a.items.push({ id: d.id(), kind: "note", tone: "info", text, time: ae.time });
      return;
    }
    if (ae.tool === "shell" || running?.tool === "shell") {
      const item: Item = {
        id: running?.id ?? d.id(),
        kind: "shell",
        callId: ae.callId,
        command: running?.target || "command",
        ok: ae.type !== "error" && ae.ok !== false,
        durationMs: ae.durationMs ?? 0,
        outcome: ae.outcome,
        body: ae.body ?? ae.head ?? [],
        lines: ae.lines ?? 0,
        exitCode: ae.exitCode,
      };
      if (i >= 0) a.items[i] = item;
      else a.items.push(item);
      if (ae.type === "error") a.status = "failed";
      return;
    }
    if (ae.type === "error") {
      const n = noteFor("error", ae.payload);
      if (running) a.items[i] = { ...running, status: "fail", durationMs: ae.durationMs, error: n?.text ?? ae.payload, live: undefined };
      else if (n) a.items.push({ id: d.id(), kind: "note", ...n, time: ae.time });
      a.status = "failed";
      return;
    }
    if (running) a.items[i] = { ...running, status: ae.ok === false ? "fail" : "ok", durationMs: ae.durationMs, outcome: ae.outcome, live: undefined };
    return;
  }

  // Everything else: status, streamed text, discrete notes.
  switch (ae.type) {
    case "delta":
    case "message":
    case "thought":
      if (a.status !== "done" && a.status !== "failed") a.status = "working";
      break;
    case "done":
      if (a.status === "working") a.status = "idle";
      break;
    case "error":
      a.status = "failed";
      break;
  }
  if (ae.type !== "delta") settleRunning(a, ae.time);

  if (ae.type === "delta") {
    const last = a.items[a.items.length - 1];
    if (last?.kind === "text" && last.streaming) a.items[a.items.length - 1] = { ...last, text: last.text + ae.payload };
    else a.items.push({ id: d.id(), kind: "text", text: ae.payload, streaming: true, time: ae.time });
    a.items = capItems(a.items);
    return;
  }
  if (ae.type === "message") {
    // The final text of a turn the deltas already streamed: replace, don't repeat.
    const last = a.items[a.items.length - 1];
    if (last?.kind === "text" && last.streaming) a.items[a.items.length - 1] = { ...last, text: ae.payload, streaming: false };
    else if (ae.payload.startsWith("[from user] ")) a.items.push({ id: d.id(), kind: "note", tone: "user", text: ae.payload.slice(12), time: ae.time });
    else if (ae.payload.trim()) a.items.push({ id: d.id(), kind: "text", text: ae.payload, streaming: false, time: ae.time });
    const firstLine = ae.payload.split("\n").find((l) => l.trim()) ?? "";
    if (firstLine) a.activity = truncate(firstLine.replace(/[#*`]/g, "").trim(), 60);
    a.items = capItems(a.items);
    return;
  }
  if (ae.type === "done") {
    closeStreaming(a);
    return;
  }
  closeStreaming(a);
  // niti's acceptance checks on a local agent's work: a checklist card, not a line of text.
  if (ae.protocol === "checks" && ae.checks?.length) {
    a.items.push({ id: d.id(), kind: "checks", checks: ae.checks, time: ae.time });
    const failing = ae.checks.filter((c) => !c.ok).length;
    a.activity = failing ? `${failing} check${failing > 1 ? "s" : ""} to fix` : "checks pass";
    a.items = capItems(a.items);
    return;
  }
  const n = noteFor(ae.type, ae.payload);
  if (!n) return;
  a.items.push({ id: d.id(), kind: "note", ...n, time: ae.time });
  a.activity = truncate(n.text, 60);
  if (ae.type === "file_edit" && ae.path) {
    markTouched(d, ae.path, "M");
    d.s.fileEpoch++;
  }
  a.items = capItems(a.items);
}

function setTask(d: Draft, id: string, status: Task["status"], patch: Partial<Task> = {}) {
  d.s.tasks = d.s.tasks.map((t) => (t.id === id ? { ...t, ...patch, status } : t));
}

function applyOrch(d: Draft, oe: OrchestrationEvent) {
  switch (oe.type) {
    case "plan":
      d.s.tasks = oe.tasks.map((t) => ({ id: t.id, description: t.description, assignedTo: t.role, role: t.role, status: "pending", dependsOn: t.dependsOn }));
      if (oe.goal) d.s.goal = oe.goal;
      break;
    case "task_started": {
      setTask(d, oe.taskId, "in_progress", { assignedTo: oe.role });
      const a = d.agent(oe.role);
      if (a) a.status = "working";
      break;
    }
    case "task_done": {
      setTask(d, oe.taskId, oe.ok ? "done" : "failed");
      const a = d.agent(oe.role);
      if (a) a.status = "idle";
      if (oe.total > 0) d.s.progress = Math.round((oe.completed * 100) / oe.total);
      break;
    }
    case "reassign":
      setTask(d, oe.taskId, d.s.tasks.find((t) => t.id === oe.taskId)?.status ?? "pending", { assignedTo: oe.role, role: oe.role });
      d.feed({ kind: "event", tone: "info", text: `${oe.taskId} reassigned to ${oe.role}`, time: oe.time });
      break;
    case "handoff":
      d.feed({ kind: "event", tone: "handoff", text: `${oe.from} hands off ${oe.taskId} → ${oe.to.join(", ")}`, time: oe.time });
      break;
    case "review":
      d.feed({
        kind: "event",
        tone: "review",
        text: oe.phase === "requested" ? `${oe.reviewer} reviews ${oe.taskId}` : oe.phase === "approved" ? `${oe.reviewer} approved ${oe.taskId}` : `${oe.reviewer} requested changes on ${oe.taskId}`,
        time: oe.time,
      });
      break;
    case "replan":
      d.feed({ kind: "event", tone: "replan", text: `orchestrator replans ${oe.taskId}: ${oe.action}${oe.reason ? ` — ${truncate(oe.reason, 80)}` : ""}`, time: oe.time });
      break;
    case "integrate":
      d.feed({ kind: "event", tone: "integrate", text: `orchestrator: ${truncate(oe.summary, 120)}`, time: oe.time });
      break;
    case "complete":
      d.s.progress = oe.total > 0 ? Math.round((oe.completed * 100) / oe.total) : 100;
      if (oe.cancelled) d.s.status = `cancelled — ${oe.completed}/${oe.total} tasks done`;
      else if (oe.completed < oe.total) d.s.status = `finished with ${oe.completed} of ${oe.total} tasks done`;
      break;
  }
}

function resetSession(d: Draft) {
  const agents: Record<string, AgentView> = {};
  for (const id of d.s.order) {
    const a = d.s.agents[id]!;
    agents[id] = { ...a, status: "idle", activity: "", usage: zeroUsage(), items: [], todos: null };
  }
  const keep = d.s;
  d.s = { ...emptyState(), ready: true, root: keep.root, agents, order: keep.order, leadId: keep.leadId, lastSeq: keep.lastSeq, nextId: keep.nextId, fileEpoch: keep.fileEpoch + 1, awake: keep.awake, goalStatus: keep.goalStatus, remote: keep.remote, local: keep.local, status: "session cleared" }; // /clear wipes the transcript, not the Mac's sleep state
}

function applyEvent(d: Draft, e: ServerEvent) {
  if (typeof e.seq === "number" && e.kind !== "connection" && e.kind !== "resync") d.s.lastSeq = Math.max(d.s.lastSeq, e.seq);
  switch (e.kind) {
    case "agent_event":
      applyAgentEvent(d, e.event);
      break;
    case "orchestration":
      applyOrch(d, e.event);
      break;
    case "agent_message": {
      const next = [...d.s.messages, e.message];
      d.s.messages = next.length > FEED_MAX ? next.slice(next.length - FEED_MAX) : next;
      d.feed({ kind: "message", message: e.message, time: e.message.time });
      break;
    }
    case "usage": {
      d.s.totals = e.totals;
      d.s.cost = e.cost;
      d.s.costKnown = e.costKnown;
      d.s.rateLimits = e.rateLimits ?? [];
      for (const u of e.agents) {
        const a = d.agent(u.agentId);
        if (a) a.usage = { ...zeroUsage(), ...u.usage };
      }
      break;
    }
    case "approval_request":
      d.s.approvals = e.requests;
      break;
    case "session":
      d.s.active = e.state === "started";
      if (e.state === "started") {
        d.s.goal = e.goal ?? d.s.goal;
        d.s.progress = 0;
        d.s.status = "running";
        d.s.summary = null;
        d.s.runStartedAt = e.time;
      } else if (e.state === "ended") {
        d.s.progress = 100;
        d.s.status = d.s.status.startsWith("finished with") || d.s.status.startsWith("cancelled") ? d.s.status : "done";
        if (d.s.goalStatus?.state === "running") d.s.status = `goal round ${d.s.goalStatus.round} done — starting the next`;
        for (const id of d.s.order) {
          const cur = d.s.agents[id]!;
          if (cur.status === "working" || cur.items.some((it) => it.kind === "tool" && it.status === "running") || cur.items[cur.items.length - 1]?.kind === "text") {
            const a = d.agent(id)!;
            if (a.status === "working") a.status = "idle";
            closeStreaming(a);
            settleRunning(a, e.time);
          }
        }
      } else if (e.state === "cancelled") {
        d.s.status = "cancelled";
      }
      break;
    case "turn_summary": {
      const { kind: _k, seq: _s, time, ...summary } = e;
      d.s.summary = summary;
      d.s.runs = [...d.s.runs, { ...summary, at: time }].slice(-100);
      break;
    }
    case "session_reset":
      resetSession(d);
      break;
    case "resync":
      d.s.missed = e.missed;
      d.s.status = `reconnected, but ${e.missed} events were lost while away — output may be incomplete`;
      break;
    case "connection":
      d.s.connection = e.state === "lost" ? "lost" : "online";
      d.s.status = e.state === "lost" ? "lost the core — reconnecting…" : "reconnected";
      break;
    case "lock": {
      const pre = d.s.root.endsWith("/") ? d.s.root : `${d.s.root}/`;
      const locks: Record<string, string> = {};
      for (const h of e.holders ?? []) if (h.path.startsWith(pre)) locks[h.path.slice(pre.length)] = h.holder;
      d.s.locks = locks;
      break;
    }
    case "awake":
      d.s.awake = e.state;
      break;
    case "goal":
      d.s.goalStatus = e.status;
      break;
    case "remote":
      d.s.remote = e.remote;
      break;
    case "local_download":
      d.s.local = { ...d.s.local, downloads: { ...d.s.local.downloads, [e.download.id]: e.download } };
      break;
    case "local_runtime":
      d.s.local = { ...d.s.local, runtime: { ...d.s.local.runtime, [e.runtime.model]: e.runtime } };
      break;
    case "theme":
      break;
  }
}

export function applyEvents(prev: SessionState, events: ServerEvent[]): SessionState {
  if (!events.length) return prev;
  const d = new Draft(prev);
  for (const e of events) applyEvent(d, e);
  return d.s;
}

// --- derived helpers the UI shares -------------------------------------------------------------

// Where a message typed mid-run goes when the user hasn't picked: the TUI's steerTarget rule
// (interact.go:24-37) — the focused agent if it's working, else the first working one, else the lead.
export function steerTarget(s: SessionState, focused?: string): string | undefined {
  if (focused && s.agents[focused]?.status === "working") return focused;
  const working = s.order.find((id) => s.agents[id]?.status === "working");
  return working ?? s.leadId ?? s.order[0];
}

export function workingAgents(s: SessionState): string[] {
  return s.order.filter((id) => s.agents[id]?.status === "working");
}

// The agent nearest its context limit, for the header's ctx meter.
export function deepestContext(s: SessionState): { id: string; pct: number } | undefined {
  let best: { id: string; pct: number } | undefined;
  for (const id of s.order) {
    const a = s.agents[id]!;
    const pct = a.ctxLimit ? Math.min(100, Math.round((a.usage.lastInput * 100) / a.ctxLimit)) : 0;
    if (!best || pct > best.pct) best = { id, pct };
  }
  return best;
}

export function taskCounts(tasks: Task[]) {
  const c = { total: tasks.length, done: 0, running: 0, failed: 0, pending: 0 };
  for (const t of tasks) {
    if (t.status === "done") c.done++;
    else if (t.status === "in_progress") c.running++;
    else if (t.status === "failed") c.failed++;
    else c.pending++;
  }
  return c;
}

// Render-time grouping: a run of finished, same-verb, non-edit tool calls reads as one line
// ("Read 3 files"), the TUI's collapsed view. Running calls, failures, diffs and shells stay single.
export type RenderItem = Item | { kind: "group"; id: number; verb: string; items: Extract<Item, { kind: "tool" }>[]; durationMs: number };

const GROUPABLE = new Set(["Read", "List", "Find", "Search", "Inspect", "Check", "Recall", "Remember"]);

export function groupItems(items: Item[]): RenderItem[] {
  const out: RenderItem[] = [];
  for (const it of items) {
    if (it.kind === "tool" && it.status === "ok" && GROUPABLE.has(it.verb)) {
      const prev = out[out.length - 1];
      if (prev && prev.kind === "group" && prev.verb === it.verb) {
        prev.items.push(it);
        prev.durationMs += it.durationMs ?? 0;
        continue;
      }
      if (prev && prev.kind === "tool" && prev.status === "ok" && prev.verb === it.verb) {
        out[out.length - 1] = { kind: "group", id: prev.id, verb: it.verb, items: [prev, it], durationMs: (prev.durationMs ?? 0) + (it.durationMs ?? 0) };
        continue;
      }
    }
    out.push(it);
  }
  return out;
}


