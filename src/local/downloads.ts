// Downloads a model's GGUF files from the Hub: resumable (an interrupted file continues from its
// .part with an HTTP Range request), verified against the repo's sha256 before it counts, and
// cancellable. Progress is reported at most every 250 ms — a 5 GB file in 64 KB chunks would
// otherwise be 80,000 events on the SSE stream. The manifest is written last, so a model is only
// "installed" once every file is whole.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, createReadStream, rmSync, openSync, writeSync, closeSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { hfBase, modelDetail, recommendedSampling, type ModelDetail } from "./catalog.ts";
import { repoDir, saveManifest, modelId, getInstalled, type InstalledModel } from "./store.ts";
import type { Device } from "./fit.ts";

export type DownloadState = "queued" | "downloading" | "verifying" | "done" | "error" | "cancelled";

export interface DownloadProgress {
  id: string; // "<repo>:<quant>"
  repo: string;
  quant: string;
  state: DownloadState;
  received: number; // bytes, across every file of the quant
  total: number;
  bytesPerSec: number;
  error?: string;
}

type Listener = (p: DownloadProgress) => void;

// A file name from the repo listing, as a path under the repo directory. The Hub allows
// subdirectories ("Q4_K_M/model-00001-of-00002.gguf"); nothing may climb out of the directory.
export function safeRel(file: string): string {
  const n = normalize(file);
  if (n.startsWith("..") || n.startsWith("/") || n.includes("\0")) throw new Error(`refusing file path '${file}'`);
  return n;
}

export class DownloadManager {
  private active = new Map<string, { progress: DownloadProgress; abort: AbortController }>();

  constructor(
    private onProgress: Listener,
    private dev: Pick<Device, "gpuBudget">,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  list(): DownloadProgress[] {
    return [...this.active.values()].map((a) => a.progress);
  }

  // Starts (or joins) the download of one quant. Resolves once it is queued; the outcome arrives
  // through onProgress.
  async start(repo: string, quant: string): Promise<DownloadProgress> {
    const id = modelId(repo, quant);
    const running = this.active.get(id);
    if (running && (running.progress.state === "downloading" || running.progress.state === "queued" || running.progress.state === "verifying")) return running.progress;
    if (getInstalled(id)) throw new Error(`${id} is already installed`);
    const detail = await modelDetail(repo, this.dev, this.fetchImpl);
    if (detail.gated) throw new Error(`${repo} is gated — its authors require you to accept their terms on huggingface.co, which niti can't do for you. Pick another upload of the same model.`);
    const q = detail.quants.find((x) => x.quant === quant);
    if (!q) throw new Error(`${repo} has no ${quant} file`);
    const progress: DownloadProgress = { id, repo, quant, state: "queued", received: 0, total: q.size ?? 0, bytesPerSec: 0 };
    const abort = new AbortController();
    this.active.set(id, { progress, abort });
    this.onProgress({ ...progress });
    void this.run(detail, q.files, q.sha256 ?? [], progress, abort.signal);
    return progress;
  }

  cancel(id: string): boolean {
    const a = this.active.get(id);
    if (!a || a.progress.state === "done" || a.progress.state === "error" || a.progress.state === "cancelled") return false;
    a.abort.abort();
    return true;
  }

  private async run(detail: ModelDetail, files: string[], shas: string[], p: DownloadProgress, signal: AbortSignal): Promise<void> {
    const dir = repoDir(detail.repo);
    let lastEmit = 0;
    let windowStart = Date.now();
    let windowBytes = 0;
    const emit = (force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < 250) return;
      const secs = (now - windowStart) / 1000;
      if (secs >= 1) {
        p.bytesPerSec = Math.round(windowBytes / secs);
        windowStart = now;
        windowBytes = 0;
      }
      lastEmit = now;
      this.onProgress({ ...p });
    };
    try {
      p.state = "downloading";
      // Bytes already on disk from an earlier attempt count from the start.
      for (const f of files) {
        const dest = join(dir, safeRel(f));
        if (existsSync(dest)) p.received += statSync(dest).size;
        else if (existsSync(`${dest}.part`)) p.received += statSync(`${dest}.part`).size;
      }
      emit(true);
      for (const [i, f] of files.entries()) {
        const dest = join(dir, safeRel(f));
        if (existsSync(dest)) continue; // a finished file from an earlier attempt (verified then)
        mkdirSync(dirname(dest), { recursive: true });
        await this.fetchFile(detail.repo, f, `${dest}.part`, signal, (n) => {
          p.received += n;
          windowBytes += n;
          emit();
        });
        const sha = shas[i];
        if (sha) {
          p.state = "verifying";
          emit(true);
          const got = await sha256File(`${dest}.part`);
          if (got !== sha) {
            rmSync(`${dest}.part`, { force: true });
            throw new Error(`${f} failed its checksum — the download was corrupted; try again`);
          }
          p.state = "downloading";
        }
        renameSync(`${dest}.part`, dest);
      }
      const sampling = await recommendedSampling(detail.repo, detail.baseModel, this.fetchImpl).catch(() => undefined);
      const total = files.reduce((n, f) => n + statSync(join(dir, safeRel(f))).size, 0);
      const manifest: InstalledModel = {
        id: p.id,
        repo: detail.repo,
        quant: p.quant,
        format: detail.format,
        files: files.map(safeRel),
        bytes: total,
        params: detail.params,
        architecture: detail.architecture,
        contextLength: detail.contextLength,
        tools: detail.tools,
        thinking: detail.thinking,
        license: detail.license,
        installedAt: Date.now(),
        ...(sampling ? { sampling } : {}),
      };
      saveManifest(manifest);
      p.received = total;
      p.total = total;
      p.state = "done";
      emit(true);
    } catch (err) {
      p.state = signal.aborted ? "cancelled" : "error";
      if (!signal.aborted) p.error = err instanceof Error ? err.message : String(err);
      emit(true);
    }
  }

  private async fetchFile(repo: string, file: string, part: string, signal: AbortSignal, onBytes: (n: number) => void): Promise<void> {
    const have = existsSync(part) ? statSync(part).size : 0;
    const url = `${hfBase()}/${repo}/resolve/main/${file.split("/").map(encodeURIComponent).join("/")}`;
    const res = await this.fetchImpl(url, { signal, headers: have ? { range: `bytes=${have}-` } : {} });
    if (!res.ok && res.status !== 206) throw new Error(`download of ${file} failed: HTTP ${res.status}`);
    // A server that ignored the Range header sends the whole file again: start the part over.
    const append = have > 0 && res.status === 206;
    const fd = openSync(part, append ? "a" : "w");
    try {
      if (!append && have > 0) onBytes(-have);
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        writeSync(fd, value);
        onBytes(value.byteLength);
      }
    } finally {
      closeSync(fd);
    }
  }
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}
