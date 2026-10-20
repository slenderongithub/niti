import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useApp } from "@/store/app";
import type { CatalogQuery, CatalogResult, DownloadProgress, InstalledModel, LocalDevice, ModelDetail } from "@/lib/types";

// The Models page's data: this Mac, the Hub catalogue, what is installed, and downloads in flight.
// The core caches the Hub for 15 minutes; this keeps each query's answer for the life of the window
// too, so flipping between tabs and sorts is instant and never re-asks the network.

const catalogCache = new Map<string, CatalogResult>();
const detailCache = new Map<string, ModelDetail>();

// How many downloads have ended (done, cancelled, failed) — the installed list and the device's
// disk figure refetch when it moves.
function useDownloadEpoch(): number {
  const downloads = useApp((s) => s.session.local.downloads);
  return useMemo(() => Object.values(downloads).filter((d) => d.state === "done" || d.state === "error" || d.state === "cancelled").length, [downloads]);
}

export function useDevice(): LocalDevice | null {
  const api = useApp((s) => s.api);
  const epoch = useDownloadEpoch();
  const [device, setDevice] = useState<LocalDevice | null>(null);
  useEffect(() => {
    if (!api) return;
    let live = true;
    api.localDevice().then((d) => live && setDevice(d)).catch(() => {});
    return () => {
      live = false;
    };
  }, [api, epoch]);
  return device;
}

export function useCatalog(query: CatalogQuery): { result: CatalogResult | null; loading: boolean; error: string | null; retry: () => void } {
  const api = useApp((s) => s.api);
  const key = JSON.stringify(query);
  const [result, setResult] = useState<CatalogResult | null>(() => catalogCache.get(key) ?? null);
  const [loading, setLoading] = useState(!catalogCache.has(key));
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!api) return;
    const hit = catalogCache.get(key);
    if (hit && nonce === 0) {
      setResult(hit);
      setLoading(false);
      setError(null);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    api
      .catalog(query)
      .then((r) => {
        if (!live) return;
        if (!r.offline && !r.error) catalogCache.set(key, r);
        setResult(r);
      })
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [api, key, nonce]); // eslint-disable-line react-hooks/exhaustive-deps -- `key` is the query
  const retry = useCallback(() => {
    catalogCache.delete(key);
    setNonce((n) => n + 1);
  }, [key]);
  return { result, loading, error, retry };
}

export function useModelDetail(repo: string | null): { detail: ModelDetail | null; error: string | null } {
  const api = useApp((s) => s.api);
  const epoch = useDownloadEpoch();
  const [detail, setDetail] = useState<ModelDetail | null>(repo ? (detailCache.get(repo) ?? null) : null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!api || !repo) {
      setDetail(null);
      return;
    }
    let live = true;
    setError(null);
    setDetail(detailCache.get(repo) ?? null);
    api
      .modelDetail(repo)
      .then((d) => {
        detailCache.set(repo, d);
        if (live) setDetail(d);
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [api, repo, epoch]);
  return { detail, error };
}

export function useInstalled(): { models: InstalledModel[]; loaded: boolean; refresh: () => void } {
  const api = useApp((s) => s.api);
  const epoch = useDownloadEpoch();
  const [models, setModels] = useState<InstalledModel[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);
  const seeded = useRef(false);
  useEffect(() => {
    if (!api) return;
    let live = true;
    api
      .installedModels()
      .then((r) => {
        if (!live) return;
        setModels(r.models);
        setLoaded(true);
        // Downloads started before this window opened (or before a reload) aren't in the event
        // stream's replay once they're past it; seed them once from the core's own list.
        if (!seeded.current && r.downloads.length) {
          seeded.current = true;
          useApp.setState((s) => ({ session: { ...s.session, local: { ...s.session.local, downloads: { ...Object.fromEntries(r.downloads.map((d) => [d.id, d])), ...s.session.local.downloads } } } }));
        }
      })
      .catch(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [api, epoch, nonce]);
  return { models, loaded, refresh: () => setNonce((n) => n + 1) };
}

export function useDownload(id: string | undefined): DownloadProgress | undefined {
  return useApp((s) => (id ? s.session.local.downloads[id] : undefined));
}

export const isActive = (d?: DownloadProgress) => !!d && (d.state === "queued" || d.state === "downloading" || d.state === "verifying");

// Start, cancel and delete, with the toasts that say what happened.
export function useModelActions() {
  const api = useApp((s) => s.api);
  const start = useCallback(
    async (repo: string, quant: string, name: string) => {
      if (!api) return;
      try {
        await api.download(repo, quant);
        toast.success(`Downloading ${name}`, { description: `${quant} — you can keep working; it finishes in the background.` });
      } catch (e) {
        toast.error(`Couldn't download ${name}`, { description: (e as Error).message });
      }
    },
    [api],
  );
  const cancel = useCallback(async (id: string) => {
    try {
      await api?.cancelDownload(id);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [api]);
  const remove = useCallback(
    async (id: string) => {
      try {
        await api?.deleteModel(id);
        toast.success("Model deleted", { description: id });
        detailCache.clear();
        catalogCache.clear();
      } catch (e) {
        toast.error((e as Error).message);
      }
    },
    [api],
  );
  return { start, cancel, remove };
}

// A model's display name from its id: "unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M" → "Qwen3-4B-Instruct-2507".
export function modelName(id: string): string {
  const repo = id.includes(":") ? id.slice(0, id.lastIndexOf(":")) : id;
  return repo.slice(repo.indexOf("/") + 1).replace(/[-_.]?GGUF$/i, "");
}
