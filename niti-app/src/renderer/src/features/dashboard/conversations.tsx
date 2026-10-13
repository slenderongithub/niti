import { memo, useMemo, useState } from "react";
import { ArrowDown, ChevronDown, MessagesSquare, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AgentAvatar } from "@/components/agent-avatar";
import { EmptyState } from "@/components/empty-state";
import { SectionCard } from "@/components/layout";
import { fmtClock } from "@/lib/format";
import { useFollow } from "@/hooks/use-follow";
import { messageColor, tint } from "@/lib/identity";
import type { AgentView, FeedItem } from "@/lib/reducer";
import type { AgentMessage, MessageKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { Markdown } from "@/features/session/markdown";

// What the agents say to each other — hand-offs, questions, answers, reviews — threaded by pair,
// chat-style. The TUI shows one line of this at a time; here it's the main event.

const KINDS: (MessageKind | "all")[] = ["all", "handoff", "question", "answer", "review", "artifact", "note", "broadcast"];
const pairKey = (m: AgentMessage) => (m.to === "*" ? "*" : [m.from, m.to].sort().join("\u0000"));

export function Conversations() {
  const feed = useApp((s) => s.session.feed);
  const agents = useApp((s) => s.session.agents);
  const [thread, setThread] = useState<string>("all");
  const [kind, setKind] = useState<MessageKind | "all">("all");

  const threads = useMemo(() => {
    const map = new Map<string, { key: string; a: string; b: string; count: number; last: AgentMessage }>();
    for (const it of feed) {
      if (it.kind !== "message") continue;
      const k = pairKey(it.message);
      const [a, b] = k === "*" ? [it.message.from, "*"] : k.split("\u0000");
      const t = map.get(k) ?? { key: k, a: a!, b: b!, count: 0, last: it.message };
      t.count++;
      t.last = it.message;
      map.set(k, t);
    }
    return [...map.values()].sort((x, y) => y.last.time - x.last.time);
  }, [feed]);

  const items = useMemo(
    () =>
      feed.filter((it) => {
        if (it.kind === "event") return thread === "all" && kind === "all";
        if (kind !== "all" && it.message.kind !== kind) return false;
        return thread === "all" || pairKey(it.message) === thread;
      }),
    [feed, thread, kind],
  );
  const messages = feed.filter((f) => f.kind === "message").length;
  const name = (id: string) => (id === "*" ? "Everyone" : id === "orchestrator" ? "Orchestrator" : id === "user" ? "You" : (agents[id]?.cfg.role ?? id));

  return (
    <SectionCard
      title="Conversations"
      icon={MessagesSquare}
      flush
      action={
        <Select value={kind} onValueChange={(v) => setKind(v as MessageKind | "all")}>
          <SelectTrigger size="sm" className="h-8 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {KINDS.map((k) => (
              <SelectItem key={k} value={k} className="text-xs capitalize">
                {k !== "all" && <span className="size-2 rounded-full" style={{ background: messageColor(k) }} />}
                {k === "all" ? "All kinds" : k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {messages === 0 && !feed.length ? (
        <div className="h-[460px] p-5">
          <EmptyState icon={MessagesSquare} title="No conversations yet" description="Hand-offs, questions and reviews between agents appear here." />
        </div>
      ) : (
        <div className="grid h-[460px] grid-cols-[248px_1fr]">
          <ScrollArea className="border-r">
            <div className="flex flex-col gap-1 p-2">
              <ThreadButton active={thread === "all"} onClick={() => setThread("all")} title="All activity" sub={`${messages} message${messages === 1 ? "" : "s"}`} count={feed.length}>
                <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
                  <Radio className="size-4 text-muted-foreground" />
                </span>
              </ThreadButton>
              {threads.map((t) => (
                <ThreadButton key={t.key} active={thread === t.key} onClick={() => setThread(t.key)} title={t.b === "*" ? `${name(t.a)} → everyone` : `${name(t.a)} ↔ ${name(t.b)}`} sub={t.last.subject} count={t.count}>
                  <PairAvatars a={agents[t.a]} b={t.b === "*" ? undefined : agents[t.b]} />
                </ThreadButton>
              ))}
            </div>
          </ScrollArea>
          <Stream items={items} agents={agents} name={name} />
        </div>
      )}
    </SectionCard>
  );
}

function ThreadButton({ active, onClick, title, sub, count, children }: { active: boolean; onClick: () => void; title: string; sub: string; count: number; children: React.ReactNode }) {
  return (
    <Button variant="ghost" onClick={onClick} className={cn("h-14 w-full min-w-0 justify-start gap-2.5 rounded-lg px-2 text-left font-normal", active && "bg-muted hover:bg-muted")}>
      {children}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium leading-5">{title}</span>
        <span className="block truncate text-[11px] leading-4 text-muted-foreground">{sub}</span>
      </span>
      <span className="shrink-0 rounded-full bg-background px-1.5 text-[10.5px] text-muted-foreground tabular">{count}</span>
    </Button>
  );
}

function PairAvatars({ a, b }: { a?: AgentView; b?: AgentView }) {
  return (
    <span className="relative flex size-9 shrink-0">
      {a ? <AgentAvatar slot={a.index} color={a.color} size="xs" className="absolute left-0 top-0" /> : <span className="absolute left-0 top-0 size-5 rounded-md bg-muted" />}
      {b ? <AgentAvatar slot={b.index} color={b.color} size="xs" className="absolute bottom-0 right-0 rounded-md ring-2 ring-card" /> : <span className="absolute bottom-0 right-0 flex size-5 items-center justify-center rounded-md bg-muted text-[9px] text-muted-foreground ring-2 ring-card">all</span>}
    </span>
  );
}

function Stream({ items, agents, name }: { items: FeedItem[]; agents: Record<string, AgentView>; name: (id: string) => string }) {
  const { ref, onScroll, unseen, jump } = useFollow(items.length);
  return (
    <div className="relative min-h-0">
      <div
        ref={ref}
        onScroll={onScroll}
        className="h-full overflow-y-auto px-5 py-4 scrollbar-thin"
      >
        {items.length === 0 ? (
          <EmptyState compact icon={MessagesSquare} title="Nothing in this thread for that filter" />
        ) : (
          <div className="flex flex-col gap-3">
            {items.map((it) => (it.kind === "event" ? <SystemLine key={it.id} text={it.text} time={it.time} /> : <Message key={it.id} m={it.message} from={agents[it.message.from]} name={name} />))}
          </div>
        )}
      </div>
      {unseen > 0 && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute bottom-3 left-1/2 h-7 -translate-x-1/2 gap-1.5 rounded-full border px-3 text-xs shadow-md"
          onClick={jump}
        >
          <ArrowDown /> {unseen} new
        </Button>
      )}
    </div>
  );
}

function SystemLine({ text, time }: { text: string; time: number }) {
  return (
    <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span className="max-w-[70%] truncate">{text}</span>
      <span className="tabular">{fmtClock(time)}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

const Message = memo(function Message({ m, from, name }: { m: AgentMessage; from?: AgentView; name: (id: string) => string }) {
  const [open, setOpen] = useState(false);
  const color = messageColor(m.kind);
  const long = m.body.length > 280 || m.body.split("\n").length > 4;
  return (
    <div className="flex gap-3 animate-in fade-in duration-200">
      {from ? <AgentAvatar slot={from.index} color={from.color} size="sm" /> : <span className="size-7 shrink-0 rounded-lg bg-muted" />}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-[12px] leading-5">
          <span className="truncate font-semibold" style={{ color: from?.color }}>
            {name(m.from)}
          </span>
          <span className="shrink-0 text-muted-foreground">→</span>
          <span className="truncate font-medium">{name(m.to)}</span>
          <Badge variant="outline" className="h-5 shrink-0 gap-1 border-transparent px-1.5 text-[10.5px] capitalize" style={{ background: tint(color, 14), color }}>
            {m.kind}
          </Badge>
          <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground tabular">{fmtClock(m.time)}</span>
        </div>
        <div className="mt-1 rounded-lg rounded-tl-sm border bg-muted/30 px-3 py-2">
          {m.subject && <div className="text-[13px] font-medium leading-5">{m.subject}</div>}
          {m.body && m.body !== m.subject && (
            <div className={cn("relative mt-1", !open && long && "max-h-24 overflow-hidden")}>
              <Markdown text={m.body} className="text-[12.5px] text-muted-foreground" />
              {!open && long && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-card to-transparent" />}
            </div>
          )}
          {long && (
            <Button variant="ghost" size="xs" className="-ml-1.5 mt-1 h-6 gap-1 text-[11px] text-muted-foreground" onClick={() => setOpen((o) => !o)}>
              <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} /> {open ? "Less" : "More"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
});
