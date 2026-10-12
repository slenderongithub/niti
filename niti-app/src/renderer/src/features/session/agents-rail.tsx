import { memo } from "react";
import { ArrowRight, Cpu, MessageSquare, Repeat, LayoutDashboard, Focus } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AgentAvatar } from "@/components/agent-avatar";
import { PixelAvatar } from "@/components/pixel-avatar";
import { Spinner } from "@/components/spinner";
import { TASK_GLYPH, statusColor } from "@/lib/identity";
import { fmtTokens } from "@/lib/format";
import { taskCounts, type AgentView } from "@/lib/reducer";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="px-3 pb-4">
      <div className="flex h-8 items-center gap-2 px-1">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

// One agent. Every column but the name is fixed-width and shrink-proof, so a narrow rail truncates
// the name instead of clipping the status and token count off the edge.
const AgentRow = memo(function AgentRow({ a, lead, selected }: { a: AgentView; lead: boolean; selected: boolean }) {
  const focus = useUI((s) => s.focusAgent);
  const go = useUI((s) => s.go);
  const setModelPicker = useUI((s) => s.setModelPicker);
  const ctx = a.ctxLimit ? Math.min(100, Math.round((a.usage.lastInput * 100) / a.ctxLimit)) : 0;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Button
          variant="ghost"
          onClick={() => focus(selected ? null : a.id)}
          className={cn(
            "relative h-auto w-full min-w-0 flex-col items-stretch gap-2 whitespace-normal rounded-lg border border-transparent p-2.5 text-left font-normal hover:bg-muted/60",
            selected && "border-border bg-card shadow-sm hover:bg-card",
          )}
        >
          {selected && <span className="absolute inset-y-3 left-0 w-[3px] rounded-full" style={{ background: a.color }} />}
          <div className="flex min-w-0 items-center gap-2.5">
            <AgentAvatar slot={a.index} color={a.color} lead={lead} status={a.status} showStatus size="sm" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold leading-5">{a.cfg.role}</div>
              <div className="truncate font-mono text-[11px] leading-4 text-muted-foreground">{a.cfg.model}</div>
            </div>
          </div>
          {a.status === "working" && a.activity && (
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
              <Spinner className="shrink-0 text-[11px]" />
              <span className="truncate">{a.activity}</span>
            </div>
          )}
          <div className="flex min-w-0 items-center gap-2">
            <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${ctx}%`, background: ctx >= 80 ? "var(--destructive)" : ctx >= 60 ? "var(--warning)" : a.color }} />
            </div>
            <span className="w-11 shrink-0 text-right font-mono text-[10.5px] leading-4 text-muted-foreground tabular">{fmtTokens(a.usage.inputTokens + a.usage.outputTokens)}</span>
          </div>
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={() => focus(a.id)}>
          <Focus /> Focus transcript
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => {
            focus(a.id);
            setModelPicker(true);
          }}
        >
          <Repeat /> Switch model…
        </ContextMenuItem>
        <ContextMenuItem
          disabled={a.status !== "working"}
          onClick={() => {
            focus(a.id);
            window.dispatchEvent(new Event("niti:focus-composer"));
          }}
        >
          <MessageSquare /> Message {a.cfg.role}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => go("dashboard")}>
          <LayoutDashboard /> Open dashboard
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

export function AgentsRail() {
  const order = useApp(useShallow((s) => s.session.order));
  const agents = useApp((s) => s.session.agents);
  const lead = useApp((s) => s.session.leadId);
  const tasks = useApp((s) => s.session.tasks);
  const info = useApp((s) => s.sessionInfo);
  const focused = useUI((s) => s.focusedAgent);
  const go = useUI((s) => s.go);
  const c = taskCounts(tasks);

  return (
    <ScrollArea className="h-full">
      <div className="pt-3">
        <Section title={`Team · ${order.length}`}>
          <div className="flex flex-col gap-1">
            {order.map((id) => (
              <AgentRow key={id} a={agents[id]!} lead={id === lead} selected={focused === id} />
            ))}
          </div>
        </Section>

        {tasks.length > 0 && (
          <Section
            title={`Tasks · ${c.done}/${c.total}`}
            action={
              <Button variant="ghost" size="xs" className="h-6 shrink-0 gap-1 px-1.5 text-[11px] text-muted-foreground" onClick={() => go("tasks")}>
                Board <ArrowRight className="size-3" />
              </Button>
            }
          >
            <div className="mx-1 mb-2 h-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-success transition-[width] duration-500" style={{ width: `${c.total ? (c.done / c.total) * 100 : 0}%` }} />
            </div>
            <ul className="space-y-0.5">
              {tasks.slice(0, 12).map((t) => {
                const who = agents[t.assignedTo ?? t.role ?? ""];
                return (
                  <li key={t.id} className="flex min-w-0 items-start gap-2 rounded-md px-1 py-1 text-[12px] leading-[18px]">
                    <span className="w-3 shrink-0 text-center font-mono text-[11px]" style={{ color: statusColor(t.status) }}>
                      {TASK_GLYPH[t.status]}
                    </span>
                    <span className={cn("min-w-0 flex-1 break-words", t.status === "done" && "text-muted-foreground")}>{t.description}</span>
                    {who && (
                      <span className="mt-px shrink-0" title={who.cfg.role}>
                        <PixelAvatar slot={who.index} color={who.color} size={14} />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        {info && (info.mcp.length > 0 || info.lsp.length > 0) && (
          <Section title="Connected">
            <ul className="space-y-1 px-1 text-[12px]">
              {info.lsp.map((l) => (
                <li key={l.name} className="flex min-w-0 items-center gap-2">
                  <span className={cn("size-1.5 shrink-0 rounded-full", l.running ? "bg-success" : "bg-muted-foreground/40")} />
                  <Cpu className="size-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{l.name}</span>
                  <span className="shrink-0 text-[10.5px] text-muted-foreground">lsp</span>
                </li>
              ))}
              {info.mcp.map((m) => (
                <li key={m.name} className="flex min-w-0 items-center gap-2">
                  <span className="size-1.5 shrink-0 rounded-full bg-success" />
                  <Cpu className="size-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{m.name}</span>
                  <span className="shrink-0 text-[10.5px] text-muted-foreground">{m.tools} tools</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </ScrollArea>
  );
}
