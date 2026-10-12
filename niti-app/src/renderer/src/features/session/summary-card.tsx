import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, CircleSlash, TriangleAlert, X, ArrowRight, FileDiff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { fmtDur } from "@/lib/humanize";
import { fmtCost, fmtTokens } from "@/lib/format";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { useState, useEffect } from "react";
import { Markdown } from "./markdown";

// The run's closing card (summary.go:48-111): verdict, what it took, what changed, what's next.
export function SummaryCard() {
  const summary = useApp((s) => s.session.summary);
  const active = useApp((s) => s.session.active);
  const view = useUI((s) => s.viewFile);
  const [hidden, setHidden] = useState<unknown>(null);
  useEffect(() => setHidden(null), [summary]);
  const show = summary && !active && hidden !== summary;
  const tone = summary?.cancelled ? "cancelled" : summary?.ok ? "done" : "failed";
  const Icon = tone === "done" ? CheckCircle2 : tone === "cancelled" ? CircleSlash : TriangleAlert;
  const color = tone === "done" ? "text-success" : tone === "cancelled" ? "text-muted-foreground" : "text-warning";

  return (
    <AnimatePresence>
      {show && summary && (
        <motion.div initial={{ opacity: 0, y: 16, height: 0 }} animate={{ opacity: 1, y: 0, height: "auto" }} exit={{ opacity: 0, y: 10, height: 0 }} className="px-4">
          <Card className="gap-0 overflow-hidden py-0 shadow-float">
            <div className="flex items-center gap-2.5 border-b px-4 py-2.5">
              <Icon className={`size-4 ${color}`} />
              <span className={`text-sm font-semibold ${color}`}>{tone === "done" ? "Done" : tone === "cancelled" ? "Cancelled" : "Finished with failures"}</span>
              <span className="text-xs text-muted-foreground tabular">
                {fmtDur(summary.durationMs)} · {fmtTokens(summary.tokens)} tokens · {fmtCost(summary.cost, summary.costKnown)}
              </span>
              <Button variant="ghost" size="icon-xs" className="ml-auto" onClick={() => setHidden(summary)} aria-label="Dismiss">
                <X />
              </Button>
            </div>
            <div className="grid max-h-56 gap-3 overflow-y-auto px-4 py-3 scrollbar-thin md:grid-cols-[1fr_auto]">
              {summary.summary && <Markdown text={summary.summary} className="text-[13px]" />}
              {summary.files.length > 0 && (
                <div className="min-w-56 space-y-0.5">
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                    <FileDiff className="size-3.5" /> {summary.files.length} file{summary.files.length === 1 ? "" : "s"} changed
                  </div>
                  {summary.files.slice(0, 8).map((f) => (
                    <Button key={f.path} variant="ghost" size="xs" className="h-6 w-full justify-between gap-3 px-1.5 font-mono text-[11.5px] font-normal" onClick={() => view(f.path)}>
                      <span className="truncate">{f.path}</span>
                      <span className="shrink-0 tabular">
                        <span className="text-success">+{f.added}</span> <span className="text-destructive">−{f.removed}</span>
                      </span>
                    </Button>
                  ))}
                </div>
              )}
            </div>
            {summary.next.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 border-t bg-muted/30 px-4 py-2">
                <span className="mr-1 text-[11px] font-medium text-muted-foreground">Next</span>
                {summary.next.slice(0, 4).map((n) => (
                  <Button key={n} variant="outline" size="xs" className="h-6 max-w-full gap-1 rounded-full bg-card text-[11.5px] font-normal" onClick={() => window.dispatchEvent(new CustomEvent("niti:prefill", { detail: n }))}>
                    <span className="truncate">{n}</span>
                    <ArrowRight className="size-3 text-muted-foreground" />
                  </Button>
                ))}
              </div>
            )}
          </Card>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
