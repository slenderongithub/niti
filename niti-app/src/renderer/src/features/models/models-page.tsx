import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Cpu, HardDrive, Loader2, RefreshCw, Search, SearchX, Sparkles, WifiOff, Wrench, Boxes, X, Gauge } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { EmptyState } from "@/components/empty-state";
import { fmtBytes } from "@/lib/format";
import type { CatalogQuery, SortKey } from "@/lib/types";
import { cn } from "@/lib/utils";
import { load, save } from "@/store/ui";
import { ModelCard } from "./model-card";
import { ModelSheet } from "./model-sheet";
import { FoundOnThisMac, InstalledList, MlxEngine } from "./installed-list";
import { isActive, useCatalog, useDevice, useInstalled } from "./use-models";
import { useApp } from "@/store/app";

type Tab = "recommended" | "all" | "installed";

const SORTS: { id: SortKey; label: string }[] = [
  { id: "downloads", label: "Most downloaded" },
  { id: "likes", label: "Most liked" },
  { id: "trendingScore", label: "Trending" },
  { id: "lastModified", label: "Recently updated" },
];
const SUGGESTIONS = ["qwen3 coder", "gemma", "llama 3.2", "mistral small", "deepseek", "phi"];

// The model marketplace: open models from Hugging Face that run on this Mac, picked for it
// (Recommended) or the whole catalogue to search (All models), and what's already installed.
export default function ModelsPage() {
  const [tab, setTab] = useState<Tab>(() => load<Tab>("models.tab", "recommended"));
  const [q, setQ] = useState("");
  const deferred = useDeferredValue(q);
  const [debounced, setDebounced] = useState("");
  const [sort, setSort] = useState<SortKey>(() => load<SortKey>("models.sort", "downloads"));
  const [filters, setFilters] = useState<string[]>(() => load<string[]>("models.filters", ["tools"]));
  const [size, setSize] = useState<"any" | "small" | "medium" | "large">("any");
  const [format, setFormat] = useState<"any" | "gguf" | "mlx">(() => load<"any" | "gguf" | "mlx">("models.format", "any"));
  const [open, setOpen] = useState<string | null>(null);
  const device = useDevice();
  const installed = useInstalled();
  const downloading = useApp((s) => Object.values(s.session.local.downloads).some(isActive));

  // One request per pause in typing, not per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(deferred.trim()), 350);
    return () => clearTimeout(t);
  }, [deferred]);
  useEffect(() => save("models.tab", tab), [tab]);
  useEffect(() => save("models.sort", sort), [sort]);
  useEffect(() => save("models.filters", filters), [filters]);
  useEffect(() => save("models.format", format), [format]);

  const query: CatalogQuery = useMemo(
    () =>
      tab === "recommended"
        ? { tab: "recommended" }
        : { tab: "all", q: debounced || undefined, sort, tools: filters.includes("tools"), fits: filters.includes("fits"), ...(size !== "any" ? { size } : {}), ...(format !== "any" ? { format } : {}) },
    [tab, debounced, sort, filters, size, format],
  );
  const { result, loading, error, retry } = useCatalog(tab === "installed" ? { tab: "recommended" } : query);
  const models = result?.models ?? [];
  const preview = models.find((m) => m.repo === open);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header: the page, and the Mac it is choosing for. */}
      <header className="relative shrink-0 overflow-hidden border-b">
        <span aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_140%_at_12%_-20%,color-mix(in_oklab,var(--primary)_16%,transparent),transparent_70%)]" />
        <span aria-hidden className="dot-grid pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_bottom,black,transparent)]" />
        <div className="relative flex flex-wrap items-end gap-x-6 gap-y-3 px-6 pb-4 pt-6">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2.5 text-xl font-semibold tracking-tight">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary ring-1 ring-inset ring-primary/20">
                <Boxes className="size-4.5" aria-hidden />
              </span>
              Models
            </h1>
            <p className="mt-1 text-[13px] text-muted-foreground">Open models that run on this Mac — private, offline, and free to use.</p>
          </div>
          <DeviceStrip device={device} installedBytes={installed.models.reduce((n, m) => n + m.bytes, 0)} />
        </div>
        <div className="relative flex flex-wrap items-center gap-2 px-6 pb-3">
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <TabsList>
              <TabsTrigger value="recommended" className="gap-1.5">
                <Sparkles aria-hidden /> Recommended for this Mac
              </TabsTrigger>
              <TabsTrigger value="all" className="gap-1.5">
                <Search aria-hidden /> All models
              </TabsTrigger>
              <TabsTrigger value="installed" className="gap-1.5">
                <HardDrive aria-hidden /> Installed
                {installed.models.length > 0 && (
                  <Badge variant="secondary" className="h-4 min-w-4 rounded-full px-1 text-[10px] tabular">
                    {installed.models.length}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <AnimatePresence initial={false}>
            {tab === "all" && (
              <motion.div initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -6 }} className="flex flex-1 flex-wrap items-center gap-2">
                <div className="relative min-w-56 flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Hugging Face — qwen coder, gemma, llama…" aria-label="Search models" className="h-9 pl-8 pr-8" />
                  {q && (
                    <Button variant="ghost" size="icon-xs" className="absolute right-1.5 top-1/2 -translate-y-1/2" onClick={() => setQ("")} aria-label="Clear search">
                      <X />
                    </Button>
                  )}
                </div>
                <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
                  <SelectTrigger className="h-9 w-44" aria-label="Sort by">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SORTS.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={format} onValueChange={(v) => setFormat(v as typeof format)}>
                  <SelectTrigger className="h-9 w-32" aria-label="Format">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any format</SelectItem>
                    <SelectItem value="gguf">GGUF</SelectItem>
                    <SelectItem value="mlx">MLX</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={size} onValueChange={(v) => setSize(v as typeof size)}>
                  <SelectTrigger className="h-9 w-36" aria-label="Model size">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any size</SelectItem>
                    <SelectItem value="small">Small · under 8B</SelectItem>
                    <SelectItem value="medium">Medium · 8–32B</SelectItem>
                    <SelectItem value="large">Large · over 32B</SelectItem>
                  </SelectContent>
                </Select>
                <ToggleGroup type="multiple" variant="outline" value={filters} onValueChange={setFilters} aria-label="Filters" className="h-9">
                  <ToggleGroupItem value="tools" className="gap-1.5 px-2.5 text-[12.5px]" aria-label="Only models that can use tools">
                    <Wrench aria-hidden /> Tools
                  </ToggleGroupItem>
                  <ToggleGroupItem value="fits" className="gap-1.5 px-2.5 text-[12.5px]" aria-label="Only models that fit this Mac">
                    <Gauge aria-hidden /> Fits this Mac
                  </ToggleGroupItem>
                </ToggleGroup>
              </motion.div>
            )}
          </AnimatePresence>
          {loading && tab !== "installed" && models.length > 0 && <Loader2 className="ml-auto size-4 animate-spin text-muted-foreground" aria-label="Loading" />}
        </div>
      </header>

      {device && !device.runtimeAvailable && (
        <div className="flex items-center gap-2 border-b bg-warning/8 px-6 py-2 text-[12.5px] text-warning" role="alert">
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          The local model runtime isn't installed with this copy of niti, so downloaded models can't run yet. Reinstall niti to get it.
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-6xl px-6 py-5">
          {tab === "installed" ? (
            installed.loaded && installed.models.length === 0 && !downloading ? (
              <div className="flex flex-col gap-4">
                <EmptyState
                  icon={HardDrive}
                  title="No models in niti yet"
                  description="Download one from Recommended — they're picked to run well on this Mac and to work as agents — or add one you already have, below."
                  action={
                    <Button size="sm" onClick={() => setTab("recommended")} className="gap-1.5">
                      <Sparkles /> See recommended models
                    </Button>
                  }
                  className="h-auto py-10"
                />
                <FoundOnThisMac onAdded={installed.refresh} />
                <MlxEngine />
              </div>
            ) : (
              <InstalledList models={installed.models} onOpen={setOpen} onRemoved={installed.refresh} />
            )
          ) : error ? (
            <EmptyState icon={AlertTriangle} title="Couldn't load models" description={error} action={<Button size="sm" variant="outline" onClick={retry} className="gap-1.5"><RefreshCw /> Try again</Button>} className="py-20" />
          ) : result?.offline ? (
            <EmptyState
              icon={WifiOff}
              title="Hugging Face is out of reach"
              description="Browsing needs the internet. Models you've already downloaded keep working offline."
              action={
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={retry} className="gap-1.5">
                    <RefreshCw /> Try again
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setTab("installed")}>
                    Installed models
                  </Button>
                </div>
              }
              className="py-20"
            />
          ) : loading && !models.length ? (
            <Grid>
              {Array.from({ length: 9 }, (_, i) => (
                <div key={i} className="flex h-56 flex-col gap-3 rounded-xl border p-4">
                  <div className="flex gap-3">
                    <Skeleton className="size-9 rounded-lg" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-2/3" />
                      <Skeleton className="h-3 w-1/3" />
                    </div>
                  </div>
                  <Skeleton className="h-5 w-1/2" />
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="mt-auto h-8 w-full" />
                </div>
              ))}
            </Grid>
          ) : models.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title={tab === "recommended" ? "Nothing fits this Mac comfortably" : debounced ? `No models match "${debounced}"` : "No models match these filters"}
              description={
                tab === "recommended" ? (
                  "Browse All models for smaller quantizations that may still fit."
                ) : (
                  <span className="flex flex-col items-center gap-2.5">
                    <span>{filters.length || size !== "any" ? "Loosen a filter, or try one of these:" : "Try one of these:"}</span>
                    <span className="flex flex-wrap justify-center gap-1.5">
                      {SUGGESTIONS.map((s) => (
                        <Button key={s} variant="outline" size="xs" onClick={() => setQ(s)}>
                          {s}
                        </Button>
                      ))}
                    </span>
                  </span>
                )
              }
              action={
                filters.length || size !== "any" || format !== "any" ? (
                  <Button size="sm" variant="ghost" onClick={() => (setFilters([]), setSize("any"), setFormat("any"))}>
                    Clear filters
                  </Button>
                ) : tab === "recommended" ? (
                  <Button size="sm" variant="outline" onClick={() => setTab("all")}>
                    Browse all models
                  </Button>
                ) : undefined
              }
              className="py-16"
            />
          ) : (
            <>
              {tab === "recommended" && (
                <p className="mb-4 text-[12.5px] text-muted-foreground">
                  The most downloaded models that can work as agents — they call tools — and run well in{" "}
                  {device ? <span className="font-medium text-foreground">{fmtBytes(device.device.gpuBudget)}</span> : "this Mac's"} of GPU memory. One per model family; each gets the quantization that fits best.
                </p>
              )}
              <Grid>
                {models.map((m, i) => (
                  <ModelCard key={m.repo} m={m} index={i} onOpen={setOpen} />
                ))}
              </Grid>
            </>
          )}
        </div>
      </ScrollArea>
      <ModelSheet repo={open} preview={preview} onClose={() => setOpen(null)} />
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-3">{children}</div>;
}

function DeviceStrip({ device, installedBytes }: { device: ReturnType<typeof useDevice>; installedBytes: number }) {
  if (!device) return <Skeleton className="ml-auto h-10 w-80 rounded-xl" />;
  const d = device.device;
  const loaded = device.runtime.filter((r) => r.state === "ready" || r.state === "loading");
  return (
    <div className="ml-auto flex items-stretch gap-px overflow-hidden rounded-xl border bg-border text-[12px] shadow-xs">
      <Chip icon={Cpu} label={d.chip.replace(/^Apple /, "")} sub={`${fmtBytes(d.totalMemory)} unified memory`} />
      <Chip icon={Gauge} label={fmtBytes(d.gpuBudget)} sub="for models (GPU)" />
      <Chip icon={HardDrive} label={fmtBytes(installedBytes)} sub="downloaded" />
      {loaded.length > 0 && <Chip icon={Sparkles} label={`${loaded.length} loaded`} sub="running now" accent />}
    </div>
  );
}

function Chip({ icon: Icon, label, sub, accent }: { icon: typeof Cpu; label: string; sub: string; accent?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2 bg-card px-3 py-1.5", accent && "text-primary")}>
      <Icon className="size-4 text-muted-foreground" aria-hidden />
      <div className="leading-tight">
        <div className="font-medium tabular">{label}</div>
        <div className="text-[10.5px] text-muted-foreground">{sub}</div>
      </div>
    </div>
  );
}
