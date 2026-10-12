import { motion } from "motion/react";
import { RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BorderBeam } from "@/components/ui/border-beam";
import { Card } from "@/components/ui/card";
import { PixelAvatar } from "@/components/pixel-avatar";
import { statusColor, TASK_GLYPH, tint } from "@/lib/identity";
import type { AgentView } from "@/lib/reducer";
import type { Task } from "@/lib/types";
import { cn } from "@/lib/utils";

export function TaskCard({ task, agents, onOpen, compact }: { task: Task; agents: Record<string, AgentView>; onOpen?: () => void; compact?: boolean }) {
  const who = agents[task.assignedTo ?? task.role ?? ""];
  const running = task.status === "in_progress";
  return (
    <motion.div layout="position" layoutId={`task-${task.id}`} transition={{ type: "spring", stiffness: 520, damping: 40 }}>
      <Card
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => e.key === "Enter" && onOpen?.()}
        className={cn(
          "relative cursor-pointer gap-2 overflow-hidden rounded-xl px-3 py-2.5 transition-shadow hover:shadow-float focus-visible:ring-2 focus-visible:ring-ring",
          task.status === "done" && "opacity-80",
        )}
      >
        {running && <BorderBeam size={60} duration={6} colorFrom={who?.color ?? "var(--primary)"} borderWidth={1.5} />}
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10.5px] text-muted-foreground">{task.id}</span>
          {(task.attempts ?? 0) > 0 && (
            <Badge variant="outline" className="h-4 gap-0.5 px-1 text-[9.5px]">
              <RotateCcw className="size-2.5" /> {task.attempts}
            </Badge>
          )}
          <span className="ml-auto font-mono text-[11px]" style={{ color: statusColor(task.status) }}>
            {TASK_GLYPH[task.status]}
          </span>
        </div>
        <p className={cn("text-[12.5px] leading-snug", compact ? "line-clamp-2" : "line-clamp-4", task.status === "done" && "text-muted-foreground")}>{task.description}</p>
        <div className="flex items-center gap-2">
          {who ? (
            <span className="flex min-w-0 items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2 text-[11px]" style={{ background: tint(who.color, 12) }}>
              <PixelAvatar slot={who.index} color={who.color} size={14} />
              <span className="truncate" style={{ color: who.color }}>
                {who.cfg.role}
              </span>
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground">unassigned</span>
          )}
          {task.dependsOn && task.dependsOn.length > 0 && <span className="ml-auto truncate font-mono text-[10.5px] text-muted-foreground">↳ after {task.dependsOn.join(", ")}</span>}
        </div>
      </Card>
    </motion.div>
  );
}

