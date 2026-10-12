import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// The draggable strip at the top of every pre-session screen; the traffic lights sit in its left inset.
export function WindowChrome({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <div className={cn("drag flex h-11 shrink-0 items-center pl-20 pr-3", className)}>
      <div className="no-drag ml-auto flex items-center gap-1">{children}</div>
    </div>
  );
}
