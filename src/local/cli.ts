// `niti-core models`: the Models page for the terminal. Lists what runs well on this Mac, searches the
// Hub, downloads (the best quantization for this Mac unless one is named), lists and removes what is
// installed. The same catalogue, fit check and downloader as the app's /local/* routes.
import { device } from "./fit.ts";
import { searchCatalog, modelDetail, type CatalogModel } from "./catalog.ts";
import { listInstalled, removeInstalled, parseModelId, modelsDir } from "./store.ts";
import { DownloadManager, type DownloadProgress } from "./downloads.ts";
import { discoverModels, addFoundModel } from "./discover.ts";

const GB = 1000 ** 3;
const size = (n?: number) => (n ? (n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`) : "?");
const params = (n?: number) => (n ? (n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B` : `${Math.round(n / 1e6)}M`) : "?");
const TIER: Record<string, string> = { "runs-well": "runs well", tight: "tight", "wont-fit": "won't fit" };

function row(m: CatalogModel): string {
  const q = m.pick ? m.quants.find((x) => x.quant === m.pick!.quant) : undefined;
  const tags = [m.tools ? "tools" : "chat only", m.thinking ? "thinking" : "", m.license ?? ""].filter(Boolean).join(", ");
  return `  ${m.repo}${m.format === "mlx" ? "  [MLX]" : ""}\n      ${params(m.params)} · ${m.pick ? `${m.pick.quant} ${size(q?.size)} · ${TIER[m.pick.fit.tier]}` : "no GGUF quants"} · ${tags} · ${m.downloads.toLocaleString("en-US")} downloads/mo${m.installed.length ? " · installed" : ""}`;
}

export async function modelsCommand(args: string[], out: (s: string) => void = console.log, fetchImpl: typeof fetch = fetch): Promise<number> {
  const dev = device();
  const [sub = "recommended", ...rest] = args;
  switch (sub) {
    case "recommended":
    case "search": {
      const r = await searchCatalog(sub === "search" ? { tab: "all", q: rest.join(" "), tools: false } : { tab: "recommended" }, dev, fetchImpl);
      if (r.offline) return (out("Hugging Face is out of reach — browsing needs the internet. Installed models: niti-core models list"), 1);
      if (r.error) return (out(`error: ${r.error}`), 1);
      if (!r.models.length) return (out(sub === "search" ? `No models match "${rest.join(" ")}".` : "Nothing fits this Mac comfortably — try: niti-core models search <name>"), 0);
      out(sub === "search" ? `Models matching "${rest.join(" ")}":` : `Recommended for this Mac (${size(dev.gpuBudget)} for models):`);
      for (const m of r.models.slice(0, 20)) out(row(m));
      out("\nDownload one: niti-core models get <repo>");
      return 0;
    }
    case "get": {
      const target = rest[0];
      if (!target) return (out("usage: niti-core models get <repo>[:<quant>]"), 2);
      const parsed = parseModelId(target);
      const repo = parsed?.repo ?? target;
      let quant = parsed?.quant;
      if (!quant) {
        const d = await modelDetail(repo, dev, fetchImpl);
        if (!d.pick) return (out(`${repo} has no quantization that fits this Mac.`), 1);
        quant = d.pick.quant;
      }
      let last = 0;
      const done = new Promise<DownloadProgress>((resolve) => {
        const dm = new DownloadManager((p) => {
          if (p.state === "done" || p.state === "error" || p.state === "cancelled") return resolve(p);
          const now = Date.now();
          if (now - last < 1000) return;
          last = now;
          const pct = p.total ? Math.round((p.received / p.total) * 100) : 0;
          out(`  ${p.state === "verifying" ? "verifying" : `${pct}%`}  ${size(p.received)} of ${size(p.total)}${p.bytesPerSec ? ` · ${size(p.bytesPerSec)}/s` : ""}`);
        }, dev, fetchImpl);
        out(`Downloading ${repo}:${quant}…`);
        dm.start(repo, quant!).catch((e) => resolve({ id: `${repo}:${quant}`, repo, quant: quant!, state: "error", received: 0, total: 0, bytesPerSec: 0, error: (e as Error).message }));
      });
      const p = await done;
      if (p.state !== "done") return (out(`error: ${p.error ?? p.state}`), 1);
      out(`Installed ${p.id}. Use it: provider local, model ${p.id}`);
      return 0;
    }
    case "list": {
      const ms = listInstalled();
      if (!ms.length) return (out("No models installed. See: niti-core models (or niti-core models found)"), 0);
      for (const m of ms) out(`  ${m.id}  ${(m.format ?? "gguf").toUpperCase()} · ${size(m.bytes)} · ${params(m.params)}${m.tools ? " · tools" : m.tools === false ? " · chat only" : ""}${m.path ? ` · from ${m.source ?? m.path}` : ""}${m.lastUsed ? ` · used ${new Date(m.lastUsed).toLocaleDateString()}` : ""}`);
      return 0;
    }
    case "check":
    case "doctor": {
      const id = rest[0];
      if (!id || !parseModelId(id)) return (out(`usage: niti-core models ${sub} <repo>:<quant>`), 2);
      const m = listInstalled().find((x) => x.id === id);
      if (!m) return (out(`${id} is not installed.`), 1);
      const { probeModel, templateOf } = await import("./probe.ts");
      const { localRuntime } = await import("./runtime.ts");
      let r = m.probe;
      if (sub === "check" || !r) {
        out(`Checking ${id} (one short test, about a minute)…`);
        try {
          r = await probeModel(id, { template: templateOf(m) });
        } catch (err) {
          localRuntime().stopAll();
          return (out(`error: the check couldn't run: ${(err as Error).message}`), 1);
        }
        localRuntime().stopAll();
      }
      const label = { ready: "Ready for agent work", partial: "Partly ready", "chat-only": "Chat only" }[r.verdict];
      out(`${label} — ${id} on ${r.engine}`);
      for (const n of r.notes) out(`  · ${n}`);
      out(`  tools: ${r.toolMode}${r.textFormat ? ` (${r.textFormat})` : ""}${r.prefill ? ` · starts calls with ${JSON.stringify(r.prefill)}` : ""} · planning: ${r.planMode} · thinking: ${r.thinking}${r.tokensPerSec ? ` · ~${r.tokensPerSec} tokens/s` : ""}`);
      if (sub === "doctor") {
        const { readFileSync, existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        for (const log of ["mlx-server.log", "llama-server.log"]) {
          const f = join(modelsDir(), log);
          if (!existsSync(f)) continue;
          const lines = readFileSync(f, "utf8").split("\n").filter((l) => /error|exception|died|failed|traceback/i.test(l)).slice(-8);
          if (lines.length) out(`\n${log} — recent errors:\n${lines.map((l) => `  ${l}`).join("\n")}`);
        }
      }
      return r.verdict === "chat-only" ? 1 : 0;
    }
    case "found": {
      const found = discoverModels();
      if (!found.length) return (out("No other models found on this Mac (looked in LM Studio's models folder and the Hugging Face cache)."), 0);
      out("Already on this Mac — add one to use it in niti without downloading it again:");
      for (const f of found) out(`  ${f.id}  ${f.format.toUpperCase()} · ${size(f.bytes)} · ${params(f.params)}${f.tools ? " · tools" : f.tools === false ? " · chat only" : ""} · ${f.source}${f.added ? " · added" : ""}`);
      out("\nAdd one: niti-core models add <id>");
      return 0;
    }
    case "add": {
      const id = rest[0];
      if (!id) return (out("usage: niti-core models add <id from niti-core models found>"), 2);
      try {
        const m = addFoundModel(id);
        out(`Added ${m.id} (files stay in ${m.path}). Use it: provider local, model ${m.id}`);
        if (m.format === "mlx") out("MLX models run on niti's MLX engine; it downloads once (about 140 MB) the first time one runs.");
        return 0;
      } catch (err) {
        return (out(`error: ${(err as Error).message}`), 1);
      }
    }
    case "rm": {
      const id = rest[0];
      if (!id || !parseModelId(id)) return (out("usage: niti-core models rm <repo>:<quant>"), 2);
      const external = listInstalled().find((m) => m.id === id)?.path;
      return removeInstalled(id) ? (out(external ? `Removed ${id} from niti (its files in ${external} are untouched).` : `Removed ${id}.`), 0) : (out(`${id} is not installed.`), 1);
    }
  }
  out("usage: niti-core models [recommended | search <query> | get <repo>[:<quant>] | list | found | add <id> | check <id> | doctor <id> | rm <repo>:<quant>]");
  return 2;
}
