import { statusColor } from "@/lib/identity";
import { cn } from "@/lib/utils";

export function StatusDot({ status, className }: { status: string; className?: string }) {
  const color = statusColor(status);
  const live = status === "working" || status === "in_progress";
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)}>
      {live && <span className="absolute inset-0 animate-ping rounded-full opacity-60" style={{ background: color }} />}
      <span className="relative inline-flex size-2 rounded-full" style={{ background: color }} />
    </span>
  );
}
