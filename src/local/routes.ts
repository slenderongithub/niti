// The local-models API under /local/*, for the app's Models page and the TUI's /models: the device,
// the Hub catalogue, installed models, downloads. Kept out of the phone bridge's allowlist
// (src/remote/bridge.ts) on purpose — downloading gigabytes or deleting a model is done at the Mac.
import { device, teamFit } from "./fit.ts";
import { searchCatalog, modelDetail, SORTS, type CatalogQuery, type SortKey } from "./catalog.ts";
import { listInstalled, removeInstalled, diskUsage, modelsDir, parseModelId, getInstalled, formatOf } from "./store.ts";
import { probeModel, templateOf } from "./probe.ts";
import { DownloadManager, type DownloadProgress } from "./downloads.ts";
import { findLlamaServer, localRuntime, type RuntimeStatus } from "./runtime.ts";
import { discoverModels, addFoundModel } from "./discover.ts";
import { ensureMlxEngine, mlxEngineStatus, removeMlxEngine, type EngineProgress } from "./mlx.ts";

export interface LocalApi {
  handle(p: string, method: string, u: URL, body: () => Promise<any>): Promise<Response | undefined>;
  downloads: DownloadManager;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export function localApi(publish: { download: (p: DownloadProgress) => void; runtime: (s: RuntimeStatus) => void }, fetchImpl: typeof fetch = fetch): LocalApi {
  const dev = device();
  const runtime = localRuntime(publish.runtime);
  const downloads = new DownloadManager(publish.download, dev, fetchImpl);
  // The MLX engine's install, reported like a model loading: as runtime status for "engine:mlx".
  const installMlx = () =>
    ensureMlxEngine((p: EngineProgress) => {
      if (p.stage === "python" || p.stage === "packages") publish.runtime({ model: "engine:mlx", engine: "mlx", state: "installing", stage: p.stage, received: p.received, total: p.total });
      else if (p.stage === "done") publish.runtime({ model: "engine:mlx", engine: "mlx", state: "ready" });
      else publish.runtime({ model: "engine:mlx", engine: "mlx", state: "error", error: p.error });
    }, fetchImpl);

  return {
    downloads,
    async handle(p, method, u, body) {
      if (!p.startsWith("/local/")) return undefined;

      if (p === "/local/device" && method === "GET") {
        return json({
          device: dev,
          modelsDir: modelsDir(),
          diskUsage: diskUsage(),
          runtimeAvailable: !!findLlamaServer(),
          mlx: mlxEngineStatus(),
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
          const download = await downloads.start(repo, quant);
          // An MLX model needs the MLX engine: fetch it alongside, so both are ready together.
          if (quant === "mlx") void installMlx().catch(() => {});
          return json({ download });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      }

      // Models already on this Mac (LM Studio's folder, the Hugging Face cache), and adding one: niti
      // records where it is and runs it on its own engine. Nothing is copied or moved.
      if (p === "/local/discover" && method === "GET") return json({ models: discoverModels() });
      if (p === "/local/import" && method === "POST") {
        const { id } = (await body()) as { id?: string };
        if (!id) return json({ error: "expected {id}" }, 400);
        try {
          const m = addFoundModel(id);
          if (m.format === "mlx") void installMlx().catch(() => {}); // ready by the time it's used
          return json({ model: m });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      }

      // The MLX engine: install it ahead of time (otherwise the first MLX model does), or remove it.
      if (p === "/local/engine/mlx" && method === "POST") {
        void installMlx().catch(() => {});
        return json({ ok: true, mlx: mlxEngineStatus() });
      }
      if (p === "/local/engine/mlx" && method === "DELETE") {
        if (listInstalled().some((m) => m.format === "mlx")) return json({ error: "remove your MLX models first — they need the engine" }, 409);
        removeMlxEngine();
        return json({ ok: true, mlx: mlxEngineStatus() });
      }

      if (p === "/local/download/cancel" && method === "POST") {
        const { id } = (await body()) as { id?: string };
        if (!id) return json({ error: "expected {id}" }, 400);
        return json({ ok: downloads.cancel(id) });
      }

      // Whether these local models (one entry per agent using one) fit in memory together, or take
      // turns — for team setup.
      if (p === "/local/team-fit" && method === "POST") {
        const { models } = (await body()) as { models?: string[] };
        if (!Array.isArray(models)) return json({ error: "expected {models: [id, …]}" }, 400);
        const counts = new Map<string, number>();
        for (const id of models) counts.set(id, (counts.get(id) ?? 0) + 1);
        const list = [...counts].flatMap(([id, agents]) => {
          const m = getInstalled(id);
          return m ? [{ id, params: m.params, bytes: m.bytes, quant: m.quant, contextLength: m.contextLength, agents, mlx: formatOf(m) === "mlx" }] : [];
        });
        return json(teamFit(list));
      }

      // The one-time model check, run again (after an update, or to see it happen).
      if (p === "/local/models/check" && method === "POST") {
        const { id } = (await body()) as { id?: string };
        if (!id || !parseModelId(id)) return json({ error: "expected {id}" }, 400);
        try {
          return json({ probe: await probeModel(id, { template: templateOf(getInstalled(id)!), runtime }) });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
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
