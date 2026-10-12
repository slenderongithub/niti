import { memo, useEffect, useState } from "react";
import { motion } from "motion/react";
import {
  BookOpen,
  Brain,
  Check,
  ChevronRight,
  FilePen,
  FilePlus2,
  FileSearch,
  FileText,
  FolderTree,
  KeyRound,
  ListChecks,
  ScanSearch,
  Search,
  Stethoscope,
  Terminal,
  TriangleAlert,
  Wrench,
  X,
  CornerDownRight,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/spinner";
import { fmtDur, groupLabel, PAST_VERB } from "@/lib/humanize";
import type { Item, RenderItem } from "@/lib/reducer";
import type { Todo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useUI } from "@/store/ui";
import { DiffRows } from "./diff-view";
import { Markdown } from "./markdown";

const VERB_ICON: Record<string, LucideIcon> = {
  Read: FileText,
  Write: FilePen,
  Edit: FilePen,
  List: FolderTree,
  Find: FileSearch,
  Search: Search,
  Run: Terminal,
  Check: Stethoscope,
  Inspect: ScanSearch,
  Remember: Brain,
  Recall: BookOpen,
  Plan: ListChecks,
};

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="tabular">{fmtDur(Math.max(0, now - since))}</span>;
}

function PathTarget({ target, verb }: { target: string; verb: string }) {
  const view = useUI((s) => s.viewFile);
  const isPath = (verb === "Read" || verb === "Write" || verb === "Edit") && target && !target.includes(" ");
  if (!isPath) return <span className="truncate font-mono text-[12px] text-foreground/90">{target}</span>;
  return (
    <Button variant="link" className="h-auto min-w-0 shrink justify-start truncate p-0 font-mono text-[12px] font-normal text-foreground/90" onClick={() => view(target.replace(/^\.\//, ""))}>
      {target}
    </Button>
  );
}

const ToolRow = memo(function ToolRow({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const Icon = VERB_ICON[item.verb] ?? Wrench;
  const running = item.status === "running";
  const failed = item.status === "fail";
  return (
    <div className="group/tool">
      <div className="flex min-w-0 items-center gap-2 py-[3px] text-[12.5px]">
        <span className="flex w-4 shrink-0 justify-center">
          {running ? <Spinner className="text-[13px]" /> : failed ? <X className="size-3.5 text-destructive" /> : <Check className="size-3.5 text-success" />}
        </span>
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className={cn("shrink-0", running ? "text-foreground" : "text-muted-foreground")}>{running ? item.verb : (PAST_VERB[item.verb] ?? item.verb)}</span>
        {item.target && <PathTarget target={item.target} verb={item.verb} />}
        {item.outcome && !running && <span className="hidden truncate text-[11.5px] text-muted-foreground/80 group-hover/tool:inline">· {item.outcome}</span>}
        <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground/70">{running ? <Elapsed since={item.startedAt} /> : item.durationMs !== undefined ? fmtDur(item.durationMs) : ""}</span>
      </div>
      {running && item.live && item.live.length > 0 && (
        <div className="ml-6 mt-0.5 rounded-md border-l-2 border-primary/30 bg-muted/40 px-2.5 py-1 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {item.live.slice(-4).map((l, i) => (
            <div key={i} className="truncate">
              {l || " "}
            </div>
          ))}
        </div>
      )}
      {failed && item.error && <div className="selectable ml-6 mt-0.5 text-[12px] text-destructive/90 [overflow-wrap:anywhere]">{item.error}</div>}
    </div>
  );
});

function GroupRow({ item }: { item: Extract<RenderItem, { kind: "group" }> }) {
  const Icon = VERB_ICON[item.verb] ?? Wrench;
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="group/g -mx-1.5 h-auto w-[calc(100%+12px)] justify-start gap-2 px-1.5 py-[3px] text-[12.5px] font-normal">
          <span className="flex w-4 shrink-0 justify-center">
            <Check className="size-3.5 text-success" />
          </span>
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">{groupLabel(item.verb, item.items.length, "")}</span>
          <ChevronRight className="size-3 text-muted-foreground/60 transition-transform group-data-[state=open]/g:rotate-90" />
          <span className="ml-auto text-[11px] text-muted-foreground/70">{fmtDur(item.durationMs)}</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
        <div className="ml-[34px] border-l pl-3">
          {item.items.map((t) => (
            <div key={t.id} className="flex items-center gap-2 py-[1px] text-[12px]">
              <PathTarget target={t.target} verb={t.verb} />
              {t.outcome && <span className="truncate text-[11px] text-muted-foreground/70">· {t.outcome}</span>}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ShellBlock({ item }: { item: Extract<Item, { kind: "shell" }> }) {
  const [open, setOpen] = useState(false);
  const lines = item.body;
  const shown = open ? lines : lines.slice(0, 3);
  const hidden = Math.max(item.lines, lines.length) - shown.length;
  return (
    <div className={cn("my-1.5 overflow-hidden rounded-xl border bg-card shadow-panel", !item.ok && "border-destructive/40")}>
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[12px]">
        <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
        <code className="selectable min-w-0 flex-1 truncate font-mono text-foreground">{item.command}</code>
        <span className={cn("flex shrink-0 items-center gap-1 text-[11px]", item.ok ? "text-success" : "text-destructive")}>
          {item.ok ? <Check className="size-3" /> : <X className="size-3" />}
          {item.exitCode !== undefined ? `exit ${item.exitCode}` : item.ok ? "ok" : "failed"}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground tabular">{fmtDur(item.durationMs)}</span>
      </div>
      {item.outcome && (
        <div className={cn("flex items-center gap-1.5 px-3 pt-1.5 text-[12px]", item.ok ? "text-foreground/90" : "text-destructive")}>
          <CornerDownRight className="size-3 text-muted-foreground" />
          {item.outcome}
        </div>
      )}
      {shown.length > 0 && (
        <pre className="selectable max-h-[420px] overflow-auto px-3 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground scrollbar-thin">{shown.join("\n")}</pre>
      )}
      {hidden > 0 && (
        <Button variant="ghost" size="xs" className="mb-1 ml-1.5 h-6 text-[11px] font-normal text-muted-foreground" onClick={() => setOpen((o) => !o)}>
          {open ? "Show less" : `+${hidden} lines`}
        </Button>
      )}
    </div>
  );
}

function DiffBlock({ item }: { item: Extract<Item, { kind: "diff" }> }) {
  const view = useUI((s) => s.viewFile);
  const Icon = item.created ? FilePlus2 : FilePen;
  return (
    <div className="my-1.5 overflow-hidden rounded-xl border bg-card shadow-panel">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[12px]">
        <Icon className={cn("size-3.5 shrink-0", item.created ? "text-success" : "text-primary")} />
        <span className="text-muted-foreground">{item.created ? "Created" : "Updated"}</span>
        <Button variant="link" className="h-auto min-w-0 shrink justify-start truncate p-0 font-mono text-[12px] font-medium text-foreground" onClick={() => view(item.path)}>
          {item.path}
        </Button>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular">
          <span className="text-success">+{item.added}</span>
          {item.removed > 0 && <span className="text-destructive">−{item.removed}</span>}
        </span>
      </div>
      {item.hunks.length > 0 && <DiffRows hunks={item.hunks} more={item.more} className="py-1" />}
    </div>
  );
}

function NoteRow({ item, onFixKey }: { item: Extract<Item, { kind: "note" }>; onFixKey?: () => void }) {
  switch (item.tone) {
    case "thought":
      return <div className="selectable py-[3px] pl-6 text-[12.5px] italic text-muted-foreground/90 [overflow-wrap:anywhere]">{item.text}</div>;
    case "step":
      return (
        <div className="selectable flex gap-2 py-[3px] text-[12.5px] font-medium text-primary">
          <span className="w-4 text-center font-mono">▸</span>
          <span className="[overflow-wrap:anywhere]">{item.text}</span>
        </div>
      );
    case "warning":
      return (
        <div className="selectable my-1 flex gap-2 rounded-md bg-warning/10 px-2.5 py-1.5 text-[12.5px] text-warning">
          <TriangleAlert className="mt-[1px] size-3.5 shrink-0" />
          <span className="[overflow-wrap:anywhere]">{item.text}</span>
        </div>
      );
    case "error":
      return (
        <div className="selectable my-1 flex items-start gap-2 rounded-md bg-destructive/10 px-2.5 py-1.5 text-[12.5px] text-destructive">
          <X className="mt-[1px] size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{item.text}</span>
          {item.keyError && onFixKey && (
            <Button size="xs" variant="outline" className="h-6 shrink-0 border-destructive/40 text-destructive" onClick={onFixKey}>
              <KeyRound /> Change key
            </Button>
          )}
        </div>
      );
    case "user":
      return (
        <div className="my-1.5 flex justify-end">
          <div className="selectable max-w-[85%] rounded-2xl rounded-br-md bg-primary/12 px-3 py-1.5 text-[13px] text-foreground">{item.text}</div>
        </div>
      );
    default:
      return <div className="selectable py-[3px] pl-6 text-[12.5px] text-muted-foreground [overflow-wrap:anywhere]">{item.text}</div>;
  }
}

export const ItemView = memo(function ItemView({ item, onFixKey }: { item: RenderItem; onFixKey?: () => void }) {
  switch (item.kind) {
    case "text":
      return (
        <div className="py-1.5">
          <Markdown text={item.text} streaming={item.streaming} />
        </div>
      );
    case "tool":
      return <ToolRow item={item} />;
    case "group":
      return <GroupRow item={item} />;
    case "shell":
      return <ShellBlock item={item} />;
    case "diff":
      return <DiffBlock item={item} />;
    case "note":
      return <NoteRow item={item} onFixKey={onFixKey} />;
    case "plan-done":
      return (
        <div className="flex items-center gap-2 py-[3px] text-[12.5px] text-success">
          <span className="flex w-4 justify-center">
            <ListChecks className="size-3.5" />
          </span>
          Plan complete · {item.steps}/{item.steps} steps
        </div>
      );
  }
});

// The agent's own checklist, pinned while steps remain (live.go:367-380): ☑ done, ◼ doing, ☐ next.
export function TodoList({ todos, color }: { todos: Todo[]; color: string }) {
  const done = todos.filter((t) => t.status === "done").length;
  return (
    <motion.div layout initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="rounded-lg border bg-muted/30 px-3 py-2">
      <div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
        <ListChecks className="size-3.5" /> Plan
        <span className="ml-auto tabular">
          {done}/{todos.length}
        </span>
      </div>
      <div className="mb-2 h-1 overflow-hidden rounded-full bg-muted">
        <motion.div className="h-full rounded-full" style={{ background: color }} animate={{ width: `${(done / todos.length) * 100}%` }} />
      </div>
      <ul className="space-y-0.5 text-[12.5px]">
        {todos.map((t, i) => (
          <li key={i} className={cn("flex gap-2", t.status === "done" && "text-muted-foreground line-through decoration-muted-foreground/40", t.status === "doing" && "font-medium text-foreground")}>
            <span className={cn("font-mono", t.status === "done" ? "text-success" : t.status === "doing" ? "text-primary" : "text-muted-foreground/60")}>{t.status === "done" ? "☑" : t.status === "doing" ? "◼" : "☐"}</span>
            <span className="min-w-0 [overflow-wrap:anywhere]">{t.text}</span>
          </li>
        ))}
      </ul>
    </motion.div>
  );
}
