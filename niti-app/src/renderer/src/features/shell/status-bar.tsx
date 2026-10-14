import { ShieldCheck, Zap, Gauge, WifiOff, Coins, Cpu, Coffee, Target, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AnimatedNumber } from "@/components/number";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { deepestContext } from "@/lib/reducer";
import { fmtCost, fmtTokens } from "@/lib/format";
import { cn } from "@/lib/utils";

export function StatusBar() {
  // Primitive selectors only: the status bar must not re-render on every streamed token.
  const connection = useApp((x) => x.session.connection);
  const total = useApp((x) => x.session.totals.inputTokens + x.session.totals.outputTokens);
  const cost = useApp((x) => x.session.cost);
  const costKnown = useApp((x) => x.session.costKnown);
  const ctxKey = useApp((x) => {
    const d = deepestContext(x.session);
    return d ? `${d.pct}\u0001${x.session.agents[d.id]?.cfg.role ?? ""}\u0001${x.session.agents[d.id]?.ctxLimit ?? 0}` : "";
  });
  const awake = useApp((x) => x.session.awake);
  // One string, so the bar re-renders when the goal changes and not on every other event.
  const goalKey = useApp((x) => {
    const g = x.session.goalStatus;
    return g ? [g.state, g.round, g.maxRounds, g.objective, g.reason].join("\u0001") : "";
  });
  const [goalState, goalRound, goalMax, goalObjective, goalReason] = goalKey.split("\u0001");
  // Remote control, once this Mac is signed in: "" when off, else "<link>\u0001<phones watching>".
  const remoteKey = useApp((x) => {
    const r = x.session.remote;
    return r?.signedIn && r.enabled && r.link !== "off" ? `${r.link}\u0001${r.phones.filter((p) => p.online).length}` : "";
  });
  const [remoteLink, remoteWatching] = remoteKey.split("\u0001");
  const info = useApp((x) => x.sessionInfo);
  const api = useApp((x) => x.api);
  const setAuto = useApp((x) => x.setAutoLocal);
  const go = useUI((x) => x.go);
  const [pctS, ctxRole, ctxLimit] = ctxKey.split("\u0001");
  const ctx = ctxKey ? { pct: Number(pctS), role: ctxRole, limit: Number(ctxLimit) } : undefined;
  const auto = info?.auto ?? false;

  const toggleAuto = async () => {
    if (!api) return;
    try {
      await api.setAuto(!auto);
      setAuto(!auto);
      toast.success(!auto ? "Auto-approve on — risky commands still ask" : "Manual approvals — writes and shell ask first");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const goalStatus = async () => {
    if (!api) return;
    try {
      toast((await api.runCommand("goal", "status")).message);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const stopAwake = async () => {
    if (!api) return;
    try {
      toast.success((await api.runCommand("awake", "off")).message);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <footer className="flex h-7 shrink-0 items-center gap-1 px-2.5 text-[11px] text-muted-foreground">
      <span className={cn("flex items-center gap-1.5 px-1.5", connection === "lost" && "text-destructive")}>
        {connection === "lost" ? <WifiOff className="size-3" /> : <span className="size-1.5 rounded-full bg-success" />}
        {connection === "lost" ? "reconnecting…" : "connected"}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="xs" className="h-5 gap-1 px-1.5 text-[11px] font-normal text-muted-foreground" onClick={() => void toggleAuto()}>
            {auto ? <Zap className="size-3 text-warning" /> : <ShieldCheck className="size-3" />}
            {auto ? "auto-approve" : "manual"}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{auto ? "Writes and shell run without asking (risky ones still confirm). Click for manual." : "Writes and shell ask first. Click for auto-approve."}</TooltipContent>
      </Tooltip>
      <span role="status" aria-atomic="true" className="contents">
        {goalKey && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="xs" className={cn("h-5 gap-1 px-1.5 text-[11px] font-normal", goalState === "running" ? "text-primary" : "text-muted-foreground")} onClick={() => void goalStatus()}>
                <Target className="size-3" aria-hidden />
                {goalState === "running" ? `goal ${goalRound}/${goalMax}` : `goal ${goalState}`}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-80">
              {goalObjective}
              {goalReason ? ` — ${goalReason}` : ""}. While it is live, what you type is a note to it. Click for details.
            </TooltipContent>
          </Tooltip>
        )}
      </span>
      <span role="status" aria-atomic="true" className="contents">
        {remoteKey && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={cn("flex items-center gap-1 px-1.5", remoteLink === "up" ? "text-success" : "text-muted-foreground")}>
                <Smartphone className="size-3" aria-hidden />
                {remoteLink === "up" ? (Number(remoteWatching) > 0 ? `${remoteWatching} watching` : "remote") : "remote · connecting"}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">Phones signed in to your niti account can control this project. /remote lists them; /remote revoke signs one out.</TooltipContent>
          </Tooltip>
        )}
      </span>
      {/* Always mounted, so a screen reader hears "awake" arrive and leave without focus moving. */}
      <span role="status" aria-atomic="true" className="contents">
        {awake !== "off" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="xs" className="h-5 gap-1 px-1.5 text-[11px] font-normal text-warning" onClick={() => void stopAwake()}>
                <Coffee className="size-3" aria-hidden />
                {awake === "lid" ? "awake" : "awake · lid open"}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {awake === "lid" ? "The Mac stays awake, lid closed too, until the run finishes." : "The Mac stays awake until the run finishes, but closing the lid will still sleep it."} Click to restore
              normal sleep now.
            </TooltipContent>
          </Tooltip>
        )}
      </span>
      {ctx && ctx.pct > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn("flex items-center gap-1 px-1.5", ctx.pct >= 80 ? "text-destructive" : ctx.pct >= 60 ? "text-warning" : "")}>
              <Gauge className="size-3" /> ctx {ctx.pct}%
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            Deepest context: {ctx.role} at {ctx.pct}% of {fmtTokens(ctx.limit)}
          </TooltipContent>
        </Tooltip>
      )}
      {info && (info.mcp.length > 0 || info.lsp.length > 0) && (
        <span className="hidden items-center gap-1 px-1.5 lg:flex">
          <Cpu className="size-3" />
          {[info.mcp.length && `${info.mcp.length} mcp`, info.lsp.filter((l) => l.running).length && `${info.lsp.filter((l) => l.running).length} lsp`].filter(Boolean).join(" · ")}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="xs" className="h-5 gap-1.5 px-1.5 text-[11px] font-normal text-muted-foreground" onClick={() => go("tokens")}>
          <Coins className="size-3" />
          <AnimatedNumber value={total} className="tabular" /> tok
          <span className="text-border">·</span>
          <AnimatedNumber value={cost} format={(n) => fmtCost(n, costKnown)} className="tabular" />
        </Button>
      </div>
    </footer>
  );
}
