import { memo } from "react";
import { motion } from "motion/react";
import { ArrowDownToLine, Clock3, Heart, Layers, ScanText } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtAgo, fmtBytes, fmtCount, fmtParams } from "@/lib/format";
import type { CatalogModel } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CapabilityBadges, DownloadAction, FitBadge, FormatBadge, Monogram, quantLabel } from "./parts";
import { useDownload, useModelActions } from "./use-models";

// One model in the grid: who made it, whether it runs here, what it can do, how popular and fresh
// it is — and the download of the quant this Mac should get. The whole card opens the details.
export const ModelCard = memo(function ModelCard({ m, index, onOpen }: { m: CatalogModel; index: number; onOpen: (repo: string) => void }) {
  const pick = m.pick;
  const quant = pick ? m.quants.find((q) => q.quant === pick.quant) : undefined;
  const id = pick ? `${m.repo}:${pick.quant}` : undefined;
  const download = useDownload(id);
  const { start, cancel } = useModelActions();
  const installed = !!pick && m.installed.includes(pick.quant);
  const wontFit = pick?.fit.tier === "wont-fit";

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, delay: Math.min(index, 12) * 0.025, ease: [0.22, 1, 0.36, 1] }}
    >
      <Card
        role="button"
        tabIndex={0}
        aria-label={`${m.name} by ${m.author} — details`}
        onClick={() => onOpen(m.repo)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen(m.repo);
          }
        }}
        className={cn(
          "group relative h-full cursor-pointer gap-3 overflow-hidden py-4 shadow-none transition-[border-color,box-shadow,transform] duration-200",
          "hover:-translate-y-px hover:border-primary/35 hover:shadow-[0_8px_28px_-12px_color-mix(in_oklab,var(--primary)_35%,transparent)]",
          "focus-visible:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        )}
      >
        {/* A soft light from the top edge on hover — depth without a new colour. */}
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[radial-gradient(120%_100%_at_50%_0%,color-mix(in_oklab,var(--primary)_10%,transparent),transparent_70%)] opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
        <CardHeader className="relative flex items-start gap-3 px-4">
          <Monogram name={m.author} />
          <div className="min-w-0 flex-1">
            <CardTitle className="truncate text-[14px] leading-5 font-semibold" title={m.name}>
              {m.name}
            </CardTitle>
            <CardDescription className="truncate text-[12px]">
              {m.author}
              {m.architecture && <span className="font-mono text-muted-foreground/70"> · {m.architecture}</span>}
            </CardDescription>
          </div>
          <FitBadge fit={pick?.fit} />
        </CardHeader>
        <CardContent className="relative flex flex-col gap-3 px-4">
          <div className="flex flex-wrap items-center gap-1">
            <FormatBadge format={m.format} />
            <CapabilityBadges tools={m.tools} thinking={m.thinking} license={m.license} className="contents" />
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11.5px] text-muted-foreground tabular">
            <Stat icon={ArrowDownToLine} label="Downloads this month" value={fmtCount(m.downloads)} />
            <Stat icon={Heart} label="Likes" value={fmtCount(m.likes)} />
            <Stat icon={Layers} label="Parameters" value={fmtParams(m.params)} />
            <Stat icon={ScanText} label="Context window" value={m.contextLength ? `${Math.round(m.contextLength / 1024)}k ctx` : "—"} />
            <Stat icon={Clock3} label="Last updated" value={m.lastModified ? `updated ${fmtAgo(Date.parse(m.lastModified))}` : "—"} className="col-span-2" />
          </div>
        </CardContent>
        <CardFooter className="relative mt-auto flex items-center gap-2 border-t px-4 pt-3 [.border-t]:pt-3" onClick={(e) => e.stopPropagation()}>
          {pick && quant ? (
            <>
              <span className="mr-auto min-w-0 truncate font-mono text-[11px] text-muted-foreground" title="The quantization picked for this Mac">
                {quantLabel(pick.quant, m.repo)}
                {quant.size ? ` · ${quant.estimated ? "~" : ""}${fmtBytes(quant.size)}` : ""}
              </span>
              <DownloadAction
                installed={installed}
                download={download}
                disabled={wontFit || m.gated}
                disabledReason={m.gated ? "Gated by its authors — pick another upload of this model." : "Needs more memory than this Mac has."}
                onStart={() => void start(m.repo, pick.quant, m.name)}
                onCancel={() => id && void cancel(id)}
              />
            </>
          ) : (
            <span className="text-[11.5px] text-muted-foreground">Open for the files in this repo</span>
          )}
        </CardFooter>
      </Card>
    </motion.div>
  );
});

function Stat({ icon: Icon, label, value, className }: { icon: typeof Heart; label: string; value: string; className?: string }) {
  return (
    // The label is the row's accessible name and its hover title; the icon says it to the eye.
    <div className={cn("flex min-w-0 items-center gap-1.5", className)} title={label} aria-label={`${label}: ${value}`} role="group">
      <Icon className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
      <span className="truncate" aria-hidden>
        {value}
      </span>
    </div>
  );
}
