// Where downloaded models live and what is installed. One directory per Hugging Face repo, holding
// its .gguf files and a manifest.json per installed quant; the manifests are the source of truth for
// "installed", so a half-finished download (no manifest yet) never shows up as a model you can pick.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Overridable so a test core never reads or fills the real models directory (see scripts/e2e/*
// and niti-app/scripts/fixture.ts, which set it for every harness).
export function modelsDir(): string {
  if (process.env.NITI_LOCAL_MODELS_DIR) return process.env.NITI_LOCAL_MODELS_DIR;
  if (process.platform === "darwin") return join(homedir(), "Library/Application Support/niti/models");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "niti/models");
}

export interface Sampling {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  presence_penalty?: number;
  repeat_penalty?: number;
}

export type ModelFormat = "gguf" | "mlx";

// The model check's findings (src/local/probe.ts). Kept here, with the manifest it lives in.
export interface ProbeResult {
  version: number;
  checkedAt: number;
  engine: "llama.cpp" | "mlx";
  // How it calls tools: through the API on its own; only when forced (llama.cpp grammar, or an MLX
  // reply started for it); only as text niti has to read out of the reply; or not at all.
  toolMode: "native" | "forced" | "text" | "none";
  textFormat?: string; // the text shape it writes calls in, when it does
  prefill?: string; // the opener that starts a call in its format (for forcing on MLX)
  planMode: "lines" | "json" | "none"; // how it can plan work for a team
  stops: string[]; // template tokens it leaked past its end of turn
  thinking: "separate" | "inline" | "none";
  tokensPerSec?: number;
  verdict: "ready" | "partial" | "chat-only";
  notes: string[]; // what a person reads: why the verdict
}

export interface InstalledModel {
  id: string; // "<repo>:<quant>" — what an agent's `model:` names; MLX models use the quant "mlx"
  repo: string;
  quant: string;
  format?: ModelFormat; // unset = gguf (manifests written before MLX support)
  files: string[]; // relative to the model's directory, shards in order
  // A model that stays where it already was (one added from LM Studio's folder): its directory.
  // niti reads it there and never deletes it — removing it only forgets it.
  path?: string;
  source?: string; // where an added model came from: "LM Studio", "Hugging Face cache"
  bytes: number;
  params?: number;
  architecture?: string;
  contextLength?: number;
  tools?: boolean; // the chat template handles a tools list
  thinking?: boolean; // the template has a thinking switch (enable_thinking / <think>)
  sampling?: Sampling; // the model's own recommended settings (generation_config.json)
  license?: string;
  installedAt: number;
  lastUsed?: number;
  // Learned when the runtime first loads it (GET /props): "native" = llama.cpp has a dedicated
  // parser for this template's tool calls; "generic" = its fallback format, which is less reliable.
  toolFormat?: "native" | "generic" | "none";
  // What niti learned by testing the model once (probe.ts): how to drive it as an agent.
  probe?: ProbeResult;
}

// "unsloth/Qwen3-4B-GGUF:Q4_K_M" → repo + quant. Repo ids contain one slash; quants never contain
// a colon, so the last colon splits them.
export function parseModelId(id: string): { repo: string; quant: string } | undefined {
  const i = id.lastIndexOf(":");
  if (i <= 0 || i === id.length - 1) return undefined;
  const repo = id.slice(0, i);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return undefined;
  return { repo, quant: id.slice(i + 1) };
}

export const modelId = (repo: string, quant: string) => `${repo}:${quant}`;

// A repo id as a directory name: "unsloth/Qwen3-4B-GGUF" → "unsloth__Qwen3-4B-GGUF". The id was
// validated above, so no ".." or other separators survive into a path.
export function repoDir(repo: string): string {
  return join(modelsDir(), repo.replace("/", "__"));
}

export const formatOf = (m: InstalledModel): ModelFormat => m.format ?? "gguf";

// Where a model's files are: its own folder for one niti downloaded, or where it was found.
export function modelDir(m: InstalledModel): string {
  return m.path ?? repoDir(m.repo);
}

const manifestName = (quant: string) => `manifest.${quant}.json`;

export function listInstalled(): InstalledModel[] {
  const root = modelsDir();
  if (!existsSync(root)) return [];
  const out: InstalledModel[] = [];
  for (const d of readdirSync(root)) {
    const dir = join(root, d);
    try {
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) {
        if (!/^manifest\..+\.json$/.test(f)) continue;
        const m = JSON.parse(readFileSync(join(dir, f), "utf8")) as InstalledModel;
        if (m.id && m.files?.length && m.files.every((x) => existsSync(join(modelDir(m), x)))) out.push(m);
      }
    } catch {
      // an unreadable entry is skipped, never fatal to the listing
    }
  }
  return out.sort((a, b) => (b.lastUsed ?? b.installedAt) - (a.lastUsed ?? a.installedAt));
}

export function getInstalled(id: string): InstalledModel | undefined {
  const p = parseModelId(id);
  if (!p) return undefined;
  const file = join(repoDir(p.repo), manifestName(p.quant));
  if (!existsSync(file)) return undefined;
  try {
    const m = JSON.parse(readFileSync(file, "utf8")) as InstalledModel;
    return m.files.every((x) => existsSync(join(modelDir(m), x))) ? m : undefined;
  } catch {
    return undefined;
  }
}

// What the engine is pointed at: the first .gguf file for llama-server, the folder for MLX.
export function modelPath(m: InstalledModel): string {
  return formatOf(m) === "mlx" ? modelDir(m) : join(modelDir(m), m.files[0]!);
}

export function saveManifest(m: InstalledModel): void {
  const dir = repoDir(m.repo);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, manifestName(m.quant));
  writeFileSync(`${file}.tmp`, JSON.stringify(m, null, 2));
  renameSync(`${file}.tmp`, file);
}

export function updateManifest(id: string, patch: Partial<InstalledModel>): void {
  const m = getInstalled(id);
  if (m) saveManifest({ ...m, ...patch });
}

// Removes one quant: its manifest and its files. The repo directory goes too once nothing else of
// it is installed or downloading.
export function removeInstalled(id: string): boolean {
  const m = getInstalled(id);
  const p = parseModelId(id);
  if (!p) return false;
  const dir = repoDir(p.repo);
  if (!existsSync(dir)) return false;
  rmSync(join(dir, manifestName(p.quant)), { force: true });
  // An added model's files belong to wherever it came from: only niti's record of it goes.
  for (const f of m?.path ? [] : (m?.files ?? [])) {
    rmSync(join(dir, f), { force: true });
    rmSync(join(dir, `${f}.part`), { force: true });
  }
  if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  return !!m;
}

// What niti's own downloads take (added models live elsewhere and aren't counted).
export function diskUsage(): number {
  return listInstalled().reduce((n, m) => n + (m.path ? 0 : m.bytes), 0);
}
