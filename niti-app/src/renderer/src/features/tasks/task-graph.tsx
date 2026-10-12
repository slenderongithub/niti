import { useMemo } from "react";
import { motion } from "motion/react";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { statusColor } from "@/lib/identity";
import type { AgentView } from "@/lib/reducer";
import type { Task } from "@/lib/types";
import { COL_W, layoutDag } from "@/lib/dag";
import { TaskCard } from "./task-card";

export function TaskGraph({ tasks, agents, onOpen }: { tasks: Task[]; agents: Record<string, AgentView>; onOpen: (id: string) => void }) {
  const { pos, width, height } = useMemo(() => layoutDag(tasks), [tasks]);
  const edges = tasks.flatMap((t) => (t.dependsOn ?? []).filter((d) => pos.has(d)).map((d) => ({ from: d, to: t.id })));
  const status = new Map(tasks.map((t) => [t.id, t.status]));

  return (
    <ScrollArea className="h-full">
      <div className="relative" style={{ width, height }}>
        <svg className="pointer-events-none absolute inset-0" width={width} height={height}>
          {edges.map((e) => {
            const a = pos.get(e.from)!;
            const b = pos.get(e.to)!;
            const x1 = a.x + COL_W;
            const y1 = a.y + 40;
            const x2 = b.x;
            const y2 = b.y + 40;
            const mx = (x1 + x2) / 2;
            const live = status.get(e.to) === "in_progress";
            const done = status.get(e.from) === "done";
            return (
              <g key={`${e.from}-${e.to}`}>
                <motion.path
                  d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                  fill="none"
                  stroke={done ? statusColor("done") : "var(--border)"}
                  strokeOpacity={done ? 0.6 : 1}
                  strokeWidth={1.5}
                  strokeDasharray={live ? "5 5" : undefined}
                  initial={{ pathLength: 0 }}
                  animate={live ? { pathLength: 1, strokeDashoffset: [0, -20] } : { pathLength: 1 }}
                  transition={live ? { strokeDashoffset: { duration: 0.8, repeat: Infinity, ease: "linear" }, pathLength: { duration: 0.5 } } : { duration: 0.5 }}
                />
                <circle cx={x2} cy={y2} r={3} fill={done ? statusColor("done") : "var(--muted-foreground)"} />
              </g>
            );
          })}
        </svg>
        {tasks.map((t) => {
          const p = pos.get(t.id)!;
          return (
            <div key={t.id} className="absolute" style={{ left: p.x, top: p.y, width: COL_W }}>
              <TaskCard task={t} agents={agents} onOpen={() => onOpen(t.id)} compact />
            </div>
          );
        })}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
}
