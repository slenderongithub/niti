import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { AgentConfig } from "../agent/agent.ts";
import type { Task } from "../orchestrator/task.ts";
import { theme, agentColor, agentAvatar } from "./theme.ts";

const SPINNER = "⠋⠙⠹⠸⠼⠦⠧⠇⠏";

function statusColor(status: Task["status"]): string {
  if (status === "done") return theme.success;
  if (status === "in_progress") return theme.warning;
  if (status === "failed") return theme.error;
  return theme.textMuted; // pending
}

// Graph as a tree: each agent node → the tasks it worked. Failover shows as ⚡×N (attempts).
// ponytail: hierarchical layout, not a force-directed canvas — crossing edges in a terminal are the ceiling.
export function GraphView({ configs, tasks }: { configs: AgentConfig[]; tasks: readonly Task[] }) {
  const unassigned = tasks.filter((t) => !t.assignedTo);
  const anyRunning = tasks.some((t) => t.status === "in_progress");
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 80);
    return () => clearInterval(t);
  }, [anyRunning]);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} marginTop={1} paddingX={1}>
      <Text bold>Graph — agents → tasks (/graph to toggle)</Text>
      {configs.map((c) => {
        const mine = tasks.filter((t) => t.assignedTo === c.id);
        const color = agentColor(configs, c.id);
        return (
          <Box key={c.id} flexDirection="column" marginTop={1}>
            <Text color={color} bold>
              {agentAvatar(configs, c.id)} {c.id} · {c.model}
            </Text>
            {mine.length === 0 ? (
              <Text dimColor> └─ (idle)</Text>
            ) : (
              mine.map((t, j) => (
                <Text key={t.id} color={color}>
                  {" "}
                  {j === mine.length - 1 ? "└─" : "├─"} {t.id}{" "}
                  <Text color={statusColor(t.status)}>
                    [{t.status}]
                    {t.status === "in_progress" ? ` ${SPINNER[frame]}` : ""}
                  </Text>
                  {t.attempts ? ` ⚡×${t.attempts}` : ""} {t.description.slice(0, 34)}
                </Text>
              ))
            )}
          </Box>
        );
      })}
      {unassigned.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>pending (unassigned)</Text>
          {unassigned.map((t) => (
            <Text key={t.id} dimColor>
              {" "}
              • {t.id} {t.description.slice(0, 40)}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
