import { motion } from "motion/react";
import { Brain, Cpu, HardDrive, Power, Trash2, Wrench } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtAgo, fmtBytes, fmtParams } from "@/lib/format";
import type { InstalledModel } from "@/lib/types";
import { useApp } from "@/store/app";
import { DownloadBar, Monogram } from "./parts";
import { isActive, modelName, useModelActions } from "./use-models";

// What's on this Mac: each model with its size on disk and when an agent last used it, whether it
// is loaded right now, and a delete that says how much it frees. Downloads in flight sit on top.
export function InstalledList({ models, onOpen, onRemoved }: { models: InstalledModel[]; onOpen: (repo: string) => void; onRemoved: () => void }) {
  const downloads = useApp((s) => s.session.local.downloads);
  const runtime = useApp((s) => s.session.local.runtime);
  const api = useApp((s) => s.api);
  const { cancel, remove } = useModelActions();
  const active = Object.values(downloads).filter(isActive);
  const total = models.reduce((n, m) => n + m.bytes, 0);

  return (
    <div className="flex flex-col gap-4">
      {active.length > 0 && (
        <Card className="gap-3 py-4 shadow-none">
          <CardHeader className="px-4">
            <CardTitle className="text-[13px]">Downloading</CardTitle>
            <CardDescription className="text-[12px]">Resumes where it stopped if niti quits.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-4">
            {active.map((d) => (
              <div key={d.id} className="flex items-center gap-3">
                <Monogram name={d.repo.split("/")[0]!} className="size-8 text-[11px]" />
                <div className="min-w-0 flex-1">
                  <div className="mb-1 truncate text-[13px] font-medium">
                    {modelName(d.id)} <span className="font-mono text-[11px] text-muted-foreground">{d.quant}</span>
                  </div>
                  <DownloadBar d={d} onCancel={() => void cancel(d.id)} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <Card className="gap-0 py-0 shadow-none">
        <CardHeader className="flex items-center justify-between border-b px-4 py-3 [.border-b]:pb-3">
          <CardTitle className="text-[13px]">On this Mac</CardTitle>
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground tabular">
            <HardDrive className="size-3.5" aria-hidden /> {fmtBytes(total)} in {models.length} model{models.length === 1 ? "" : "s"}
          </span>
        </CardHeader>
        <CardContent className="divide-y px-0">
          {models.map((m, i) => {
            const r = runtime[m.id];
            const loaded = r && (r.state === "ready" || r.state === "loading");
            return (
              <motion.div
                key={m.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: Math.min(i, 10) * 0.02 }}
                className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40"
              >
                <Monogram name={m.repo.split("/")[0]!} />
                <button type="button" onClick={() => onOpen(m.repo)} className="min-w-0 flex-1 cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-md">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13.5px] font-medium">{modelName(m.id)}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{m.quant}</span>
                    {loaded && (
                      <Badge variant="outline" className="h-5 gap-1 border-success/30 bg-success/10 px-1.5 text-[10.5px] text-success">
                        <span className="size-1.5 animate-pulse rounded-full bg-success" aria-hidden />
                        {r.state === "loading" ? "Loading" : `Loaded · ${Math.round((r.ctx ?? 0) / 1024)}k ctx`}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-muted-foreground tabular">
                    <span>{fmtBytes(m.bytes)}</span>
                    <span aria-hidden>·</span>
                    <span>{fmtParams(m.params)} params</span>
                    <span aria-hidden>·</span>
                    <span>{m.lastUsed ? `used ${fmtAgo(m.lastUsed)}` : "never used"}</span>
                    {m.tools && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Wrench className="size-3.5 text-primary" aria-label="Calls tools" />
                        </TooltipTrigger>
                        <TooltipContent>{m.toolFormat === "generic" ? "Calls tools through llama.cpp's generic format — less reliable than a native one." : "Calls tools"}</TooltipContent>
                      </Tooltip>
                    )}
                    {m.thinking && <Brain className="size-3.5 text-info" aria-label="Thinks before answering" />}
                  </div>
                </button>
                {loaded && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Unload ${modelName(m.id)}`} onClick={() => void api?.unloadModel(m.id)}>
                        <Power />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Unload — frees its memory; the next call loads it again</TooltipContent>
                  </Tooltip>
                )}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Delete ${modelName(m.id)}`} className="text-muted-foreground hover:text-destructive">
                      <Trash2 />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete {modelName(m.id)}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Frees {fmtBytes(m.bytes)}. Agents set to this model stop working until you pick another one or download it again.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep it</AlertDialogCancel>
                      <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void remove(m.id).then(onRemoved)}>
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </motion.div>
            );
          })}
        </CardContent>
      </Card>
      <p className="flex items-center gap-1.5 px-1 text-[11.5px] text-muted-foreground">
        <Cpu className="size-3.5" aria-hidden />
        Models run with llama.cpp on this Mac's GPU, one copy shared by every agent using it, and unload after 15 idle minutes.
      </p>
    </div>
  );
}
