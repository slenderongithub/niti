import { useEffect, useRef, useState } from "react";
import { motion, type TargetAndTransition } from "motion/react";
import { FileCode2, LayoutGrid, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/components/agent-avatar";
import { BorderBeam } from "@/components/ui/border-beam";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { closeFileTab, useEditor } from "@/store/editor";
import { useUI } from "@/store/ui";
import { CodeEditor } from "@/features/editor/code-editor";
import { AgentPanel } from "./agent-transcript";
import { Welcome } from "./welcome";

const FRAME = { type: "spring", stiffness: 380, damping: 38 } as const;

// Where a focused agent's panel grows from: its card's box, as a transform on the full panel.
// Measured once, on the click (a hand-rolled FLIP, not motion's shared layout: that keeps a
// projection tree over the whole transcript and made every page switch pay to measure it).
function grownFrom(card: Element | null, area: Element | null): TargetAndTransition | null {
  if (!card || !area) return null;
  const c = card.getBoundingClientRect();
  const a = area.getBoundingClientRect();
  if (!a.width || !a.height) return null;
  return { x: c.left - a.left, y: c.top - a.top, scaleX: c.width / a.width, scaleY: c.height / a.height, borderRadius: 14 };
}

// The session's centre: all agents side by side (the TUI's overview), one agent, or a file you
// opened — all as tabs in one strip. Esc goes back to everyone.
export function TranscriptArea() {
  const order = useApp((s) => s.session.order);
  const agents = useApp((s) => s.session.agents);
  const lead = useApp((s) => s.session.leadId);
  const hasContent = useApp((s) => s.session.active || Boolean(s.session.goal) || s.session.order.some((id) => s.session.agents[id]!.items.length > 0));
  const focused = useUI((s) => s.focusedAgent);
  const focus = useUI((s) => s.focusAgent);
  const openFiles = useUI((s) => s.openFiles);
  const activeFile = useUI((s) => s.activeFile);
  const viewFile = useUI((s) => s.viewFile);
  const dirty = useEditor((s) => s.bufs);
  const shown = !activeFile && focused && agents[focused] ? focused : null;
  const area = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<{ id: string; from: TargetAndTransition } | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector("[role=dialog],[role=alertdialog]")) return;
      const t = e.target as HTMLElement;
      if (t.closest(".cm-editor") || (t.tagName === "TEXTAREA" && (t as HTMLTextAreaElement).value)) return;
      if (useUI.getState().focusedAgent) focus(null);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [focus]);

  const cols = order.length <= 1 ? 1 : order.length <= 4 ? 2 : 3;
  const showStrip = order.length > 1 || openFiles.length > 0;
  const allActive = !activeFile && !shown;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {showStrip && (
        <div role="tablist" className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b px-3 scrollbar-thin">
          {order.length > 1 && (
            <Tab active={allActive} onClick={() => focus(null)}>
              <LayoutGrid className="size-3.5" /> All agents
            </Tab>
          )}
          {order.length > 1 &&
            order.map((id) => {
              const a = agents[id]!;
              return (
                <Tab key={id} active={!activeFile && shown === id} onClick={() => focus(id)}>
                  <AgentAvatar slot={a.index} color={a.color} lead={id === lead} size="xs" />
                  {a.cfg.role}
                  {a.status === "working" && <span className="size-1.5 animate-pulse rounded-full bg-info" />}
                </Tab>
              );
            })}
          {openFiles.length > 0 && order.length > 1 && <span className="mx-1 h-5 w-px shrink-0 bg-border" />}
          {openFiles.map((f) => (
            <Tab key={f} active={activeFile === f} onClick={() => viewFile(f)} onClose={() => void closeFileTab(f)} title={f}>
              <FileCode2 className="size-3.5 text-muted-foreground" />
              <span className="max-w-40 truncate">{f.split("/").pop()}</span>
              {dirty[f]?.dirty && <span className="size-1.5 rounded-full bg-warning" title="unsaved" />}
            </Tab>
          ))}
        </div>
      )}
      {/* Focusing an agent from its card grows the card into the panel instead of cutting to it. */}
      <div ref={area} className="relative min-h-0 flex-1">
        {activeFile ? (
          <div key={`f-${activeFile}`} className="absolute inset-0 animate-in fade-in duration-150">
            <CodeEditor path={activeFile} />
          </div>
        ) : !hasContent ? (
          <Welcome />
        ) : shown ? (
          <div key={`a-${shown}`} className="absolute inset-0">
            {/* The card's frame grows to fill the area, then hands over to the panel and fades. */}
            <motion.div
              className="pointer-events-none absolute inset-0 origin-top-left border bg-card shadow-float"
              initial={zoom?.id === shown ? { ...zoom.from, opacity: 1 } : false}
              animate={{ x: 0, y: 0, scaleX: 1, scaleY: 1, borderRadius: 0, opacity: 0 }}
              transition={{ ...FRAME, opacity: { delay: 0.2, duration: 0.18 } }}
              onAnimationComplete={() => setZoom(null)}
            />
            <motion.div className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18, delay: 0.06 }}>
              <AgentPanel agent={agents[shown]!} onToggleFocus={order.length > 1 ? () => focus(null) : undefined} focused />
            </motion.div>
          </div>
        ) : order.length === 1 ? (
          <div className="absolute inset-0">
            <AgentPanel agent={agents[order[0]!]!} />
          </div>
        ) : (
          <div
            className={cn("absolute inset-0 grid gap-4 overflow-y-auto p-4 animate-in fade-in duration-150", cols === 2 ? "grid-cols-2" : "grid-cols-3")}
            style={{ gridAutoRows: order.length > cols ? "minmax(280px, 1fr)" : "1fr" }}
          >
            {order.map((id) => {
              const a = agents[id]!;
              return (
                <div key={id} data-card={id} className="relative min-h-0">
                  <div className="absolute inset-0 rounded-[14px] border bg-card shadow-panel" />
                  {/* At work: a light in the agent's own colour travels the card's rim. */}
                  {a.status === "working" && (
                    <div className="pointer-events-none absolute inset-0 rounded-[14px]">
                      <BorderBeam size={90} duration={7} colorFrom={a.color} borderWidth={1.5} />
                    </div>
                  )}
                  <div className="relative h-full">
                    <AgentPanel
                      agent={a}
                      compact
                      onToggleFocus={() => {
                        const from = grownFrom(area.current?.querySelector(`[data-card="${CSS.escape(id)}"]`) ?? null, area.current);
                        setZoom(from ? { id, from } : null);
                        focus(id);
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Tab({ active, onClick, onClose, title, children }: { active: boolean; onClick: () => void; onClose?: () => void; title?: string; children: React.ReactNode }) {
  return (
    <div role="tab" aria-selected={active} title={title} className={cn("group/tab relative flex h-8 shrink-0 items-center rounded-md transition-colors", active ? "bg-card text-foreground shadow-panel" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>
      <Button variant="ghost" size="sm" onClick={onClick} className={cn("h-8 gap-1.5 px-2.5 text-xs font-medium hover:bg-transparent", onClose && "pr-1")}>
        {children}
      </Button>
      {onClose && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={cn("mr-1 size-6 rounded-sm opacity-0 group-hover/tab:opacity-100", active && "opacity-100")}
        >
          <X className="size-3" />
        </Button>
      )}
      {active && <motion.span layoutId="session-tab" className="absolute inset-x-2 -bottom-[7px] h-0.5 rounded-full bg-primary" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
    </div>
  );
}
