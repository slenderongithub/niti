import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowDownToLine, Clock3, ExternalLink, Heart, Layers, Loader2, Lock, ScanText, ShieldCheck, Sparkles, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Markdown } from "@/features/session/markdown";
import { fmtAgo, fmtBytes, fmtCount, fmtParams } from "@/lib/format";
import type { CatalogModel, InstalledModel, ModelDetail } from "@/lib/types";
import { useApp } from "@/store/app";
import { cn } from "@/lib/utils";
import { CapabilityBadges, DownloadAction, FitBadge, FormatBadge, Monogram, quantLabel, ReadinessBadge } from "./parts";
import { useDownload, useModelActions, useModelDetail } from "./use-models";

// Everything about one model, from the repo itself: every quantization with its exact size and how
// it fits this Mac, the one to download picked out, and the authors' model card.
export function ModelSheet({ repo, preview, onClose }: { repo: string | null; preview?: CatalogModel; onClose: () => void }) {
  const { detail, error } = useModelDetail(repo);
  const m: CatalogModel | ModelDetail | undefined = detail ?? preview;
  return (
    <Sheet open={!!repo} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" showCloseButton={false} className="w-[min(640px,92vw)] gap-0 p-0 sm:max-w-none">
        <SheetClose asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Close" className="absolute right-3 top-3 z-10">
            <X />
          </Button>
        </SheetClose>
        {m ? (
          <>
            <SheetHeader className="relative gap-3 overflow-hidden border-b px-6 pb-5 pt-6">
              <span aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_120%_at_0%_0%,color-mix(in_oklab,var(--primary)_12%,transparent),transparent_60%)]" />
              <div className="relative flex items-start gap-3.5 pr-8">
                <Monogram name={m.author} className="size-11 rounded-xl text-[15px]" />
                <div className="min-w-0">
                  <SheetTitle className="truncate text-lg font-semibold tracking-tight">{m.name}</SheetTitle>
                  <SheetDescription className="truncate font-mono text-[12px]">{m.repo}</SheetDescription>
                </div>
              </div>
              <div className="relative flex flex-wrap items-center gap-1.5">
                <FitBadge fit={m.pick?.fit} />
                <FormatBadge format={m.format} />
                <CapabilityBadges tools={m.tools} thinking={m.thinking} license={m.license} />
                {m.gated && (
                  <Badge variant="outline" className="h-5 gap-1 border-warning/30 bg-warning/10 px-1.5 text-[10.5px] text-warning">
                    <Lock className="size-3" aria-hidden /> Gated
                  </Badge>
                )}
              </div>
              <dl className="relative grid grid-cols-3 gap-2">
                <Fact icon={Layers} label="Parameters" value={fmtParams(m.params)} />
                <Fact icon={ScanText} label="Context" value={m.contextLength ? `${Math.round(m.contextLength / 1024)}k tokens` : "—"} />
                <Fact icon={ArrowDownToLine} label="Downloads" value={`${fmtCount(m.downloads)}/mo`} />
                <Fact icon={Heart} label="Likes" value={fmtCount(m.likes)} />
                <Fact icon={Clock3} label="Updated" value={m.lastModified ? fmtAgo(Date.parse(m.lastModified)) : "—"} />
                <Fact icon={Sparkles} label="Architecture" value={m.architecture ?? "—"} mono />
              </dl>
            </SheetHeader>
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-6 px-6 py-5">
                <QuantPicker m={m} detail={detail} />
                <CheckSection repo={m.repo} />
                {m.gated && <p className="rounded-lg border border-warning/30 bg-warning/8 px-3 py-2.5 text-[12.5px] text-warning">Its authors ask you to accept their terms on huggingface.co before downloading, which niti can't do for you. Search for the model's name to find an open upload of the same weights.</p>}
                <section aria-labelledby="model-card-h">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 id="model-card-h" className="text-[13px] font-semibold">Model card</h3>
                    <Button variant="ghost" size="xs" className="gap-1 text-muted-foreground" onClick={() => void window.niti.openExternal(`https://huggingface.co/${m.repo}`)}>
                      Hugging Face <ExternalLink />
                    </Button>
                  </div>
                  {detail ? (
                    detail.readme ? (
                      <div className="selectable rounded-xl border bg-card/60 px-4 py-3 text-[13px] leading-relaxed">
                        <Markdown text={detail.readme} />
                      </div>
                    ) : (
                      <p className="text-[12.5px] text-muted-foreground">This repo has no model card.</p>
                    )
                  ) : error ? (
                    <p className="text-[12.5px] text-destructive">{error}</p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-5/6" />
                    </div>
                  )}
                </section>
              </div>
            </ScrollArea>
          </>
        ) : (
          <SheetHeader className="px-6 pt-6">
            <SheetTitle>Loading…</SheetTitle>
            <SheetDescription>{error ?? repo}</SheetDescription>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Fact({ icon: Icon, label, value, mono }: { icon: typeof Heart; label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border bg-background/60 px-2.5 py-2">
      <dt className="flex items-center gap-1 text-[10.5px] uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3" aria-hidden />
        {label}
      </dt>
      <dd className={cn("mt-0.5 truncate text-[13px] font-medium tabular", mono && "font-mono text-[12px]")}>{value}</dd>
    </div>
  );
}

// The repo's quantizations, smallest first, each with its size and fit. The recommended one is
// preselected; picking another is a click, and its download is the button below.
function QuantPicker({ m, detail }: { m: CatalogModel | ModelDetail; detail: ModelDetail | null }) {
  const quants = m.quants;
  const [chosen, setChosen] = useState<string>(m.pick?.quant ?? quants[0]?.quant ?? "");
  useEffect(() => setChosen(m.pick?.quant ?? quants[0]?.quant ?? ""), [m.repo]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = quants.find((x) => x.quant === chosen);
  const fit = detail?.fits[chosen] ?? (chosen === m.pick?.quant ? m.pick?.fit : undefined);
  const id = `${m.repo}:${chosen}`;
  const download = useDownload(id);
  const { start, cancel } = useModelActions();
  const ordered = useMemo(() => quants.filter((x) => x.bpw < 16).concat(quants.filter((x) => x.bpw >= 16)), [quants]);

  if (!quants.length) return <p className="text-[12.5px] text-muted-foreground">No downloadable GGUF files in this repo.</p>;
  return (
    <section aria-labelledby="quant-h" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h3 id="quant-h" className="text-[13px] font-semibold">
          Quantization
        </h3>
        <span className="text-[11.5px] text-muted-foreground">
          {m.format === "mlx" ? "An MLX repo holds one quantization; other sizes are other repos." : "Smaller is faster and lighter; larger is closer to the original."}
        </span>
      </div>
      <ToggleGroup type="single" value={chosen} onValueChange={(v) => v && setChosen(v)} className="grid w-full grid-cols-3 gap-1.5 sm:grid-cols-4" aria-label="Quantization">
        {ordered.map((x) => {
          const f = detail?.fits[x.quant];
          const dot = f ? (f.tier === "runs-well" ? "bg-success" : f.tier === "tight" ? "bg-warning" : "bg-destructive") : "bg-muted-foreground/40";
          return (
            <ToggleGroupItem
              key={x.quant}
              value={x.quant}
              className="h-auto flex-col items-start gap-0.5 rounded-lg border px-2.5 py-2 text-left data-[state=on]:border-primary/60 data-[state=on]:bg-primary/8 data-[state=on]:shadow-[inset_0_0_0_1px_var(--primary)]"
            >
              <span className="flex w-full items-center gap-1.5 font-mono text-[11.5px] font-semibold">
                <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />
                {quantLabel(x.quant, m.repo)}
                {x.quant === m.pick?.quant && <Sparkles className="ml-auto size-3 text-primary" aria-label="recommended" />}
              </span>
              <span className="text-[11px] text-muted-foreground tabular">
                {x.size ? `${x.estimated ? "~" : ""}${fmtBytes(x.size)}` : "size unknown"}
                {m.installed.includes(x.quant) && " · installed"}
              </span>
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
      <div className="flex items-center gap-3 rounded-xl border bg-card px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px] font-medium">
            <span className="font-mono">{quantLabel(chosen, m.repo)}</span>
            <FitBadge fit={fit} />
          </div>
          <div className="text-[11.5px] text-muted-foreground">
            {q?.files.length && q.files.length > 1 ? `${q.files.length} files · ` : ""}
            {fit ? `needs about ${fmtBytes(fit.need)} at a ${Math.round(fit.ctx / 1024)}k context` : "checking the fit…"}
          </div>
        </div>
        <div className="flex min-w-48 justify-end">
          <DownloadAction
            installed={m.installed.includes(chosen)}
            download={download}
            size={q?.size}
            disabled={m.gated || fit?.tier === "wont-fit"}
            disabledReason={m.gated ? "Gated by its authors." : "Needs more memory than this Mac has — pick a smaller quantization."}
            onStart={() => void start(m.repo, chosen, m.name)}
            onCancel={() => void cancel(id)}
          />
        </div>
      </div>
      {download?.state === "error" && <p className="text-[12px] text-destructive">{download.error}</p>}
    </section>
  );
}

// What niti's one-time check found for the copies of this model on this Mac (src/local/probe.ts), and
// a way to run it again.
const TOOL_MODE = { native: "on its own", forced: "when niti makes it", text: "as text niti reads", none: "never" } as const;
function CheckSection({ repo }: { repo: string }) {
  const api = useApp((s) => s.api);
  const [mine, setMine] = useState<InstalledModel[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    void api?.installedModels().then((r) => setMine(r.models.filter((x) => x.repo === repo))).catch(() => {});
  }, [api, repo]);
  useEffect(load, [load]);
  if (!mine.length) return null;
  const run = async (id: string) => {
    setBusy(id);
    try {
      await api!.checkModel(id);
      load();
    } catch (e) {
      toast.error("The check couldn't run", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-labelledby="check-h" className="flex flex-col gap-2">
      <h3 id="check-h" className="text-[13px] font-semibold">niti's check</h3>
      {mine.map((x) => (
        <div key={x.id} className="rounded-xl border bg-card/60 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12px]">{quantLabel(x.quant, x.repo)}</span>
            <ReadinessBadge probe={x.probe} checking={busy === x.id} />
            <Button size="xs" variant="outline" className="ml-auto gap-1" disabled={busy !== null} onClick={() => void run(x.id)}>
              {busy === x.id ? <Loader2 className="animate-spin" /> : <ShieldCheck />} {x.probe ? "Check again" : "Check now"}
            </Button>
          </div>
          {x.probe ? (
            <>
              <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[12.5px] text-muted-foreground">
                {x.probe.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                <dt className="text-muted-foreground">Calls tools</dt>
                <dd>{TOOL_MODE[x.probe.toolMode]}{x.probe.textFormat ? ` (${x.probe.textFormat})` : ""}</dd>
                <dt className="text-muted-foreground">Splits work for a team</dt>
                <dd>{x.probe.planMode === "none" ? "no — niti splits by role" : "yes"}</dd>
                <dt className="text-muted-foreground">Thinks before answering</dt>
                <dd>{x.probe.thinking === "none" ? "no" : "yes"}</dd>
                {x.probe.tokensPerSec ? (
                  <>
                    <dt className="text-muted-foreground">Speed</dt>
                    <dd className="tabular">about {x.probe.tokensPerSec} tokens/s</dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">Checked</dt>
                <dd>{fmtAgo(x.probe.checkedAt)} on {x.probe.engine}</dd>
              </dl>
            </>
          ) : (
            <p className="mt-2 text-[12.5px] text-muted-foreground">Not checked yet. niti tests it once (about a minute) before its first agent task, to learn how to drive it.</p>
          )}
        </div>
      ))}
    </section>
  );
}
