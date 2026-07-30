import React, { useEffect, useState } from "react";
import { Box, Text, render, useInput } from "ink";
import TextInput from "ink-text-input";
import { ModelSelector } from "./ModelSelector.tsx";
import { GraphView } from "./GraphView.tsx";
import { UsageView } from "./UsageView.tsx";
import type { UsageTracker } from "../../src/usage.ts";
import type { Bus, AgentEvent } from "../../src/events/bus.ts";
import type { Orchestrator } from "../../src/orchestrator/orchestrator.ts";
import type { AgentConfig } from "../../src/agent/agent.ts";
import type { Task } from "../../src/orchestrator/task.ts";
import type { ApprovalQueue, ApprovalRequest } from "../../src/approval.ts";
import type { LockRegistry } from "../../src/orchestrator/locks.ts";
import { loadSkills } from "../../src/skills/skills.ts";
import { theme, agentColor, agentAvatar, compactNumber } from "./theme.ts";

const SPINNER = "⠋⠙⠹⠸⠼⠦⠧⠇⠏";
const fmtElapsed = (totalSeconds: number) => `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;

const COMMANDS: { cmd: string; desc: string }[] = [
  { cmd: "/help", desc: "Show this list of commands" },
  { cmd: "/model", desc: "Switch an agent's model" },
  { cmd: "/graph", desc: "Toggle the task graph view" },
  { cmd: "/usage", desc: "Toggle usage & stats view" },
  { cmd: "/status", desc: "Show agent and task status" },
  { cmd: "/skills", desc: "List available skills" },
  { cmd: "/clear", desc: "Start a new session (clears tasks & logs)" },
  { cmd: "/exit", desc: "Exit amux" },
];

function HelpView() {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} marginTop={1} paddingX={1}>
      <Text bold>Commands (/help to toggle)</Text>
      {COMMANDS.map((c) => (
        <Text key={c.cmd}>
          <Text color={theme.info}>{c.cmd.padEnd(10)}</Text> {c.desc}
        </Text>
      ))}
    </Box>
  );
}

function StatusView({ configs, tasks }: { configs: AgentConfig[]; tasks: readonly Task[] }) {
  const counts = { pending: 0, in_progress: 0, done: 0, failed: 0 } as Record<Task["status"], number>;
  for (const t of tasks) counts[t.status]++;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} marginTop={1} paddingX={1}>
      <Text bold>Status (/status to toggle)</Text>
      {configs.map((c) => (
        <Text key={c.id} color={agentColor(configs, c.id)}>
          {agentAvatar(configs, c.id)} {c.id} · {c.provider}/{c.model}
        </Text>
      ))}
      <Text dimColor>
        tasks: {tasks.length} total · {counts.pending} pending · {counts.in_progress} running · {counts.done} done ·{" "}
        {counts.failed} failed
      </Text>
    </Box>
  );
}

function SkillsView() {
  const skills = loadSkills();
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} marginTop={1} paddingX={1}>
      <Text bold>Skills (/skills to toggle)</Text>
      {skills.length === 0 ? (
        <Text dimColor>(none — add .amux/skills/&lt;name&gt;/SKILL.md)</Text>
      ) : (
        skills.map((s) => (
          <Text key={s.name}>
            <Text color={theme.info}>{s.name}</Text> — {s.description}
          </Text>
        ))
      )}
    </Box>
  );
}

function ApprovalPrompt({ req, onAnswer }: { req: ApprovalRequest; onAnswer: (ok: boolean, scope?: "agent" | "path") => void }) {
  const dir = typeof req.input.path === "string" ? req.input.path.split("/").slice(0, -1).join("/") || "." : undefined;
  useInput((input) => {
    if (input === "y" || input === "1") onAnswer(true);
    else if (input === "a" || input === "2") onAnswer(true, "agent");
    else if (dir && (input === "p" || input === "3")) onAnswer(true, "path");
    else if (input === "n" || (dir ? input === "4" : input === "3")) onAnswer(false);
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} marginTop={1} paddingX={1}>
      <Text bold color={theme.warning}>
        {req.agentId} wants to run: {req.tool}
      </Text>
      <Text>{JSON.stringify(req.input).slice(0, 100)}</Text>
      <Text dimColor>
        [1/y] approve once · [2/a] always allow {req.tool} for {req.agentId}
        {dir ? ` · [3/p] always allow for ${dir}/**` : ""} · [{dir ? "4" : "3"}/n] deny
      </Text>
    </Box>
  );
}

// Shown instead of one-at-a-time ApprovalPrompts once 3+ requests queue within 5s (see
// ApprovalQueue.currentBatch) — otherwise a burst of parallel tool calls turns into a click treadmill.
function BatchApprovalPrompt({
  batch,
  onApproveAll,
  onApproveAgent,
  onReviewEach,
  onDenyAll,
}: {
  batch: readonly ApprovalRequest[];
  onApproveAll: () => void;
  onApproveAgent: (agentId: string) => void;
  onReviewEach: () => void;
  onDenyAll: () => void;
}) {
  const agents = [...new Set(batch.map((r) => r.agentId))];
  const options: { label: string; run: () => void }[] = [
    { label: `Approve all ${batch.length}`, run: onApproveAll },
    ...(agents.length > 1
      ? agents.map((a) => ({
          label: `Approve ${a} only (${batch.filter((r) => r.agentId === a).length})`,
          run: () => onApproveAgent(a),
        }))
      : []),
    { label: "Review each one", run: onReviewEach },
    { label: "Deny all", run: onDenyAll },
  ];
  const [i, setI] = useState(0);
  useInput((input, key) => {
    if (key.upArrow) setI((p) => (p - 1 + options.length) % options.length);
    else if (key.downArrow) setI((p) => (p + 1) % options.length);
    else if (key.return) options[i]!.run();
    else if (key.escape) onDenyAll();
    else {
      const n = Number(input);
      if (n >= 1 && n <= options.length) options[n - 1]!.run();
    }
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} marginTop={1} paddingX={1}>
      <Text bold color={theme.warning}>
        {batch.length} Approvals Queued
      </Text>
      {batch.map((r, idx) => (
        <Text key={idx} dimColor>
          {r.agentId}: {r.tool} {JSON.stringify(r.input).slice(0, 60)}
        </Text>
      ))}
      {options.map((o, idx) => (
        <Text key={o.label} color={idx === i ? theme.info : undefined}>
          {idx === i ? "❯ " : "  "}
          {idx + 1}. {o.label}
        </Text>
      ))}
      <Text dimColor>Esc to deny all · ↑/↓ + Enter or number keys</Text>
    </Box>
  );
}

export type PickModel = (
  agentId: string,
  provider: string,
  model: string,
  baseURL?: string,
) => string | undefined;

export function App({
  bus,
  orch,
  configs,
  onSubmit,
  onPickModel,
  approvals,
  usage,
  locks,
}: {
  bus: Bus;
  orch: Orchestrator;
  configs: AgentConfig[];
  approvals?: ApprovalQueue;
  usage?: UsageTracker;
  locks?: LockRegistry;
  onSubmit?: (text: string) => Promise<void>; // present → interactive mode
  onPickModel?: PickModel; // present → /model opens the selector
}) {
  const [logs, setLogs] = useState<Record<string, AgentEvent[]>>({});
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [lockMap, setLockMap] = useState<Map<string, string[]>>(new Map());
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [view, setView] = useState<"graph" | "usage" | "help" | "status" | "skills" | null>(null);
  const [tick, setTick] = useState(0); // bumped to force re-render when the approval queue changes
  const [reviewingBatch, setReviewingBatch] = useState(false); // "review each one" dismisses the batch view
  const [cmdIdx, setCmdIdx] = useState(0); // selected row in the slash-command dropdown
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [runStarted, setRunStarted] = useState(0); // epoch ms — set when a submission starts
  const [elapsed, setElapsed] = useState(0); // seconds, ticks while running
  const [baseTokens, setBaseTokens] = useState(0); // usage total at the moment this run started

  const cmdMatches = !running && input.startsWith("/") ? COMMANDS.filter((c) => c.cmd.startsWith(input)) : [];
  const cmdIdxClamped = Math.min(cmdIdx, Math.max(0, cmdMatches.length - 1));

  useEffect(() => approvals?.onChange(() => setTick((t) => t + 1)), [approvals]);
  useEffect(() => {
    if (!approvals?.currentBatch()) setReviewingBatch(false); // reset once the batch clears/shrinks
  }, [tick, approvals]);

  // Spinner + elapsed timer — only ticks while a task is actually running, not at idle.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      setSpinnerFrame((f) => (f + 1) % SPINNER.length);
      setElapsed(Math.round((Date.now() - runStarted) / 1000));
    }, 80);
    return () => clearInterval(t);
  }, [running, runStarted]);

  useInput((_input, key) => {
    if (cmdMatches.length === 0) return;
    if (key.downArrow) setCmdIdx((p) => (p + 1) % cmdMatches.length);
    else if (key.upArrow) setCmdIdx((p) => (p - 1 + cmdMatches.length) % cmdMatches.length);
    else if (key.escape) setInput("");
  });

  useEffect(() => {
    const unsub = bus.subscribe((e) => {
      if (e.type === "delta") {
        // Live streaming text — accumulate, don't flood the event log.
        setStreaming((prev) => ({ ...prev, [e.agentId]: (prev[e.agentId] ?? "") + e.payload }));
        return;
      }
      if (e.type === "message" || e.type === "done") {
        setStreaming((prev) => ({ ...prev, [e.agentId]: "" })); // settle: clear the live buffer
      }
      setLogs((prev) => ({
        ...prev,
        [e.agentId]: [...(prev[e.agentId] ?? []).slice(-7), e], // keep last 8 per agent
      }));
    });
    const timer = setInterval(() => {
      setTasks([...orch.all]);
      if (locks) setLockMap(locks.byHolder());
    }, 150);
    return () => {
      unsub();
      clearInterval(timer);
    };
  }, [bus, orch, locks]);

  const submit = async (value: string) => {
    // A dropdown row selected via Enter overrides whatever was typed — same as picking it directly.
    const text = cmdMatches.length > 0 ? cmdMatches[cmdIdxClamped]!.cmd : value.trim();
    if (!onSubmit || running || !text) return;
    setInput("");
    if ((text === "/model" || text === "/models") && onPickModel) {
      setSelecting(true);
      return;
    }
    if (text === "/graph") {
      setView((v) => (v === "graph" ? null : "graph"));
      return;
    }
    if (text === "/usage" && usage) {
      setView((v) => (v === "usage" ? null : "usage"));
      return;
    }
    if (text === "/help") {
      setView((v) => (v === "help" ? null : "help"));
      return;
    }
    if (text === "/status") {
      setView((v) => (v === "status" ? null : "status"));
      return;
    }
    if (text === "/skills") {
      setView((v) => (v === "skills" ? null : "skills"));
      return;
    }
    if (text === "/clear" || text === "/new") {
      orch.clear();
      setLogs({});
      setStreaming({});
      setTasks([]);
      return;
    }
    if (text === "/exit" || text === "/quit" || text === "/q") {
      process.exit(0);
    }
    setRunning(true);
    setRunStarted(Date.now());
    setElapsed(0);
    const before = usage?.totals();
    setBaseTokens(before ? before.inputTokens + before.outputTokens : 0);
    await onSubmit(text);
    setRunning(false);
  };

  if (view) {
    const placeholder = `/${view} to exit`;
    return (
      <Box flexDirection="column">
        {view === "usage" && usage ? <UsageView configs={configs} usage={usage} /> : null}
        {view === "graph" ? <GraphView configs={configs} tasks={tasks} /> : null}
        {view === "help" ? <HelpView /> : null}
        {view === "status" ? <StatusView configs={configs} tasks={tasks} /> : null}
        {view === "skills" ? <SkillsView /> : null}
        {onSubmit ? (
          <Box marginTop={1}>
            <Text color={theme.success}>▸ </Text>
            <TextInput value={input} onChange={setInput} onSubmit={submit} placeholder={placeholder} />
          </Box>
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        {configs.map((c) => {
          const color = agentColor(configs, c.id);
          return (
            <Box
              key={c.id}
              flexDirection="column"
              borderStyle="round"
              borderColor={color}
              width={44}
              marginRight={1}
            >
              <Text color={color} bold>
                {agentAvatar(configs, c.id)} {c.id} · {c.role}
              </Text>
              <Text color={color} dimColor>
                {c.provider}/{c.model}
              </Text>
              {(logs[c.id] ?? []).map((e, i) => (
                <Text
                  key={i}
                  color={e.type === "error" ? theme.error : e.type === "warning" || e.type === "failover" ? theme.warning : color}
                >
                  {e.type}: {e.payload.slice(0, 60).replace(/\n/g, " ")}
                </Text>
              ))}
              {streaming[c.id] ? (
                <Text color={color}>{streaming[c.id]!.slice(-90).replace(/\n/g, " ")}▌</Text>
              ) : null}
            </Box>
          );
        })}
      </Box>

      <Box flexDirection="column" borderStyle="round" marginTop={1}>
        <Text bold>Tasks</Text>
        {tasks.length === 0 ? (
          <Text dimColor>(none yet)</Text>
        ) : (
          tasks.map((t) => (
            <Text key={t.id}>
              {t.id} [{t.status}] {t.assignedTo ?? "-"}: {t.description.slice(0, 50)}
            </Text>
          ))
        )}
      </Box>

      {lockMap.size > 0 ? (
        <Text dimColor>
          {[...lockMap].map(([holder, paths]) => `🔒 ${holder}: ${paths.join(", ")}`).join(" | ")}
        </Text>
      ) : null}

      {!reviewingBatch && approvals?.currentBatch() ? (
        <BatchApprovalPrompt
          batch={approvals.currentBatch()!}
          onApproveAll={() => approvals.approveAll()}
          onApproveAgent={(agentId) => approvals.approveAgent(agentId)}
          onReviewEach={() => setReviewingBatch(true)}
          onDenyAll={() => approvals.denyAll()}
        />
      ) : approvals?.current() ? (
        <ApprovalPrompt req={approvals.current()!} onAnswer={(ok, scope) => approvals.answer(ok, scope)} />
      ) : selecting && onPickModel ? (
        <ModelSelector agents={[...configs]} onPick={onPickModel} onCancel={() => setSelecting(false)} />
      ) : onSubmit ? (
        <Box flexDirection="column">
          {cmdMatches.length > 0 ? (
            <Box flexDirection="column" borderStyle="round" borderColor={theme.info} paddingX={1}>
              {cmdMatches.map((c, idx) => (
                <Text key={c.cmd} color={idx === cmdIdxClamped ? theme.info : undefined}>
                  {idx === cmdIdxClamped ? "❯ " : "  "}
                  {c.cmd.padEnd(10)} <Text dimColor>{c.desc}</Text>
                </Text>
              ))}
            </Box>
          ) : null}
          <Box marginTop={1}>
            {running ? (
              <Text color={theme.warning}>
                {SPINNER[spinnerFrame]} Working… ({fmtElapsed(elapsed)}
                {usage ? ` · ↓${compactNumber(usage.totals().inputTokens + usage.totals().outputTokens - baseTokens)} tokens` : ""}) —
                Ctrl-C to quit
              </Text>
            ) : (
              <>
                <Text color={theme.success}>▸ </Text>
                <TextInput
                  value={input}
                  onChange={setInput}
                  onSubmit={submit}
                  placeholder="describe a task… (/ for commands)"
                />
              </>
            )}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

export function renderTui(
  bus: Bus,
  orch: Orchestrator,
  configs: AgentConfig[],
  onSubmit?: (text: string) => Promise<void>,
  onPickModel?: PickModel,
  approvals?: ApprovalQueue,
  usage?: UsageTracker,
  locks?: LockRegistry,
) {
  return render(
    <App
      bus={bus}
      orch={orch}
      configs={configs}
      onSubmit={onSubmit}
      onPickModel={onPickModel}
      approvals={approvals}
      usage={usage}
      locks={locks}
    />,
  );
}
