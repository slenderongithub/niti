import { useEffect, useState } from "react";
import { Activity, ArrowRight, Bell, CircleDashed, Coins, FileDiff, FilePen, FilePlus2, ListChecks, Repeat, Send, Users, Zap, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { AgentAvatar } from "@/components/agent-avatar";
import { AnimatedNumber } from "@/components/number";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader, SectionCard, StatTile } from "@/components/layout";
import { Spinner } from "@/components/spinner";
import { fmtCost, fmtTokens } from "@/lib/format";
import { fmtDur } from "@/lib/humanize";
import { statusColor, TASK_GLYPH } from "@/lib/identity";
import { taskCounts } from "@/lib/reducer";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { useApprovalUI } from "@/features/approvals/approval-center";
import { AgentPanel } from "@/features/session/agent-transcript";
import { Conversations } from "./conversations";

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export default function DashboardPage() {
  const s = useApp((x) => x.session);
  const go = useUI((x) => x.go);
  const viewFile = useUI((x) => x.viewFile);
  const showApprovals = useApprovalUI((x) => x.show);
  const [inspect, setInspect] = useState<string | null>(null);
  const c = taskCounts(s.tasks);
  const now = useNow(s.active);
  const total = s.totals.inputTokens + s.totals.outputTokens;
  const working = s.order.filter((id) => s.agents[id]!.status === "working").length;
  const changed = Object.entries(s.touched).filter(([, k]) => k !== "R");

  return (
    <Page wide>
      <PageHeader title="Dashboard" description={s.goal ? `Goal: ${s.goal}` : undefined} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatTile
          icon={Activity}
          label="Run"
          tone={s.active ? "var(--info)" : undefined}
          value={
            <span className="flex items-center gap-2 text-xl">
              {s.active ? <Spinner className="text-info" /> : s.summary ? <CheckCircle2 className={cn("size-5", s.summary.ok ? "text-success" : "text-warning")} /> : <CircleDashed className="size-5 text-muted-foreground" />}
              {s.active ? "Running" : s.summary ? (s.summary.cancelled ? "Cancelled" : s.summary.ok ? "Done" : "Failures") : "Idle"}
            </span>
          }
          sub={s.active && s.runStartedAt ? `${fmtDur(now - s.runStartedAt)} · ${working} working` : s.summary ? `took ${fmtDur(s.summary.durationMs)}` : "waiting for a goal"}
        />
        <StatTile
          icon={ListChecks}
          label="Tasks"
          value={
            <>
              <AnimatedNumber value={c.done} format={(n) => String(Math.round(n))} />
              <span className="text-muted-foreground">/{c.total}</span>
            </>
          }
          sub={<Progress value={c.total ? (c.done / c.total) * 100 : 0} className="mt-1.5 h-1" />}
        />
        <StatTile icon={Zap} label="Tokens" value={<AnimatedNumber value={total} />} sub={`${s.totals.calls} model calls`} />
        <StatTile icon={Coins} label="Cost" tone="var(--success)" value={<AnimatedNumber value={s.cost} format={(n) => fmtCost(n, s.costKnown)} />} sub="this session" />
        <StatTile
          icon={Bell}
          label="Waiting on you"
          tone={s.approvals.length ? "var(--warning)" : undefined}
          value={<span className={cn(s.approvals.length > 0 && "text-warning")}>{s.approvals.length}</span>}
          sub={s.approvals.length ? "click to review" : "no approvals pending"}
          onClick={s.approvals.length ? showApprovals : undefined}
          className={cn(s.approvals.length > 0 && "border-warning/50 bg-warning/5")}
        />
      </div>

      <Conversations />

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard title="Agents" icon={Users} flush className="h-[340px]">
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-1 p-2">
              {s.order.map((id) => {
                const a = s.agents[id]!;
                const ctx = a.ctxLimit ? Math.min(100, (a.usage.lastInput * 100) / a.ctxLimit) : 0;
                return (
                  <Button key={id} variant="ghost" onClick={() => setInspect(id)} className="h-14 w-full min-w-0 justify-start gap-3 rounded-lg px-2 text-left font-normal">
                    <AgentAvatar slot={a.index} color={a.color} lead={id === s.leadId} status={a.status} showStatus size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium leading-5">{a.cfg.role}</span>
                      <span className="block truncate text-[11px] leading-4 text-muted-foreground">{a.status === "working" ? a.activity || "thinking…" : `${a.cfg.model} · ${a.status}`}</span>
                    </span>
                    <span className="flex w-16 shrink-0 flex-col items-end gap-1">
                      <span className="font-mono text-[11px] leading-4 text-muted-foreground tabular">{fmtTokens(a.usage.inputTokens + a.usage.outputTokens)}</span>
                      <span className="h-1 w-full overflow-hidden rounded-full bg-muted">
                        <span className="block h-full rounded-full" style={{ width: `${ctx}%`, background: ctx >= 80 ? "var(--destructive)" : ctx >= 60 ? "var(--warning)" : a.color }} />
                      </span>
                    </span>
                  </Button>
                );
              })}
            </div>
          </ScrollArea>
        </SectionCard>

        <SectionCard title="Changed files" icon={FileDiff} flush className="h-[340px]" description={`${changed.length} file${changed.length === 1 ? "" : "s"} this session`}>
          {changed.length === 0 ? (
            <div className="h-full p-4">
              <EmptyState compact icon={FileDiff} title="No files changed yet" description="Files the agents create or edit appear here." />
            </div>
          ) : (
            <ScrollArea className="h-full">
              <div className="flex flex-col gap-0.5 p-2">
                {changed.map(([p, k]) => (
                  <Button key={p} variant="ghost" size="sm" className="h-8 w-full min-w-0 justify-start gap-2 px-2 font-mono text-[12px] font-normal" onClick={() => viewFile(p)}>
                    {k === "A" ? <FilePlus2 className="text-success" /> : <FilePen className="text-warning" />}
                    <span className="truncate">{p}</span>
                  </Button>
                ))}
              </div>
            </ScrollArea>
          )}
        </SectionCard>

        <SectionCard
          title="Tasks"
          icon={ListChecks}
          flush
          className="h-[340px]"
          description={c.total ? `${c.done} of ${c.total} done` : "No plan yet"}
          action={
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => go("tasks")}>
              Board <ArrowRight />
            </Button>
          }
        >
          {s.tasks.length === 0 ? (
            <div className="h-full p-4">
              <EmptyState compact icon={ListChecks} title="No plan yet" description="The lead's tasks show up here." />
            </div>
          ) : (
            <ScrollArea className="h-full">
              <ul className="flex flex-col gap-1 p-3">
                {s.tasks.map((t) => (
                  <li key={t.id} className="flex min-w-0 items-start gap-2 rounded-md px-1 py-1 text-[12.5px] leading-[18px]">
                    <span className="w-3 shrink-0 text-center font-mono" style={{ color: statusColor(t.status) }}>
                      {TASK_GLYPH[t.status]}
                    </span>
                    <span className={cn("min-w-0 flex-1 break-words", t.status === "done" && "text-muted-foreground")}>{t.description}</span>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}
        </SectionCard>
      </div>
      <AgentInspector id={inspect} onClose={() => setInspect(null)} />
    </Page>
  );
}

function AgentInspector({ id, onClose }: { id: string | null; onClose: () => void }) {
  const a = useApp((s) => (id ? s.session.agents[id] : undefined));
  const api = useApp((s) => s.api);
  const lead = useApp((s) => s.session.leadId);
  const setModelPicker = useUI((s) => s.setModelPicker);
  const focusAgent = useUI((s) => s.focusAgent);
  const go = useUI((s) => s.go);
  const [msg, setMsg] = useState("");
  const send = async () => {
    if (!a || !msg.trim() || !api) return;
    try {
      await api.messageAgent(a.id, msg.trim());
      toast.success(`→ ${a.cfg.role}`, { description: "It reads it at its next step." });
      setMsg("");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <Sheet open={Boolean(a)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[min(640px,94vw)] gap-0 sm:max-w-none">
        {a && (
          <>
            <SheetHeader className="flex-row items-center gap-3 border-b pr-12">
              <AgentAvatar slot={a.index} color={a.color} lead={a.id === lead} status={a.status} showStatus size="lg" />
              <div className="min-w-0">
                <SheetTitle style={{ color: a.color }}>{a.cfg.role}</SheetTitle>
                <SheetDescription className="font-mono text-xs">
                  {a.cfg.provider}/{a.cfg.model}
                </SheetDescription>
              </div>
            </SheetHeader>
            <div className="flex gap-2 border-b px-4 py-2.5">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  focusAgent(a.id);
                  setModelPicker(true);
                }}
              >
                <Repeat /> Switch model
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  focusAgent(a.id);
                  go("session");
                }}
              >
                <ArrowRight /> Open in session
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <AgentPanel agent={a} />
            </div>
            <form
              className="flex gap-2 border-t p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <Input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={a.status === "working" ? `Message ${a.cfg.role} mid-task…` : `${a.cfg.role} isn't working right now`} disabled={a.status !== "working"} />
              <Button type="submit" size="icon" disabled={!msg.trim() || a.status !== "working"} aria-label="Send">
                <Send />
              </Button>
            </form>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
