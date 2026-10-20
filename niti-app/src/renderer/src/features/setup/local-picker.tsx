import { useCallback, useEffect, useState } from "react";
import { Check, Cpu, Download, FolderOpen, HardDrive, Loader2, Plus, Sparkles, Wrench } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { FitBadge, FormatBadge, Monogram, quantLabel } from "@/features/models/parts";
import { modelName } from "@/features/models/use-models";
import { fmtBytes, fmtParams } from "@/lib/format";
import type { CatalogModel, DownloadProgress, FoundModel, InstalledModel, LocalDevice } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";

// "On this Mac" in team setup: the models already downloaded, ready to pick, and the ones
// recommended for this Mac, downloadable right here. Setup runs before the event stream is
// connected, so a download's progress is polled from the core instead.
export function LocalPicker({ value, onPick }: { value?: string; onPick: (id: string) => void }) {
  const api = useApp((s) => s.api)!;
  const [installed, setInstalled] = useState<InstalledModel[] | null>(null);
  const [downloads, setDownloads] = useState<DownloadProgress[]>([]);
  const [recommended, setRecommended] = useState<CatalogModel[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [device, setDevice] = useState<LocalDevice | null>(null);
  const [found, setFound] = useState<FoundModel[]>([]);
  const [adding, setAdding] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void api
      .installedModels()
      .then((r) => {
        setInstalled(r.models);
        setDownloads(r.downloads);
      })
      .catch(() => setInstalled([]));
  }, [api]);
  useEffect(() => {
    refresh();
    void api.localDevice().then(setDevice).catch(() => {});
    void api.foundModels().then((r) => setFound(r.models.filter((f) => !f.added))).catch(() => {});
    void api
      .catalog({ tab: "recommended" })
      .then((r) => {
        setRecommended(r.models.slice(0, 8));
        setOffline(!!r.offline);
      })
      .catch(() => setRecommended([]));
  }, [api, refresh]);
  const active = downloads.some((d) => d.state === "downloading" || d.state === "queued" || d.state === "verifying");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(refresh, 1200);
    return () => clearInterval(t);
  }, [active, refresh]);

  const start = async (m: CatalogModel) => {
    if (!m.pick) return;
    try {
      await api.download(m.repo, m.pick.quant);
      refresh();
    } catch (e) {
      toast.error(`Couldn't download ${m.name}`, { description: (e as Error).message });
    }
  };

  const have = new Set((installed ?? []).map((m) => m.id));
  const toGet = (recommended ?? []).filter((m) => m.pick && !have.has(`${m.repo}:${m.pick.quant}`));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {device && (
        <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
          <Cpu className="size-3.5" aria-hidden />
          {device.device.chip.replace(/^Apple /, "")} · {fmtBytes(device.device.totalMemory)} memory, {fmtBytes(device.device.gpuBudget)} for models
          {!device.runtimeAvailable && <span className="ml-auto text-warning">runtime missing — reinstall niti</span>}
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1 rounded-xl border">
        <div className="p-1.5">
          <Group label="On this Mac" icon={HardDrive}>
            {installed === null ? (
              <Skeleton className="m-1 h-12" />
            ) : installed.length === 0 ? (
              <p className="px-3 py-2.5 text-[12.5px] text-muted-foreground">Nothing downloaded yet — get one below. It runs privately on this Mac, no key needed.</p>
            ) : (
              installed.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  autoFocus={m.id === value || (!value && m === installed[0])}
                  onClick={() => onPick(m.id)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40",
                    m.id === value && "bg-primary/8",
                  )}
                >
                  <Monogram name={m.repo.split("/")[0]!} className="size-8 text-[11px]" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium">{modelName(m.id)}</span>
                      {m.format === "mlx" && <FormatBadge format="mlx" />}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      {quantLabel(m.quant, m.repo)} · {fmtBytes(m.bytes)} · {fmtParams(m.params)}{m.path ? ` · ${m.source ?? "added"}` : ""}
                    </span>
                  </span>
                  {m.tools ? <Wrench className="size-3.5 text-primary" aria-label="calls tools" /> : <span className="text-[10.5px] text-warning">chat only</span>}
                  {m.id === value && <Check className="size-4 text-primary" aria-hidden />}
                </button>
              ))
            )}
          </Group>
          {found.length > 0 && (
            <Group label="Found on this Mac — add without downloading" icon={FolderOpen}>
              {found.map((f) => (
                <div key={f.id} className="flex items-center gap-3 rounded-lg px-2.5 py-2">
                  <Monogram name={f.repo.split("/")[0]!} className="size-8 text-[11px]" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium">{modelName(f.id)}</span>
                      <FormatBadge format={f.format} />
                    </div>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      {fmtBytes(f.bytes)} · {fmtParams(f.params)} · {f.source}
                    </span>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    className="gap-1"
                    disabled={adding !== null}
                    onClick={async () => {
                      setAdding(f.id);
                      try {
                        await api.addFoundModel(f.id);
                        onPick(f.id);
                      } catch (e) {
                        toast.error((e as Error).message);
                        setAdding(null);
                      }
                    }}
                  >
                    {adding === f.id ? <Loader2 className="animate-spin" /> : <Plus />} Add and use
                  </Button>
                </div>
              ))}
            </Group>
          )}
          <Group label="Recommended for this Mac" icon={Sparkles}>
            {recommended === null ? (
              <div className="space-y-1.5 p-1">
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
              </div>
            ) : offline ? (
              <p className="px-3 py-2.5 text-[12.5px] text-muted-foreground">Hugging Face is out of reach — connect to the internet to download a model.</p>
            ) : toGet.length === 0 ? (
              <p className="px-3 py-2.5 text-[12.5px] text-muted-foreground">You have them all. More on the Models page once the team is running.</p>
            ) : (
              toGet.map((m) => {
                const id = `${m.repo}:${m.pick!.quant}`;
                const d = downloads.find((x) => x.id === id);
                const going = d && (d.state === "downloading" || d.state === "queued" || d.state === "verifying");
                const size = m.quants.find((q) => q.quant === m.pick!.quant)?.size;
                return (
                  <div key={m.repo} className="flex items-center gap-3 rounded-lg px-2.5 py-2">
                    <Monogram name={m.author} className="size-8 text-[11px]" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-medium">{m.name}</span>
                        <FitBadge fit={m.pick!.fit} />
                      </div>
                      {going ? (
                        <div className="mt-1 flex items-center gap-2">
                          <Progress value={d.total ? (d.received / d.total) * 100 : 0} className="h-1.5" aria-label={`Downloading ${m.name}`} />
                          <span className="shrink-0 text-[10.5px] text-muted-foreground tabular">{d.total ? `${Math.round((d.received / d.total) * 100)}%` : "…"}</span>
                        </div>
                      ) : (
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">
                          {m.pick!.quant} · {size ? fmtBytes(size) : "?"} · {fmtParams(m.params)} · {m.author}
                          {d?.state === "error" && <span className="text-destructive"> · {d.error}</span>}
                        </span>
                      )}
                    </div>
                    {going ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
                    ) : (
                      <Button size="xs" variant="outline" className="gap-1" onClick={() => void start(m)}>
                        <Download /> Get
                      </Button>
                    )}
                  </div>
                );
              })
            )}
          </Group>
        </div>
      </ScrollArea>
    </div>
  );
}

function Group({ label, icon: Icon, children }: { label: string; icon: typeof Cpu; children: React.ReactNode }) {
  return (
    <section className="py-1">
      <h3 className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </h3>
      {children}
    </section>
  );
}
