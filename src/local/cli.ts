// `niti-core models`: the Models page for the terminal. Lists what runs well on this Mac, searches the
// Hub, downloads (the best quantization for this Mac unless one is named), lists and removes what is
// installed. The same catalogue, fit check and downloader as the app's /local/* routes.
import { device } from "./fit.ts";
import { searchCatalog, modelDetail, type CatalogModel } from "./catalog.ts";
import { listInstalled, removeInstalled, parseModelId } from "./store.ts";
import { DownloadManager, type DownloadProgress } from "./downloads.ts";

const GB = 1000 ** 3;
const size = (n?: number) => (n ? (n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`) : "?");
const params = (n?: number) => (n ? (n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B` : `${Math.round(n / 1e6)}M`) : "?");
const TIER: Record<string, string> = { "runs-well": "runs well", tight: "tight", "wont-fit": "won't fit" };

function row(m: CatalogModel): string {
  const q = m.pick ? m.quants.find((x) => x.quant === m.pick!.quant) : undefined;
  const tags = [m.tools ? "tools" : "chat only", m.thinking ? "thinking" : "", m.license ?? ""].filter(Boolean).join(", ");
  return `  ${m.repo}\n      ${params(m.params)} · ${m.pick ? `${m.pick.quant} ${size(q?.size)} · ${TIER[m.pick.fit.tier]}` : "no GGUF quants"} · ${tags} · ${m.downloads.toLocaleString("en-US")} downloads/mo${m.installed.length ? " · installed" : ""}`;
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
      if (!ms.length) return (out("No models installed. See: niti-core models"), 0);
      for (const m of ms) out(`  ${m.id}  ${size(m.bytes)} · ${params(m.params)}${m.tools ? " · tools" : " · chat only"}${m.lastUsed ? ` · used ${new Date(m.lastUsed).toLocaleDateString()}` : ""}`);
      return 0;
    }
    case "rm": {
      const id = rest[0];
      if (!id || !parseModelId(id)) return (out("usage: niti-core models rm <repo>:<quant>"), 2);
      return removeInstalled(id) ? (out(`Removed ${id}.`), 0) : (out(`${id} is not installed.`), 1);
    }
  }
  out("usage: niti-core models [recommended | search <query> | get <repo>[:<quant>] | list | rm <repo>:<quant>]");
  return 2;
}
