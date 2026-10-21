import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Brain, Cpu, FolderOpen, HardDrive, Hourglass, Loader2, Plus, Power, Search, ShieldCheck, Trash2, Wrench, Zap } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtAgo, fmtBytes, fmtParams } from "@/lib/format";
import type { InstalledModel } from "@/lib/types";
import { useApp } from "@/store/app";
import { DownloadBar, EngineInstallBar, FormatBadge, Monogram, quantLabel, ReadinessBadge } from "./parts";
import { isActive, modelName, useFound, useModelActions } from "./use-models";

// What's on this Mac: each model with its size on disk and when an agent last used it, whether it
// is loaded right now, and a delete that says how much it frees. Downloads in flight sit on top.
export function InstalledList({ models, onOpen, onRemoved }: { models: InstalledModel[]; onOpen: (repo: string) => void; onRemoved: () => void }) {
  const downloads = useApp((s) => s.session.local.downloads);
  const runtime = useApp((s) => s.session.local.runtime);
  const api = useApp((s) => s.api);
  const { cancel, remove } = useModelActions();
  const [checking, setChecking] = useState<string | null>(null);
  const active = Object.values(downloads).filter(isActive);
  // niti's one-time check, run again on request (after an update, or to see what it finds).
  const check = async (m: InstalledModel) => {
    if (!api) return;
    setChecking(m.id);
    try {
      const { probe } = await api.checkModel(m.id);
      const label = { ready: "Ready for agent work", partial: "Partly ready", "chat-only": "Chat only" }[probe.verdict];
      toast(`${modelName(m.id)}: ${label}`, { description: probe.notes.join(" · ") });
      onRemoved(); // reload the list with the new result
    } catch (e) {
      toast.error(`Couldn't check ${modelName(m.id)}`, { description: (e as Error).message });
    } finally {
      setChecking(null);
    }
  };
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
                    <span className="font-mono text-[11px] text-muted-foreground">{quantLabel(m.quant, m.repo)}</span>
                    {m.format === "mlx" && <FormatBadge format="mlx" />}
                    <ReadinessBadge probe={m.probe} checking={checking === m.id || r?.state === "checking"} />
                    {m.path && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10.5px] font-normal text-muted-foreground">
                            <FolderOpen className="size-3" aria-hidden /> {m.source ?? "added"}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-80 break-all">Used where it is: {m.path}</TooltipContent>
                      </Tooltip>
                    )}
                    {r?.state === "waiting" && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10.5px] text-muted-foreground">
                            <Hourglass className="size-3" aria-hidden /> Waiting for memory
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-72">It doesn't fit beside {r.waitingFor?.map(modelName).join(", ")}; it loads as soon as that is idle. The models take turns.</TooltipContent>
                      </Tooltip>
                    )}
                    {loaded && (
                      <Badge variant="outline" className="h-5 gap-1 border-success/30 bg-success/10 px-1.5 text-[10.5px] text-success">
                        <span className="size-1.5 animate-pulse rounded-full bg-success" aria-hidden />
                        {r.state === "loading" ? "Loading" : `Loaded · ${Math.round((r.ctx ?? 0) / 1024)}k ctx`}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-muted-foreground tabular">
                    <span>{m.path ? `${fmtBytes(m.bytes)} (not counted — stays in ${m.source ?? "its folder"})` : fmtBytes(m.bytes)}</span>
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
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Check ${modelName(m.id)} again`} disabled={checking !== null} onClick={() => void check(m)}>
                      {checking === m.id ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-64">{m.probe ? "Check again: whether it calls tools and can split work (about a minute)" : "Check it now: niti tests every model once before its first agent task"}</TooltipContent>
                </Tooltip>
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
                    <Button variant="ghost" size="icon-sm" aria-label={`${m.path ? "Remove" : "Delete"} ${modelName(m.id)}`} className="text-muted-foreground hover:text-destructive">
                      <Trash2 />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {m.path ? "Remove" : "Delete"} {modelName(m.id)}?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {m.path
                          ? `niti forgets it; its files stay in ${m.source ?? "their folder"} (${m.path}). You can add it again from Found on this Mac.`
                          : `Frees ${fmtBytes(m.bytes)}. Agents set to this model stop working until you pick another one or download it again.`}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep it</AlertDialogCancel>
                      <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void remove(m.id).then(onRemoved)}>
                        {m.path ? "Remove from niti" : "Delete"}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </motion.div>
            );
          })}
        </CardContent>
      </Card>
      <FoundOnThisMac onAdded={onRemoved} />
      <MlxEngine />
      <p className="flex items-center gap-1.5 px-1 text-[11.5px] text-muted-foreground">
        <Cpu className="size-3.5" aria-hidden />
        Models run on this Mac's GPU (GGUF on llama.cpp, MLX on Apple's MLX), one copy shared by every agent using it, and unload after 15 idle minutes.
      </p>
    </div>
  );
}

// Models another app already downloaded (LM Studio's folder, the Hugging Face cache): added in place,
// run on niti's engines. Nothing is copied, so nothing is downloaded twice.
export function FoundOnThisMac({ onAdded }: { onAdded: () => void }) {
  const api = useApp((s) => s.api);
  const { models, refresh } = useFound();
  const [busy, setBusy] = useState<string | null>(null);
  const waiting = (models ?? []).filter((f) => !f.added);
  if (models === null || waiting.length === 0) return null;
  const add = async (id: string) => {
    setBusy(id);
    try {
      await api?.addFoundModel(id);
      toast.success(`Added ${modelName(id)}`, { description: "Its files stay where they are. Pick it for an agent under On this Mac." });
      refresh();
      onAdded();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="gap-0 py-0 shadow-none">
      <CardHeader className="flex items-center justify-between border-b px-4 py-3 [.border-b]:pb-3">
        <div>
          <CardTitle className="flex items-center gap-1.5 text-[13px]">
            <Search className="size-3.5 text-muted-foreground" aria-hidden /> Found on this Mac
          </CardTitle>
          <CardDescription className="text-[12px]">Already downloaded by another app. Add one to use it in niti — no second download.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="divide-y px-0">
        {waiting.map((f) => (
          <div key={f.id} className="flex items-center gap-3 px-4 py-2.5">
            <Monogram name={f.repo.split("/")[0]!} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13.5px] font-medium">{modelName(f.id)}</span>
                <FormatBadge format={f.format} />
                {f.tools === false && <span className="text-[11px] text-warning">chat only</span>}
              </div>
              <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground tabular" title={f.path}>
                {fmtBytes(f.bytes)} · {fmtParams(f.params)} params{f.contextLength ? ` · ${Math.round(f.contextLength / 1024)}k ctx` : ""} · {f.source}
              </div>
            </div>
            <Button size="sm" variant="outline" className="gap-1.5" disabled={busy !== null} onClick={() => void add(f.id)}>
              {busy === f.id ? <Loader2 className="animate-spin" /> : <Plus />} Add
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// The MLX engine: where it stands, its install as it happens, and a way to take its space back.
export function MlxEngine() {
  const api = useApp((s) => s.api);
  const runtime = useApp((s) => s.session.local.runtime);
  const installing = Object.values(runtime).find((r) => r.engine === "mlx" && r.state === "installing");
  const failed = runtime["engine:mlx"]?.state === "error" ? runtime["engine:mlx"] : undefined;
  const [device, setDevice] = useState<{ installed: boolean; supported: boolean; bytes?: number } | null>(null);
  const load = () => void api?.localDevice().then((d) => setDevice(d.mlx)).catch(() => {});
  const doneAt = runtime["engine:mlx"]?.state;
  useEffect(load, [api, doneAt, Boolean(installing)]); // eslint-disable-line react-hooks/exhaustive-deps -- refetch when an install starts or ends
  if (!device?.supported) return null;
  return (
    <Card className="gap-2 py-3 shadow-none">
      <CardContent className="flex items-center gap-3 px-4">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-pink/12 text-pink">
          <Zap className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">MLX engine</div>
          {installing ? (
            <EngineInstallBar status={installing} />
          ) : (
            <div className="text-[11.5px] text-muted-foreground">
              {failed ? <span className="text-destructive">Install failed: {failed.error}</span> : device.installed ? `Installed${device.bytes ? ` · ${fmtBytes(device.bytes)}` : ""} · runs MLX models on Apple Silicon` : "Downloads once (about 140 MB) the first time an MLX model runs."}
            </div>
          )}
        </div>
        {!installing &&
          (device.installed ? (
            <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => void api?.removeMlx().then(load).catch((e) => toast.error((e as Error).message))}>
              Remove
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => void api?.installMlx().then(load)}>
              Install now
            </Button>
          ))}
      </CardContent>
    </Card>
  );
}
