import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

// The layout system every page is built from, so boxes, gaps and edges match everywhere:
//   page gutter 24px · section gap 16px · card padding 20px · header 56px · tiles 104px.

export function Page({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return (
    <ScrollArea className="h-full">
      <div data-audit="page" className={cn("mx-auto flex w-full flex-col gap-4 px-6 py-6", wide ? "max-w-7xl" : "max-w-6xl", className)}>
        {children}
      </div>
    </ScrollArea>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header data-audit="section" className="flex h-14 shrink-0 items-center gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-xl font-semibold leading-7 tracking-tight">{title}</h1>
        {description && <p className="truncate text-[13px] leading-5 text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

// Fixed height, and the sub line always takes its row: a row of tiles is a row of equal boxes.
export function StatTile({ icon: Icon, label, value, sub, tone, className, onClick }: { icon: LucideIcon; label: string; value: ReactNode; sub?: ReactNode; tone?: string; className?: string; onClick?: () => void }) {
  return (
    <Card
      data-audit="tile"
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => e.key === "Enter" && onClick() : undefined}
      className={cn("h-[104px] min-w-0 justify-between gap-0 px-4 py-3.5 shadow-none", onClick && "cursor-pointer transition-colors hover:bg-accent/40", className)}
    >
      <div className="flex h-4 items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" style={tone ? { color: tone } : undefined} />
        <span className="truncate">{label}</span>
      </div>
      <div className="truncate text-2xl font-semibold leading-8 tracking-tight tabular">{value}</div>
      <div className="h-4 truncate text-[11px] leading-4 text-muted-foreground">{sub ?? " "}</div>
    </Card>
  );
}

export function SectionCard({
  title,
  description,
  icon: Icon,
  action,
  children,
  className,
  contentClassName,
  flush,
}: {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  flush?: boolean;
}) {
  return (
    <Card data-audit="card" className={cn("min-w-0 gap-0 overflow-hidden py-0 shadow-none", className)}>
      <CardHeader className="flex min-h-16 items-center gap-3 border-b px-5 py-3 [.border-b]:pb-3">
        <div className="min-w-0 flex-1">
          <CardTitle className="flex items-center gap-2 text-sm leading-5">
            {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
            <span className="truncate">{title}</span>
          </CardTitle>
          {description && <CardDescription className="mt-0.5 truncate text-xs leading-4">{description}</CardDescription>}
        </div>
        {action && <CardAction className="shrink-0 self-center">{action}</CardAction>}
      </CardHeader>
      <CardContent className={cn("min-h-0 flex-1", flush ? "p-0" : "p-5", contentClassName)}>{children}</CardContent>
    </Card>
  );
}
