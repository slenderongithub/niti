import { useEffect } from "react";
import { FileCode2, LayoutGrid, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/components/agent-avatar";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { closeFileTab, useEditor } from "@/store/editor";
import { useUI } from "@/store/ui";
import { CodeEditor } from "@/features/editor/code-editor";
import { AgentPanel } from "./agent-transcript";
import { Welcome } from "./welcome";

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
      <div className="relative min-h-0 flex-1">
        {activeFile ? (
          <div key={`f-${activeFile}`} className="absolute inset-0 animate-in fade-in duration-150">
            <CodeEditor path={activeFile} />
          </div>
        ) : !hasContent ? (
          <Welcome />
        ) : shown ? (
          <div key={`a-${shown}`} className="absolute inset-0 animate-in fade-in duration-150">
            <AgentPanel agent={agents[shown]!} onToggleFocus={order.length > 1 ? () => focus(null) : undefined} focused />
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
            {order.map((id) => (
              <div key={id} className="min-h-0">
                <AgentPanel agent={agents[id]!} compact onToggleFocus={() => focus(id)} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Tab({ active, onClick, onClose, title, children }: { active: boolean; onClick: () => void; onClose?: () => void; title?: string; children: React.ReactNode }) {
  return (
    <div role="tab" aria-selected={active} title={title} className={cn("group/tab relative flex h-8 shrink-0 items-center rounded-md transition-colors", active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>
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
      {active && <span className="absolute inset-x-2 -bottom-[7px] h-0.5 rounded-full bg-primary" />}
    </div>
  );
}
