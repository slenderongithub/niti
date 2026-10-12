import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { cn } from "@/lib/utils";

// Every empty area in the app: a quiet, centred message. One component, one look.
export function EmptyState({ icon: Icon, title, description, action, className, compact }: { icon: LucideIcon; title: string; description?: ReactNode; action?: ReactNode; className?: string; compact?: boolean }) {
  return (
    <Empty className={cn("h-full min-h-0 rounded-lg bg-transparent", compact ? "gap-2 p-5" : "gap-4 p-8", className)}>
      <EmptyHeader className={compact ? "gap-1.5" : undefined}>
        <EmptyMedia variant="icon" className={compact ? "size-8 [&_svg]:size-4" : undefined}>
          <Icon />
        </EmptyMedia>
        <EmptyTitle className={compact ? "text-[13px]" : "text-sm"}>{title}</EmptyTitle>
        {description && <EmptyDescription className={compact ? "text-xs" : "text-[13px]"}>{description}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}
