import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ChevronUp, Maximize2, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentAvatar } from "@/components/agent-avatar";
import { AnimatedShinyText } from "@/components/ui/animated-shiny-text";
import { EmptyState } from "@/components/empty-state";
import { groupItems, type AgentView, type RenderItem } from "@/lib/reducer";
import { fmtTokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { ItemView, TodoList } from "./items";
import { Hourglass } from "lucide-react";

const WINDOW = 150; // rendered rows; older ones load on demand

// Follows the bottom while the user is there; once they scroll up it holds still and counts what
// arrived below (the TUI's "scrolled back · N new below · G follows").
function useFollow(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const bottom = useRef(true);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const at = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (at !== bottom.current) {
      bottom.current = at;
      setAtBottom(at);
      if (at) setUnseen(0);
    }
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (bottom.current) el.scrollTop = el.scrollHeight;
    else setUnseen((n) => n + 1);
  }, [dep]);
  const jump = () => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    bottom.current = true;
    setAtBottom(true);
    setUnseen(0);
  };
  return { ref, onScroll, atBottom, unseen, jump };
}

const openKeys = () => {
  useUI.getState().go("settings");
  location.hash = "providers";
};

// One transcript row. Memoised on the item's identity: the reducer replaces only the rows an event
// touched, so a streamed token re-renders one row, not the whole transcript.
const Row = memo(function Row({ item }: { item: RenderItem }) {
  return (
    <div className="row-in cv-auto">
      <ItemView item={item} onFixKey={openKeys} />
    </div>
  );
});

export const AgentPanel = memo(function AgentPanel({ agent, compact, onToggleFocus, focused }: { agent: AgentView; compact?: boolean; onToggleFocus?: () => void; focused?: boolean }) {
  const lead = useApp((s) => s.session.leadId === agent.id);
  const [limit, setLimit] = useState(WINDOW);
  const items = useMemo(() => groupItems(agent.items), [agent.items]);
  const shown = items.length > limit ? items.slice(items.length - limit) : items;
  const { ref, onScroll, atBottom, unseen, jump } = useFollow(agent.items);
  const ctxPct = agent.ctxLimit ? Math.min(100, Math.round((agent.usage.lastInput * 100) / agent.ctxLimit)) : 0;
  const tokens = agent.usage.inputTokens + agent.usage.outputTokens;

  return (
    <div className={cn("relative flex h-full min-h-0 flex-col overflow-hidden", compact && "rounded-[14px]")}>
      <div className={cn("flex h-14 shrink-0 items-center gap-3 border-b px-4", !compact && "bg-background/80")}>
        <AgentAvatar slot={agent.index} color={agent.color} lead={lead} status={agent.status} showStatus size={compact ? "sm" : "md"} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold leading-5" style={{ color: agent.color }}>
              {agent.cfg.role}
            </span>
            <span className="shrink-0 text-[11px] capitalize leading-5 text-muted-foreground">{agent.status}</span>
          </div>
          {agent.status === "working" && agent.activity ? (
            // What it's doing right now, with a glint passing over it while it works.
            <AnimatedShinyText shimmerWidth={80} className="block truncate font-mono text-[11px] leading-4">
              {agent.activity}
            </AnimatedShinyText>
          ) : (
            <div className="truncate font-mono text-[11px] leading-4 text-muted-foreground">{`${agent.cfg.provider}/${agent.cfg.model}`}</div>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="hidden w-20 shrink-0 flex-col items-end gap-1 sm:flex">
              <span className="font-mono text-[11px] leading-4 text-muted-foreground tabular">{fmtTokens(tokens)} tok</span>
              <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full rounded-full transition-[width] duration-500", ctxPct >= 80 ? "bg-destructive" : ctxPct >= 60 ? "bg-warning" : "bg-primary/70")} style={{ width: `${ctxPct}%` }} />
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            Context {ctxPct}% of {fmtTokens(agent.ctxLimit)}
          </TooltipContent>
        </Tooltip>
        {onToggleFocus && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={onToggleFocus} aria-label={focused ? "Back to all agents" : "Focus this agent"}>
                {focused ? <Minimize2 /> : <Maximize2 />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{focused ? "Back to all agents (esc)" : "Focus this agent"}</TooltipContent>
          </Tooltip>
        )}
      </div>

      <div ref={ref} onScroll={onScroll} className={cn("min-h-0 flex-1 overflow-y-auto scrollbar-thin", compact ? "px-4 py-3" : "px-6 py-4")}>
        <div className={cn("flex min-h-full flex-col", !compact && "mx-auto max-w-3xl")}>
          {agent.todos && (
            <div className="mb-3">
              <TodoList todos={agent.todos} color={agent.color} />
            </div>
          )}
          {items.length > shown.length && (
            <Button variant="ghost" size="sm" className="mb-2 self-center text-xs text-muted-foreground" onClick={() => setLimit((l) => l + WINDOW)}>
              <ChevronUp /> Show {Math.min(WINDOW, items.length - shown.length)} earlier
            </Button>
          )}
          {items.length === 0 && !agent.todos ? (
            <EmptyState compact icon={Hourglass} title={agent.status === "working" ? "Thinking…" : "Waiting for work"} description={agent.status === "working" ? undefined : `${agent.cfg.role} picks up tasks the lead hands out.`} />
          ) : (
            shown.map((it) => <Row key={it.id} item={it} />)
          )}
        </div>
      </div>

      {!atBottom && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 animate-in fade-in slide-in-from-bottom-2 duration-150">
          <Button size="sm" variant="secondary" className="h-7 gap-1.5 rounded-full border px-3 text-xs shadow-float" onClick={jump}>
            <ArrowDown /> {unseen > 0 ? `${unseen} new below` : "Jump to latest"}
          </Button>
        </div>
      )}
    </div>
  );
});
