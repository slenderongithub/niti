import { useEffect, useMemo, useRef, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ArrowDownToLine, ArrowUpFromLine, CalendarDays, Coins, Database, Flame, Gauge, History, Layers, Loader2, Activity, BarChart3, Star, Timer, Zap, RefreshCw, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentAvatar } from "@/components/agent-avatar";
import { AnimatedNumber } from "@/components/number";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader, SectionCard, StatTile } from "@/components/layout";
import { fmtAgo, fmtCost, fmtInt, fmtTokens } from "@/lib/format";
import { fmtDur, truncate } from "@/lib/humanize";
import type { Stats } from "@/lib/types";
import { dayKey, streaks } from "@/lib/stats";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";

export default function TokensPage() {
  const [tab, setTab] = useState(() => localStorage.getItem("niti.tokensTab") ?? "session");
  const pick = (v: string) => {
    setTab(v);
    try {
      localStorage.setItem("niti.tokensTab", v);
    } catch {
      /* fine */
    }
  };
  return (
    <Page>
      <PageHeader
        icon={Coins}
        title="Tokens"
        actions={
          <Tabs value={tab} onValueChange={pick}>
            <TabsList className="h-8">
              <TabsTrigger value="session" className="px-3 text-xs">
                This session
              </TabsTrigger>
              <TabsTrigger value="all" className="px-3 text-xs">
                All time
              </TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />
      {tab === "session" ? <SessionTokens /> : <AllTime />}
    </Page>
  );
}

function SessionTokens() {
  const s = useApp((x) => x.session);
  const order = s.order;
  const total = s.totals.inputTokens + s.totals.outputTokens;
  const cacheRead = s.totals.cacheReadTokens ?? order.reduce((n, id) => n + (s.agents[id]!.usage.cacheReadTokens ?? 0), 0);
  const cacheShare = s.totals.inputTokens ? Math.round((cacheRead * 100) / s.totals.inputTokens) : 0;
  const data = order.map((id) => ({ name: s.agents[id]!.cfg.role, input: s.agents[id]!.usage.inputTokens, output: s.agents[id]!.usage.outputTokens }));
  const config: ChartConfig = { input: { label: "Input", color: "var(--chart-1)" }, output: { label: "Output", color: "var(--chart-2)" } };

  return (
    <>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatTile icon={Layers} label="Total tokens" value={<AnimatedNumber value={total} />} sub={`${fmtInt(total)} exactly`} />
        <StatTile icon={ArrowDownToLine} label="Input" value={<AnimatedNumber value={s.totals.inputTokens} />} sub="prompts and context" />
        <StatTile icon={ArrowUpFromLine} label="Output" value={<AnimatedNumber value={s.totals.outputTokens} />} sub="what the models wrote" />
        <StatTile icon={Database} label="Cache read" value={<AnimatedNumber value={cacheRead} />} sub={cacheShare ? `${cacheShare}% of input` : "no cache hits yet"} />
        <StatTile icon={Zap} label="Model calls" value={<AnimatedNumber value={s.totals.calls} format={(n) => fmtInt(n)} />} sub="this session" />
        <StatTile icon={Coins} label="Cost" tone="var(--success)" value={<AnimatedNumber value={s.cost} format={(n) => fmtCost(n, s.costKnown)} />} sub={s.costKnown ? "this session" : "some models have no price"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="By agent" icon={Users} className="h-[340px]">
          {total === 0 ? (
            <EmptyState compact icon={BarChart3} title="No calls yet" description="Usage appears as agents work." />
          ) : (
            <ChartContainer config={config} className="h-full w-full">
              <BarChart data={data} layout="vertical" margin={{ left: 4, right: 12 }}>
                <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                <XAxis type="number" tickFormatter={(v) => fmtTokens(Number(v))} tickLine={false} axisLine={false} fontSize={11} />
                <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={90} fontSize={11.5} />
                <ChartTooltip cursor={{ fill: "var(--muted)", opacity: 0.5 }} content={<ChartTooltipContent formatter={(v, n) => `${n === "input" ? "Input" : "Output"}  ${fmtInt(Number(v))}`} />} />
                <Bar dataKey="input" stackId="t" fill="var(--color-input)" radius={[4, 0, 0, 4]} isAnimationActive={false} />
                <Bar dataKey="output" stackId="t" fill="var(--color-output)" radius={[0, 4, 4, 0]} isAnimationActive={false} />
              </BarChart>
            </ChartContainer>
          )}
        </SectionCard>

        <SectionCard title="Context windows" icon={Gauge} className="h-[340px]" contentClassName="overflow-y-auto">
          <div className="flex flex-col gap-4">
            {order.map((id) => {
              const a = s.agents[id]!;
              const pct = a.ctxLimit ? Math.min(100, (a.usage.lastInput * 100) / a.ctxLimit) : 0;
              return (
                <div key={id}>
                  <div className="mb-1.5 flex min-w-0 items-center gap-2 text-[12.5px]">
                    <AgentAvatar slot={a.index} color={a.color} size="xs" />
                    <span className="truncate font-medium">{a.cfg.role}</span>
                    <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground tabular">
                      {fmtTokens(a.usage.lastInput)} / {fmtTokens(a.ctxLimit)}
                    </span>
                    <span className={cn("w-10 shrink-0 text-right text-[11px] font-semibold tabular", pct >= 80 ? "text-destructive" : pct >= 60 ? "text-warning" : "text-muted-foreground")}>{Math.round(pct)}%</span>
                  </div>
                  <div className="relative h-2 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: pct >= 80 ? "var(--destructive)" : pct >= 60 ? "var(--warning)" : a.color }} />
                    <span className="absolute inset-y-0 left-[80%] w-px bg-background/80" />
                  </div>
                  <div className="mt-1 flex gap-3 text-[11px] text-muted-foreground tabular">
                    <span>{fmtInt(a.usage.calls)} calls</span>
                    {(a.usage.cacheReadTokens ?? 0) > 0 && <span>{fmtTokens(a.usage.cacheReadTokens!)} cached</span>}
                    {(a.usage.reasoningTokens ?? 0) > 0 && <span>{fmtTokens(a.usage.reasoningTokens!)} thinking</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </SectionCard>
      </div>

      {s.rateLimits.length > 0 && (
        <SectionCard title="Rate limits" icon={Activity}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {s.rateLimits.map((r) => (
              <div key={r.provider} className="rounded-lg border px-3 py-2.5 text-xs">
                <div className="font-medium">{r.provider}</div>
                <div className="mt-0.5 flex gap-3 text-muted-foreground tabular">
                  {r.remainingTokens !== undefined && <span>{fmtTokens(r.remainingTokens)} tokens</span>}
                  {r.remainingRequests !== undefined && <span>{fmtInt(r.remainingRequests)} requests</span>}
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      <SectionCard title="Runs" icon={History} flush>
        {s.runs.length === 0 ? (
          <div className="h-[160px] p-5">
            <EmptyState compact icon={History} title="No finished runs yet" description="Each run appears here with what it took and cost." />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Goal</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="text-right">Time</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="pr-5 text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...s.runs].reverse().map((r, i) => (
                <TableRow key={i}>
                  <TableCell className="max-w-[420px] truncate pl-5 text-[12.5px]">
                    {truncate(r.goal, 90)}
                    <div className="text-[11px] text-muted-foreground">{fmtAgo(r.at)}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn("text-[11px]", r.cancelled ? "" : r.ok ? "border-success/40 text-success" : "border-warning/40 text-warning")}>
                      {r.cancelled ? "cancelled" : r.ok ? "done" : "failures"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-[12px] tabular">{fmtDur(r.durationMs)}</TableCell>
                  <TableCell className="text-right font-mono text-[12px] tabular">{fmtTokens(r.tokens)}</TableCell>
                  <TableCell className="pr-5 text-right font-mono text-[12px] tabular">{fmtCost(r.cost, r.costKnown)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </>
  );
}

function AllTime() {
  const api = useApp((s) => s.api);
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    setErr(null);
    void api
      ?.stats()
      .then(setStats)
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(load, [api]); // eslint-disable-line react-hooks/exhaustive-deps
  const info = useMemo(() => (stats ? streaks(stats.perDay) : null), [stats]);

  if (err) return <EmptyState icon={BarChart3} title="Couldn't load history" description={err} />;
  if (!stats || !info)
    return (
      <div className="flex h-40 items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );

  const total = stats.inTokens + stats.outTokens;
  const fav = stats.perModel.slice().sort((a, b) => b.inTokens + b.outTokens - (a.inTokens + a.outTokens))[0];
  const last90 = (() => {
    const map = new Map(stats.perDay.map((d) => [d.date, d.tokens]));
    const out: { date: string; tokens: number }[] = [];
    const d = new Date();
    d.setDate(d.getDate() - 89);
    for (let i = 0; i < 90; i++) {
      const k = dayKey(d);
      out.push({ date: k, tokens: map.get(k) ?? 0 });
      d.setDate(d.getDate() + 1);
    }
    return out;
  })();
  const maxModel = Math.max(1, ...stats.perModel.map((m) => m.inTokens + m.outTokens));

  return (
    <>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatTile icon={Layers} label="Total tokens" value={<AnimatedNumber value={total} />} sub={`${fmtTokens(stats.inTokens)} in · ${fmtTokens(stats.outTokens)} out`} />
        <StatTile icon={Coins} label="Spent" tone="var(--success)" value={<AnimatedNumber value={stats.totalUsd} format={(n) => fmtCost(n, stats.costComplete)} />} sub={stats.costComplete ? "all priced" : "some models unpriced"} />
        <StatTile icon={Gauge} label="Sessions" value={fmtInt(stats.sessions)} sub="agent conversations" />
        <StatTile icon={CalendarDays} label="Active days" value={fmtInt(info.activeDays)} sub="with any activity" />
        <StatTile icon={Flame} label="Streak" tone="var(--warning)" value={`${info.current}d`} sub={`longest ${info.longest}d`} />
        <StatTile icon={Timer} label="Longest session" value={stats.longestSessionMs ? fmtDur(stats.longestSessionMs) : "—"} sub="one agent, start to end" />
      </div>

      <SectionCard
        title="Activity"
        icon={CalendarDays}
        action={
          <Button variant="ghost" size="icon-sm" onClick={load} aria-label="Refresh">
            <RefreshCw />
          </Button>
        }
      >
        <Heatmap perDay={stats.perDay} />
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <SectionCard title="Last 90 days" icon={Activity} className="h-[300px]">
          <ChartContainer config={{ tokens: { label: "Tokens", color: "var(--chart-1)" } }} className="h-full w-full">
            <AreaChart data={last90} margin={{ left: 4, right: 8 }}>
              <defs>
                <linearGradient id="tokFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-tokens)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--color-tokens)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={40} fontSize={11} tickFormatter={(v: string) => new Date(`${v}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })} />
              <YAxis tickLine={false} axisLine={false} width={44} fontSize={11} tickFormatter={(v) => fmtTokens(Number(v))} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => new Date(`${v}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} formatter={(v) => `${fmtInt(Number(v))} tokens`} />} />
              <Area dataKey="tokens" type="monotone" stroke="var(--color-tokens)" strokeWidth={2} fill="url(#tokFill)" isAnimationActive={false} />
            </AreaChart>
          </ChartContainer>
        </SectionCard>
        <SectionCard title="Favourite model" icon={Star} className="h-[300px]">
          {fav ? (
            <div className="flex h-full flex-col justify-center gap-4">
              <div className="flex min-w-0 items-center gap-2 text-warning">
                <Star className="size-4 shrink-0 fill-current" />
                <span className="truncate font-mono text-lg font-semibold text-foreground">{fav.name}</span>
              </div>
              <div className="grid grid-cols-3 gap-3 text-xs">
                <Metric label="Tokens" value={fmtTokens(fav.inTokens + fav.outTokens)} />
                <Metric label="Messages" value={fmtInt(fav.msgs)} />
                <Metric label="Cost" value={fav.priced ? fmtCost(fav.usd) : "—"} />
              </div>
              <p className="text-xs text-muted-foreground">{Math.round(((fav.inTokens + fav.outTokens) * 100) / Math.max(total, 1))}% of all tokens in this project.</p>
            </div>
          ) : (
            <EmptyState compact icon={Star} title="No history yet" />
          )}
        </SectionCard>
      </div>

      <SectionCard title="By model" icon={BarChart3} flush>
        {stats.perModel.length === 0 ? (
          <div className="h-[160px] p-5">
            <EmptyState compact icon={BarChart3} title="No model calls recorded yet" />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Model</TableHead>
                <TableHead className="w-[34%]">Share</TableHead>
                <TableHead className="text-right">Input</TableHead>
                <TableHead className="text-right">Output</TableHead>
                <TableHead className="text-right">Messages</TableHead>
                <TableHead className="pr-5 text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.perModel
                .slice()
                .sort((a, b) => b.inTokens + b.outTokens - (a.inTokens + a.outTokens))
                .map((m, i) => (
                  <TableRow key={m.name}>
                    <TableCell className="pl-5 font-mono text-[12px]">{m.name}</TableCell>
                    <TableCell>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full" style={{ width: `${((m.inTokens + m.outTokens) * 100) / maxModel}%`, background: `var(--chart-${(i % 5) + 1})` }} />
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-[12px] tabular">{fmtTokens(m.inTokens)}</TableCell>
                    <TableCell className="text-right font-mono text-[12px] tabular">{fmtTokens(m.outTokens)}</TableCell>
                    <TableCell className="text-right text-[12px] tabular">{fmtInt(m.msgs)}</TableCell>
                    <TableCell className="pr-5 text-right font-mono text-[12px] tabular">{m.priced ? fmtCost(m.usd) : <span className="text-muted-foreground">no price</span>}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/60 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="truncate text-base font-semibold tabular">{value}</div>
    </div>
  );
}

// A year of days, GitHub-style: columns are weeks, rows weekdays, colour the day's share of the
// busiest day (the TUI's ·░▒▓█ ramp as accent tints). One shared hover card, not one per cell.
function Heatmap({ perDay }: { perDay: Stats["perDay"] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ date: string; tokens: number; msgs: number; x: number; y: number } | null>(null);
  const { weeks, max, months } = useMemo(() => {
    const map = new Map(perDay.map((d) => [d.date, d]));
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 364);
    start.setDate(start.getDate() - start.getDay());
    const weeks: { date: string; tokens: number; msgs: number; future: boolean }[][] = [];
    const months: { col: number; label: string }[] = [];
    let max = 0;
    const d = new Date(start);
    let col = 0;
    while (d <= end) {
      const week: { date: string; tokens: number; msgs: number; future: boolean }[] = [];
      for (let i = 0; i < 7; i++) {
        const k = dayKey(d);
        const v = map.get(k);
        if (d.getDate() === 1) months.push({ col, label: d.toLocaleDateString(undefined, { month: "short" }) });
        week.push({ date: k, tokens: v?.tokens ?? 0, msgs: v?.msgs ?? 0, future: d > end });
        max = Math.max(max, v?.tokens ?? 0);
        d.setDate(d.getDate() + 1);
      }
      weeks.push(week);
      col++;
    }
    return { weeks, max, months };
  }, [perDay]);
  const level = (t: number) => (t <= 0 ? 0 : t < max * 0.25 ? 1 : t < max * 0.5 ? 2 : t < max * 0.75 ? 3 : 4);
  const bg = ["var(--muted)", "color-mix(in oklab, var(--primary) 28%, var(--muted))", "color-mix(in oklab, var(--primary) 50%, var(--muted))", "color-mix(in oklab, var(--primary) 74%, var(--muted))", "var(--primary)"];

  return (
    <div ref={wrap} className="relative overflow-x-auto pb-1 scrollbar-thin" onMouseLeave={() => setHover(null)}>
      <div className="relative ml-8 h-4 text-[10px] text-muted-foreground">
        {months.map((m, i) => (
          <span key={i} className="absolute" style={{ left: m.col * 14 }}>
            {m.label}
          </span>
        ))}
      </div>
      <div
        className="flex gap-[3px]"
        onMouseOver={(e) => {
          const t = e.target as HTMLElement;
          const date = t.dataset.date;
          if (!date) return;
          const r = t.getBoundingClientRect();
          const w = wrap.current!.getBoundingClientRect();
          setHover({ date, tokens: Number(t.dataset.tokens), msgs: Number(t.dataset.msgs), x: r.left - w.left + r.width / 2, y: r.top - w.top });
        }}
      >
        <div className="mr-1 flex w-7 shrink-0 flex-col justify-between py-[2px] text-[10px] text-muted-foreground">
          <span>Mon</span>
          <span>Wed</span>
          <span>Fri</span>
        </div>
        {weeks.map((w, i) => (
          <div key={i} className="flex flex-col gap-[3px]">
            {w.map((d) => (
              <span key={d.date} data-date={d.future ? undefined : d.date} data-tokens={d.tokens} data-msgs={d.msgs} className="block size-[11px] rounded-[3px]" style={{ background: bg[level(d.tokens)], opacity: d.future ? 0 : 1 }} />
            ))}
          </div>
        ))}
      </div>
      {hover && (
        <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md" style={{ left: hover.x, top: hover.y - 6 }}>
          <div className="whitespace-nowrap font-medium">{new Date(`${hover.date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</div>
          <div className="whitespace-nowrap text-[11px] text-muted-foreground">{hover.tokens ? `${fmtInt(hover.tokens)} tokens · ${hover.msgs} messages` : "No activity"}</div>
        </div>
      )}
      <div className="mt-2 flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
        Less
        {bg.map((c, i) => (
          <span key={i} className="size-[10px] rounded-[3px]" style={{ background: c }} />
        ))}
        More
      </div>
    </div>
  );
}
