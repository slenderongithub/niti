import { motion } from "motion/react";
import { Brain, CircleAlert, CircleCheck, CircleSlash, Download, Loader2, ShieldCheck, Wrench, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtBytes, fmtEta } from "@/lib/format";
import type { DownloadProgress, Fit, FitTier } from "@/lib/types";
import { cn } from "@/lib/utils";
import { isActive } from "./use-models";

// The pieces every surface of the Models page shares, so a model reads the same on a card, in the
// detail sheet and in the installed list.

const TIER: Record<FitTier, { label: string; icon: typeof CircleCheck; tone: string; explain: string }> = {
  "runs-well": { label: "Runs well", icon: CircleCheck, tone: "border-success/30 bg-success/10 text-success", explain: "Fits in this Mac's GPU memory with room to spare." },
  tight: { label: "Tight fit", icon: CircleAlert, tone: "border-warning/30 bg-warning/10 text-warning", explain: "Loads, but leaves the rest of the Mac little memory — other apps may slow down." },
  "wont-fit": { label: "Won't fit", icon: CircleSlash, tone: "border-destructive/30 bg-destructive/10 text-destructive", explain: "Needs more memory than this Mac's GPU can use." },
};

export function FitBadge({ fit, className }: { fit?: Fit; className?: string }) {
  if (!fit) return null;
  const t = TIER[fit.tier];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={cn("h-5 gap-1 px-1.5 text-[10.5px] font-medium", t.tone, className)}>
          <t.icon className="size-3" aria-hidden />
          {t.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        {t.explain} Needs about {fmtBytes(fit.need)} of {fmtBytes(fit.budget)}, at a {Math.round(fit.ctx / 1024)}k context.
      </TooltipContent>
    </Tooltip>
  );
}

export function CapabilityBadges({ tools, thinking, license, className }: { tools: boolean; thinking: boolean; license?: string; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {tools ? (
        <Badge variant="outline" className="h-5 gap-1 border-primary/25 bg-primary/8 px-1.5 text-[10.5px] text-primary">
          <Wrench className="size-3" aria-hidden />
          Tools
        </Badge>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="h-5 px-1.5 text-[10.5px] text-muted-foreground">
              Chat only
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-60">Its chat template has no tool calls, so it can talk but can't edit files or run commands as an agent.</TooltipContent>
        </Tooltip>
      )}
      {thinking && (
        <Badge variant="outline" className="h-5 gap-1 border-info/25 bg-info/8 px-1.5 text-[10.5px] text-info">
          <Brain className="size-3" aria-hidden />
          Thinking
        </Badge>
      )}
      {license && (
        <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10.5px] font-normal text-muted-foreground">
          <ShieldCheck className="size-3" aria-hidden />
          {license}
        </Badge>
      )}
    </div>
  );
}

// A download's live state: a bar with bytes, speed and time left, and a way to stop it.
export function DownloadBar({ d, onCancel, compact }: { d: DownloadProgress; onCancel: () => void; compact?: boolean }) {
  const pct = d.total > 0 ? Math.min(100, (d.received / d.total) * 100) : 0;
  const label = d.state === "verifying" ? "Verifying checksum…" : d.state === "queued" ? "Starting…" : `${fmtBytes(d.received)} of ${fmtBytes(d.total)}`;
  return (
    <motion.div initial={{ opacity: 0, y: 2 }} animate={{ opacity: 1, y: 0 }} className="flex w-full items-center gap-2.5" role="status" aria-live="polite">
      <div className="min-w-0 flex-1">
        <Progress value={pct} className={cn("h-1.5", d.state === "verifying" && "animate-pulse")} aria-label={`Downloading, ${Math.round(pct)}%`} />
        {!compact && (
          <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground tabular">
            <span>{label}</span>
            {d.state === "downloading" && d.bytesPerSec > 0 && (
              <>
                <span className="text-muted-foreground/50">·</span>
                <span>{fmtBytes(d.bytesPerSec)}/s</span>
                <span className="ml-auto">{fmtEta(d.total - d.received, d.bytesPerSec)}</span>
              </>
            )}
          </div>
        )}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-xs" onClick={onCancel} aria-label="Cancel download">
            <X />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Cancel — what's downloaded so far is kept, and resumes next time</TooltipContent>
      </Tooltip>
    </motion.div>
  );
}

// The one primary action for a quant: download it, follow its download, or say it's here.
export function DownloadAction({
  installed,
  download,
  disabled,
  disabledReason,
  size,
  onStart,
  onCancel,
}: {
  installed: boolean;
  download?: DownloadProgress;
  disabled?: boolean;
  disabledReason?: string;
  size?: number;
  onStart: () => void;
  onCancel: () => void;
}) {
  if (installed) {
    return (
      <Badge variant="outline" className="h-7 gap-1.5 border-success/30 bg-success/10 px-2.5 text-[12px] text-success">
        <CircleCheck className="size-3.5" aria-hidden />
        Installed
      </Badge>
    );
  }
  if (isActive(download)) return <DownloadBar d={download!} onCancel={onCancel} />;
  const btn = (
    <Button size="sm" onClick={onStart} disabled={disabled} className="gap-1.5">
      {download?.state === "queued" ? <Loader2 className="animate-spin" /> : <Download />}
      {download?.state === "error" ? "Retry" : "Download"}
      {size ? <span className="font-normal opacity-75 tabular">{fmtBytes(size)}</span> : null}
    </Button>
  );
  return disabled && disabledReason ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0}>{btn}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{disabledReason}</TooltipContent>
    </Tooltip>
  ) : (
    btn
  );
}

// The author's monogram, tinted from the name so the same uploader always has the same colour.
const TINTS = ["bg-agent-1/15 text-agent-1", "bg-agent-2/15 text-agent-2", "bg-agent-3/15 text-agent-3", "bg-agent-4/15 text-agent-4", "bg-agent-5/15 text-agent-5", "bg-agent-6/15 text-agent-6"];
export function Monogram({ name, className }: { name: string; className?: string }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const letters = name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2) || "?";
  return (
    <span aria-hidden className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg font-mono text-[13px] font-semibold uppercase ring-1 ring-inset ring-border", TINTS[h % TINTS.length], className)}>
      {letters}
    </span>
  );
}
