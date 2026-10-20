import { useEffect, useMemo, useState } from "react";
import { LayoutGroup } from "motion/react";
import { CircleDashed, CircleDot, CircleCheck, CircleX, KanbanSquare, ListChecks, Network, ArrowRight, Target, Send } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { PixelAvatar } from "@/components/pixel-avatar";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AgentAvatar } from "@/components/agent-avatar";
import { AnimatedNumber } from "@/components/number";
import { Spinner } from "@/components/spinner";
import { statusColor, TASK_GLYPH } from "@/lib/identity";
import { taskCounts } from "@/lib/reducer";
import type { Task, TaskStatus } from "@/lib/types";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { Markdown } from "@/features/session/markdown";
import { TaskGraph } from "./task-graph";
import { TaskCard } from "./task-card";

const COLUMNS: { status: TaskStatus; label: string; icon: typeof CircleDot }[] = [
  { status: "pending", label: "Waiting", icon: CircleDashed },
  { status: "in_progress", label: "In progress", icon: CircleDot },
  { status: "done", label: "Done", icon: CircleCheck },
  { status: "failed", label: "Failed", icon: CircleX },
];

export default function TasksPage() {
  const tasks = useApp((s) => s.session.tasks);
  const goal = useApp((s) => s.session.goal);
  const active = useApp((s) => s.session.active);
  const status = useApp((s) => s.session.status);
  const agents = useApp((s) => s.session.agents);
  const [view, setView] = useState<"board" | "graph">(() => (localStorage.getItem("niti.tasksView") as "board" | "graph") ?? "board");
  const [openId, setOpenId] = useState<string | null>(null);
  const c = taskCounts(tasks);
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;

  const setViewSaved = (v: "board" | "graph") => {
    setView(v);
    try {
      localStorage.setItem("niti.tasksView", v);
    } catch {
      /* fine */
    }
  };

  if (!tasks.length) return <NoTasks />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header data-audit="section" className="relative shrink-0 overflow-hidden border-b px-6 pb-4 pt-6">
        <span aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_140%_at_12%_-20%,color-mix(in_oklab,var(--primary)_12%,transparent),transparent_70%)]" />
        <div className="relative flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <Target className="size-3.5" /> Goal
              {active && (
                <span className="flex items-center gap-1 normal-case tracking-normal text-info">
                  <Spinner className="text-info" /> running
                </span>
              )}
            </div>
            <h1 className="line-clamp-2 text-lg font-semibold leading-snug tracking-tight">{goal || "Current plan"}</h1>
            {status && !active && <p className="mt-1 text-xs text-muted-foreground">{status}</p>}
          </div>
          <ToggleGroup type="single" variant="outline" size="sm" value={view} onValueChange={(v) => v && setViewSaved(v as "board" | "graph")}>
            <ToggleGroupItem value="board" className="gap-1.5 px-3 text-xs">
              <KanbanSquare className="size-3.5" /> Board
            </ToggleGroupItem>
            <ToggleGroupItem value="graph" className="gap-1.5 px-3 text-xs">
              <Network className="size-3.5" /> Dependencies
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="mt-4 flex items-center gap-4">
          <Progress value={pct} className="h-1.5 flex-1" />
          <span className="text-sm font-semibold tabular">
            <AnimatedNumber value={c.done} format={(n) => String(Math.round(n))} />/{c.total}
          </span>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {c.running > 0 && <span className="text-info">{c.running} running</span>}
            {c.pending > 0 && <span>{c.pending} waiting</span>}
            {c.failed > 0 && <span className="text-destructive">{c.failed} failed</span>}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {view === "board" ? (
          <LayoutGroup>
            <div className="grid h-full min-h-0 grid-cols-4 gap-4 p-6">
              {COLUMNS.map((col) => {
                const list = tasks.filter((t) => t.status === col.status);
                return (
                  <div key={col.status} className="flex min-h-0 flex-col rounded-xl bg-muted/40">
                    <div className="flex items-center gap-2 px-3 py-2.5">
                      <col.icon className="size-3.5" style={{ color: statusColor(col.status) }} />
                      <span className="text-[12.5px] font-semibold">{col.label}</span>
                      <span className="ml-auto rounded-full bg-background px-1.5 text-[11px] text-muted-foreground tabular">{list.length}</span>
                    </div>
                    <ScrollArea className="min-h-0 flex-1">
                      <div className="flex flex-col gap-2 px-2 pb-2">
                        {list.map((t) => (
                          <TaskCard key={t.id} task={t} agents={agents} onOpen={() => setOpenId(t.id)} />
                        ))}
                        {list.length === 0 && <div className="h-20 rounded-lg border border-dashed" />}
                      </div>
                    </ScrollArea>
                  </div>
                );
              })}
            </div>
          </LayoutGroup>
        ) : (
          <TaskGraph tasks={tasks} agents={agents} onOpen={setOpenId} />
        )}
      </div>
      <TaskSheet id={openId} onClose={() => setOpenId(null)} onOpen={setOpenId} />
    </div>
  );
}

function TaskSheet({ id, onClose, onOpen }: { id: string | null; onClose: () => void; onOpen: (id: string) => void }) {
  const tasks = useApp((s) => s.session.tasks);
  const agents = useApp((s) => s.session.agents);
  const order = useApp((s) => s.session.order);
  const api = useApp((s) => s.api);
  const [full, setFull] = useState<Task | null>(null);
  const task = tasks.find((t) => t.id === id) ?? null;

  // The board's tasks come from plan events; acceptance and output live on the core's copy.
  useEffect(() => {
    setFull(null);
    if (!id || !api) return;
    void api.session().then((s) => setFull(s.tasks.find((t) => t.id === id) ?? null)).catch(() => {});
  }, [id, api, task?.status]);

  const t = task ? { ...full, ...task, output: full?.output ?? task.output, acceptance: full?.acceptance ?? task.acceptance, handoffTo: full?.handoffTo ?? task.handoffTo } : null;
  const who = t ? agents[t.assignedTo ?? t.role ?? ""] : undefined;
  const dependents = useMemo(() => (t ? tasks.filter((x) => x.dependsOn?.includes(t.id)) : []), [tasks, t]);

  return (
    <Sheet open={Boolean(t)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[min(560px,92vw)] gap-0 sm:max-w-none">
        {t && (
          <>
            <SheetHeader className="border-b">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono">{t.id}</span>
                <span className="flex items-center gap-1 capitalize" style={{ color: statusColor(t.status) }}>
                  {TASK_GLYPH[t.status]} {t.status.replace("_", " ")}
                </span>
              </div>
              <SheetTitle className="text-base leading-snug">{t.description}</SheetTitle>
              <SheetDescription className="sr-only">Task details</SheetDescription>
            </SheetHeader>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-5 p-4">
                <Field label="Assigned to">
                  {t.status === "pending" ? (
                    <Select
                      value={t.assignedTo ?? t.role ?? ""}
                      onValueChange={async (v) => {
                        try {
                          await api?.reassign(t.id, v);
                          toast.success(`${t.id} → ${agents[v]?.cfg.role ?? v}`);
                        } catch (e) {
                          toast.error((e as Error).message);
                        }
                      }}
                    >
                      <SelectTrigger className="h-8 w-60">
                        <SelectValue placeholder="Pick an agent" />
                      </SelectTrigger>
                      <SelectContent>
                        {order.map((aid) => (
                          <SelectItem key={aid} value={aid}>
                            <span className="font-mono" style={{ color: agents[aid]!.color }}>
                              <PixelAvatar slot={agents[aid]!.index} color={agents[aid]!.color} size={14} />
                            </span>
                            {agents[aid]!.cfg.role}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : who ? (
                    <span className="flex items-center gap-2 text-sm">
                      <AgentAvatar slot={who.index} color={who.color} size="xs" /> {who.cfg.role} <span className="font-mono text-xs text-muted-foreground">{who.cfg.model}</span>
                    </span>
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </Field>
                {(t.dependsOn?.length ?? 0) > 0 && (
                  <Field label="Waits for">
                    <div className="flex flex-wrap gap-1.5">
                      {t.dependsOn!.map((d) => (
                        <Button key={d} variant="outline" size="xs" className="font-mono" onClick={() => onOpen(d)}>
                          {TASK_GLYPH[tasks.find((x) => x.id === d)?.status ?? "pending"]} {d}
                        </Button>
                      ))}
                    </div>
                  </Field>
                )}
                {dependents.length > 0 && (
                  <Field label="Unblocks">
                    <div className="flex flex-wrap gap-1.5">
                      {dependents.map((d) => (
                        <Button key={d.id} variant="outline" size="xs" className="font-mono" onClick={() => onOpen(d.id)}>
                          {d.id} <ArrowRight className="size-3" />
                        </Button>
                      ))}
                    </div>
                  </Field>
                )}
                {(t.handoffTo?.length ?? 0) > 0 && (
                  <Field label="Hands off to">
                    <div className="flex flex-wrap gap-1.5">
                      {t.handoffTo!.map((h) => (
                        <Badge key={h} variant="secondary" className="gap-1">
                          <Send className="size-3" /> {agents[h]?.cfg.role ?? h}
                        </Badge>
                      ))}
                    </div>
                  </Field>
                )}
                {t.acceptance && (
                  <Field label="Done when">
                    <p className="text-sm leading-relaxed">{t.acceptance}</p>
                  </Field>
                )}
                {(t.attempts ?? 0) > 0 && (
                  <Field label="Attempts">
                    <span className="text-sm">{t.attempts}</span>
                  </Field>
                )}
                <Field label="Result">
                  {t.output ? (
                    <div className="rounded-lg border bg-muted/30 p-3">
                      <Markdown text={t.output} className="text-[13px]" />
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t.status === "in_progress" ? "Still working…" : t.status === "pending" ? "Not started." : "No result text."}</p>
                  )}
                </Field>
              </div>
            </ScrollArea>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function NoTasks() {
  const go = useUI((s) => s.go);
  const setMode = useApp((s) => s.setMode);
  return (
    <div className="h-full p-6">
      <EmptyState
        icon={ListChecks}
        title="No tasks yet"
        description="Plan a goal and the lead splits it into tasks here."
        action={
          <Button
            onClick={() => {
              setMode("plan");
              go("session");
              setTimeout(() => window.dispatchEvent(new Event("niti:focus-composer")), 60);
            }}
          >
            <ListChecks /> Plan something
          </Button>
        }
      />
    </div>
  );
}
