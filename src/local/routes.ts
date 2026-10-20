// The local-models API under /local/*, for the app's Models page and the TUI's /models: the device,
// the Hub catalogue, installed models, downloads. Kept out of the phone bridge's allowlist
// (src/remote/bridge.ts) on purpose — downloading gigabytes or deleting a model is done at the Mac.
import { device } from "./fit.ts";
import { searchCatalog, modelDetail, SORTS, type CatalogQuery, type SortKey } from "./catalog.ts";
import { listInstalled, removeInstalled, diskUsage, modelsDir, parseModelId } from "./store.ts";
import { DownloadManager, type DownloadProgress } from "./downloads.ts";
import { findLlamaServer, localRuntime, type RuntimeStatus } from "./runtime.ts";

export interface LocalApi {
  handle(p: string, method: string, u: URL, body: () => Promise<any>): Promise<Response | undefined>;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export function localApi(publish: { download: (p: DownloadProgress) => void; runtime: (s: RuntimeStatus) => void }, fetchImpl: typeof fetch = fetch): LocalApi {
  const dev = device();
  const runtime = localRuntime(publish.runtime);
  const downloads = new DownloadManager(publish.download, dev, fetchImpl);

  return {
    async handle(p, method, u, body) {
      if (!p.startsWith("/local/")) return undefined;

      if (p === "/local/device" && method === "GET") {
        return json({
          device: dev,
          modelsDir: modelsDir(),
          diskUsage: diskUsage(),
          runtimeAvailable: !!findLlamaServer(),
          runtime: runtime.status(),
        });
      }

      if (p === "/local/catalog" && method === "GET") {
        const sort = u.searchParams.get("sort");
        const size = u.searchParams.get("size");
        const q: CatalogQuery = {
          tab: u.searchParams.get("tab") === "recommended" ? "recommended" : "all",
          q: u.searchParams.get("q") ?? undefined,
          sort: sort && (SORTS as string[]).includes(sort) ? (sort as SortKey) : undefined,
          tools: u.searchParams.get("tools") === "1",
          fits: u.searchParams.get("fits") === "1",
          size: size === "small" || size === "medium" || size === "large" ? size : undefined,
          limit: Number(u.searchParams.get("limit") ?? 60) || 60,
        };
        return json(await searchCatalog(q, dev, fetchImpl));
      }

      if (p === "/local/catalog/model" && method === "GET") {
        const repo = u.searchParams.get("repo") ?? "";
        try {
          return json(await modelDetail(repo, dev, fetchImpl));
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      }

      if (p === "/local/models" && method === "GET") return json({ models: listInstalled(), downloads: downloads.list() });

      if (p === "/local/models" && method === "DELETE") {
        const id = u.searchParams.get("id") ?? "";
        if (!parseModelId(id)) return json({ error: "expected ?id=<repo>:<quant>" }, 400);
        runtime.stop(id);
        return removeInstalled(id) ? json({ ok: true }) : json({ error: `${id} is not installed` }, 404);
      }

      if (p === "/local/download" && method === "POST") {
        const { repo, quant } = (await body()) as { repo?: string; quant?: string };
        if (!repo || !quant || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "expected {repo, quant}" }, 400);
        try {
          return json({ download: await downloads.start(repo, quant) });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      }

      if (p === "/local/download/cancel" && method === "POST") {
        const { id } = (await body()) as { id?: string };
        if (!id) return json({ error: "expected {id}" }, 400);
        return json({ ok: downloads.cancel(id) });
      }

      if (p === "/local/unload" && method === "POST") {
        const { model } = (await body()) as { model?: string };
        if (!model) return json({ error: "expected {model}" }, 400);
        runtime.stop(model);
        return json({ ok: true });
      }

      return json({ error: "not found" }, 404);
    },
  };
}
