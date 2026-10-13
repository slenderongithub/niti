import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Crosshair, FileCode2, Focus, Loader2, Minus, Plus, RotateCcw, Search, SlidersHorizontal, Users, Waypoints, X, ArrowRight, ArrowLeft, MessagesSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentAvatar } from "@/components/agent-avatar";
import { messageColor } from "@/lib/identity";
import { fmtTokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { FileGraph } from "@/lib/types";
import { useApp, useRoster } from "@/store/app";
import { useUI } from "@/store/ui";
import { GraphEngine, type GraphMode, type HoverInfo } from "./engine";

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888888";
}
function resolveColor(c: string): string {
  const m = /^var\((--[^)]+)\)$/.exec(c);
  return m ? cssVar(m[1]!) : c;
}

export default function GraphPage() {
  const api = useApp((s) => s.api);
  const epoch = useApp((s) => s.session.fileEpoch);
  const { order, agents, lead } = useRoster();
  const messages = useApp((s) => s.session.messages);
  const dark = useUI((s) => s.resolvedDark);
  const go = useUI((s) => s.go);
  const viewFile = useUI((s) => s.viewFile);
  const focusAgent = useUI((s) => s.focusAgent);

  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<GraphEngine | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<GraphMode>(() => (localStorage.getItem("niti.graphMode") as GraphMode) ?? "project");
  const [graph, setGraph] = useState<FileGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [stats, setStats] = useState({ nodes: 0, links: 0 });
  const [q, setQ] = useState("");
  const [hits, setHits] = useState(0);
  const [labels, setLabels] = useState(true);
  const [forces, setForces] = useState({ link: 42, charge: 30, gravity: 6 });
  const [legend, setLegend] = useState<{ label: string; color: string; count: number }[]>([]);
  const fitted = useRef(false);
  // The first graph a mode draws is framed once; after that the camera is the user's.
  const fitOnce = (e: GraphEngine) => {
    if (fitted.current) return;
    fitted.current = true;
    setTimeout(() => e.fit(false), 30);
  };
  const seenMsgs = useRef(messages.length);

  // engine lifecycle
  useEffect(() => {
    const e = new GraphEngine(canvas.current!, {
      onHover: setHover,
      onSelect: setSelected,
      onStats: (nodes, links) => setStats({ nodes, links }),
    });
    engine.current = e;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry!.contentRect;
      e.resize(r.width, r.height);
    });
    ro.observe(wrap.current!);
    return () => {
      ro.disconnect();
      e.destroy();
      engine.current = null;
    };
  }, []);

  // theme → canvas colours (the tokens are hex in globals.css)
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    requestAnimationFrame(() => {
      e.setTheme({
        ink: cssVar("--foreground"),
        muted: cssVar("--muted-foreground"),
        accent: cssVar("--primary"),
        bg: cssVar("--background"),
        line: cssVar("--border"),
        info: cssVar("--info"),
        success: cssVar("--success"),
        destructive: cssVar("--destructive"),
        groups: ["--agent-1", "--agent-2", "--agent-3", "--agent-4", "--agent-5", "--agent-6", "--primary", "--info"].map(cssVar),
        avatarInk: cssVar("--avatar-ink"),
      });
      setLegend(e.mode === "project" ? e.groups() : []);
    });
  }, [dark]);

  // project data, refetched (debounced) when files change
  useEffect(() => {
    if (!api || mode !== "project") return;
    let cancelled = false;
    const t = setTimeout(
      () => {
        void api
          .graph()
          .then((g) => {
            if (cancelled) return;
            setGraph(g);
            setErr(null);
          })
          .catch((e) => !cancelled && setErr((e as Error).message))
          .finally(() => !cancelled && setLoading(false));
      },
      graph ? 400 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [api, mode, epoch]); // eslint-disable-line react-hooks/exhaustive-deps

  // mode switch
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    try {
      localStorage.setItem("niti.graphMode", mode);
    } catch {
      /* fine */
    }
    e.setMode(mode);
    fitted.current = false;
    setSelected(null);
    setHover(null);
  }, [mode]);

  // project graph → engine
  useEffect(() => {
    const e = engine.current;
    if (!e || mode !== "project" || !graph) return;
    e.setGraph(
      graph.nodes.map((n) => ({ id: n.id, label: n.label.replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|go)$/, ""), group: n.group })),
      graph.edges,
    );
    setLegend(e.groups());
    fitOnce(e);
  }, [graph, mode]);

  // agents → engine
  const msgEdges = useMemo(() => {
    const set = new Map<string, { from: string; to: string }>();
    for (const m of messages) {
      const tos = m.to === "*" ? order.filter((id) => id !== m.from) : [m.to];
      for (const to of tos) {
        if (!agents[m.from] || !agents[to]) continue;
        const k = m.from < to ? `${m.from}\0${to}` : `${to}\0${m.from}`;
        set.set(k, { from: m.from, to });
      }
    }
    return [...set.values()];
  }, [messages, order, agents]);
  const roster = order.map((id) => `${id}:${agents[id]!.cfg.role}`).join("|");
  useEffect(() => {
    const e = engine.current;
    if (!e || mode !== "agents") return;
    // Lead at the hub of a star until real traffic draws its own edges.
    const edges = msgEdges.length ? msgEdges : order.filter((id) => id !== lead).map((id) => ({ from: lead ?? order[0]!, to: id }));
    e.setGraph(
      order.map((id) => {
        const a = agents[id]!;
        return { id, label: a.cfg.role, group: "agent", slot: a.index, status: a.status, lead: id === lead, color: resolveColor(a.color) };
      }),
      edges,
    );
    fitOnce(e);
  }, [mode, roster, msgEdges, lead, dark]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const e = engine.current;
    if (!e || mode !== "agents") return;
    for (const id of order) e.updateAgent(id, { status: agents[id]!.status });
  }, [agents, order, mode]);
  // new messages → pulses
  useEffect(() => {
    const e = engine.current;
    const fresh = messages.slice(seenMsgs.current);
    seenMsgs.current = messages.length;
    if (!e || mode !== "agents") return;
    for (const m of fresh) {
      const tos = m.to === "*" ? order.filter((id) => id !== m.from) : [m.to];
      for (const to of tos) e.pulse(m.from, to, resolveColor(messageColor(m.kind)));
    }
  }, [messages, mode, order]);

  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    e.showLabels = labels;
    e.reheat(0.0001);
  }, [labels]);
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    Object.assign(e.sim, forces);
    e.reheat(0.6);
  }, [forces]);

  // keyboard: / search · f fit · 1/2 modes · esc clear
  useEffect(() => {
    const h = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || document.querySelector("[role=dialog]")) return;
      if (ev.key === "/") {
        ev.preventDefault();
        searchRef.current?.focus();
      } else if (ev.key === "f") engine.current?.fit(true);
      else if (ev.key === "1") setMode("project");
      else if (ev.key === "2") setMode("agents");
      else if (ev.key === "Escape") {
        engine.current?.clearSelection();
        setQ("");
        engine.current?.setSearch("");
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const selNode = selected ? engine.current?.nodes.find((n) => n.id === selected) : undefined;
  const imports = selected && graph ? graph.edges.filter((e) => e.from === selected).map((e) => e.to) : [];
  const importedBy = selected && graph ? graph.edges.filter((e) => e.to === selected).map((e) => e.from) : [];
  const selAgent = mode === "agents" && selected ? agents[selected] : undefined;

  return (
    <div ref={wrap} className="relative h-full overflow-hidden">
      <canvas ref={canvas} className="absolute inset-0 cursor-grab touch-none" />

      {/* toolbar */}
      <Card className="absolute left-3 top-3 flex-row items-center gap-2 rounded-xl p-1.5 shadow-lg">
        <ToggleGroup type="single" size="sm" value={mode} onValueChange={(v) => v && setMode(v as GraphMode)} className="rounded-lg bg-muted/70 p-0.5">
          <ToggleGroupItem value="project" className="h-7 gap-1.5 rounded-md px-2.5 text-xs data-[state=on]:bg-background data-[state=on]:shadow-sm">
            <Waypoints className="size-3.5" /> Project
          </ToggleGroupItem>
          <ToggleGroupItem value="agents" className="h-7 gap-1.5 rounded-md px-2.5 text-xs data-[state=on]:bg-background data-[state=on]:shadow-sm">
            <Users className="size-3.5" /> Agents
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setHits(engine.current?.setSearch(e.target.value) ?? 0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") engine.current?.flyToSearch();
              if (e.key === "Escape") {
                setQ("");
                engine.current?.setSearch("");
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder={mode === "project" ? "Find a file…" : "Find an agent…"}
            className="h-7 w-48 border-0 bg-muted/70 pl-8 text-xs shadow-none"
          />
          {!q && <Kbd className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2">/</Kbd>}
        </div>
        <span className="whitespace-nowrap px-1.5 text-[11px] text-muted-foreground tabular">
          {q ? `${hits} match${hits === 1 ? "" : "es"}` : `${stats.nodes} ${mode === "project" ? "files" : "agents"} · ${stats.links} ${mode === "project" ? "imports" : "links"}`}
        </span>
      </Card>

      {/* controls */}
      <Card className="absolute right-3 top-3 flex-row items-center gap-0.5 rounded-xl p-1 shadow-lg">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={() => engine.current?.zoomBy(1 / 1.3)} aria-label="Zoom out">
              <Minus />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom out</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={() => engine.current?.zoomBy(1.3)} aria-label="Zoom in">
              <Plus />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom in</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={() => engine.current?.fit(true)} aria-label="Fit">
              <Crosshair />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Fit to view <Kbd>F</Kbd>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={() => engine.current?.unpinAll()} aria-label="Reset layout">
              <RotateCcw />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Unpin everything and relax the layout</TooltipContent>
        </Tooltip>
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Layout settings">
                  <SlidersHorizontal />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>Layout</TooltipContent>
          </Tooltip>
          <PopoverContent align="end" className="w-64 space-y-4">
            {(
              [
                ["link", "Link distance", 10, 120],
                ["charge", "Repulsion", 5, 120],
                ["gravity", "Gravity", 0, 30],
              ] as const
            ).map(([key, label, min, max]) => (
              <div key={key} className="space-y-2">
                <div className="flex justify-between text-xs">
                  <Label className="text-xs">{label}</Label>
                  <span className="text-muted-foreground tabular">{forces[key]}</span>
                </div>
                <Slider min={min} max={max} step={1} value={[forces[key]]} onValueChange={([v]) => setForces((f) => ({ ...f, [key]: v! }))} disabled={mode === "agents"} />
              </div>
            ))}
            <div className="flex items-center justify-between">
              <Label htmlFor="labels" className="text-xs">
                Labels
              </Label>
              <Switch id="labels" size="sm" checked={labels} onCheckedChange={setLabels} />
            </div>
          </PopoverContent>
        </Popover>
      </Card>

      {/* legend */}
      <AnimatePresence>
        {mode === "project" && legend.length > 0 && (
          <LegendCard key="dirs" title="Directories" className="max-w-[min(560px,60vw)]">
            {legend.slice(0, 14).map((g) => (
              <span key={g.label} className="flex items-center gap-1.5 text-[11px]">
                <span className="size-2 rounded-full" style={{ background: g.color }} />
                {g.label}
                <span className="text-muted-foreground tabular">{g.count}</span>
              </span>
            ))}
          </LegendCard>
        )}
        {mode === "agents" && (
          <LegendCard key="messages" title="Messages">
            {(["question", "answer", "handoff", "review", "note"] as const).map((k) => (
              <span key={k} className="flex items-center gap-1.5 text-[11px] capitalize">
                <span className="size-2 rounded-full" style={{ background: messageColor(k) }} />
                {k}
              </span>
            ))}
          </LegendCard>
        )}
      </AnimatePresence>

      {/* hover */}
      <AnimatePresence>
        {hover && !selected && (
          <motion.div
            key="tip"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="pointer-events-none absolute z-10"
            style={{ left: Math.min(hover.x + 16, (wrap.current?.clientWidth ?? 800) - 260), top: hover.y + 18 }}
          >
            <Card className="w-60 gap-1 rounded-lg px-3 py-2 shadow-xl">
              <div className="truncate text-[12.5px] font-semibold">{hover.node.label}</div>
              <div className="truncate font-mono text-[10.5px] text-muted-foreground">
                {mode === "project" ? hover.node.id : `${hover.node.status ?? "idle"}`} · {hover.node.deg} link{hover.node.deg === 1 ? "" : "s"}
              </div>
              {hover.neighbours.length > 0 && (
                <div className="mt-1 space-y-0.5 border-t pt-1.5">
                  {hover.neighbours.slice(0, 8).map((n) => (
                    <div key={n} className="truncate font-mono text-[10.5px] text-muted-foreground">
                      ↔ {n}
                    </div>
                  ))}
                  {hover.neighbours.length > 8 && <div className="text-[10.5px] text-muted-foreground">+{hover.neighbours.length - 8} more</div>}
                </div>
              )}
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* selection */}
      <AnimatePresence>
        {selNode && (
          <motion.div key={selNode.id} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} className="absolute right-3 top-16 z-10 w-72">
            <Card className="gap-3 rounded-xl p-4 shadow-xl">
              <div className="flex items-start gap-2.5">
                {selAgent ? (
                  <AgentAvatar slot={selAgent.index} color={selAgent.color} lead={selected === lead} status={selAgent.status} showStatus />
                ) : (
                  <span className="flex size-8 items-center justify-center rounded-lg" style={{ background: `color-mix(in oklab, ${selNode.color} 18%, transparent)`, color: selNode.color }}>
                    <FileCode2 className="size-4" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{selNode.label}</div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">{selAgent ? `${selAgent.cfg.provider}/${selAgent.cfg.model}` : selNode.id}</div>
                </div>
                <Button variant="ghost" size="icon-xs" onClick={() => engine.current?.clearSelection()} aria-label="Close">
                  <X />
                </Button>
              </div>
              {selAgent ? (
                <div className="grid grid-cols-3 gap-2 text-center">
                  <Metric label="Status" value={selAgent.status} />
                  <Metric label="Tokens" value={fmtTokens(selAgent.usage.inputTokens + selAgent.usage.outputTokens)} />
                  <Metric label="Calls" value={String(selAgent.usage.calls)} />
                </div>
              ) : (
                <div className="space-y-2 text-xs">
                  <NeighbourList icon={ArrowRight} title={`Imports ${imports.length}`} items={imports} onPick={(id) => engine.current?.focusNode(id)} />
                  <NeighbourList icon={ArrowLeft} title={`Imported by ${importedBy.length}`} items={importedBy} onPick={(id) => engine.current?.focusNode(id)} />
                </div>
              )}
              <div className="flex gap-2">
                {selAgent ? (
                  <Button
                    size="sm"
                    className="flex-1"
                    onClick={() => {
                      focusAgent(selAgent.id);
                      go("session");
                    }}
                  >
                    <MessagesSquare /> Open transcript
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={() => {
                        viewFile(selNode.id);
                        go("session");
                      }}
                    >
                      <FileCode2 /> Open file
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => engine.current?.focusNode(selNode.id)}>
                      <Focus />
                    </Button>
                  </>
                )}
              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* states */}
      {mode === "project" && (loading || err || (graph && graph.nodes.length === 0)) && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className={cn("flex flex-col items-center gap-2 rounded-xl border bg-card px-6 py-5 text-center text-sm shadow-lg", err && "text-destructive")}>
            {loading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : <Waypoints className="size-5 text-muted-foreground" />}
            {loading ? "Mapping the project…" : err ? err : "No source files with imports found yet."}
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/50 px-2 py-1.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="truncate text-[13px] font-semibold capitalize tabular">{value}</div>
    </div>
  );
}

function NeighbourList({ icon: Icon, title, items, onPick }: { icon: typeof ArrowRight; title: string; items: string[]; onPick: (id: string) => void }) {
  if (!items.length) return <div className="flex items-center gap-1.5 text-muted-foreground"><Icon className="size-3" /> {title}</div>;
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-muted-foreground">
        <Icon className="size-3" /> {title}
      </div>
      <div className="max-h-28 space-y-0.5 overflow-y-auto scrollbar-thin">
        {items.map((i) => (
          <Button key={i} variant="ghost" size="xs" className="h-5 w-full justify-start truncate px-1 font-mono text-[11px] font-normal" onClick={() => onPick(i)}>
            {i}
          </Button>
        ))}
      </div>
    </div>
  );
}

// The floating key in the bottom-left corner — one per graph mode.
function LegendCard({ title, className, children }: { title: string; className?: string; children: React.ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} className="absolute bottom-3 left-3">
      <Card className={cn("gap-1.5 rounded-xl px-3 py-2 shadow-lg", className)}>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
        <div className="flex flex-wrap gap-x-3 gap-y-1">{children}</div>
      </Card>
    </motion.div>
  );
}
