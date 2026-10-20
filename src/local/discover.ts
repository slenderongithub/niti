// Models already on this Mac that niti didn't download: LM Studio's models folder and the Hugging
// Face cache. Offered under "Found on this Mac"; adding one writes a manifest that points at the
// files where they are — nothing is copied, and removing it from niti never touches them. niti runs
// them on its own engines (llama.cpp for GGUF, MLX for MLX); the app that downloaded them isn't used.
import { openSync, readSync, closeSync, readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { quantOf, isAuxiliary, mlxBitsPerWeight, paramsFromName, bitsPerWeight } from "./quant.ts";
import { listInstalled, saveManifest, getInstalled, modelId, type InstalledModel, type ModelFormat } from "./store.ts";
import { templateHasThinking, templateHasTools } from "./catalog.ts";

export interface FoundModel {
  id: string; // what it would be called once added: "<publisher>/<name>:<quant|mlx>"
  repo: string;
  quant: string;
  format: ModelFormat;
  path: string; // its directory
  files: string[]; // relative to path
  bytes: number;
  source: string; // "LM Studio", "Hugging Face cache"
  params?: number;
  contextLength?: number;
  architecture?: string;
  tools?: boolean;
  thinking?: boolean;
  added: boolean;
}

// Where to look. NITI_DISCOVER_DIRS (paths joined by ":") replaces the defaults — every test harness
// sets it, so a test core never reads a real models folder.
export function discoverRoots(): { dir: string; source: string; layout: "lmstudio" | "hf" }[] {
  const env = process.env.NITI_DISCOVER_DIRS;
  if (env !== undefined) return env.split(":").filter(Boolean).map((dir) => ({ dir, source: "LM Studio", layout: dir.includes("huggingface") ? ("hf" as const) : ("lmstudio" as const) }));
  const h = homedir();
  return [
    { dir: join(h, ".lmstudio", "models"), source: "LM Studio", layout: "lmstudio" },
    { dir: join(h, ".cache", "lm-studio", "models"), source: "LM Studio", layout: "lmstudio" },
    { dir: join(h, ".cache", "huggingface", "hub"), source: "Hugging Face cache", layout: "hf" },
  ];
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const size = (p: string) => {
  try {
    return statSync(p).size; // follows the HF cache's symlinks into blobs/
  } catch {
    return 0;
  }
};

// ---- GGUF header: just the metadata a fit check and the tools badge need ------------------------

// GGUF v2/v3: magic, version, tensor count, kv count, then typed key/value pairs. Reads at most the
// first 16 MB (a chat template and a vocabulary sit there; the weights come after).
export function ggufMetadata(file: string): { architecture?: string; contextLength?: number; params?: number; chatTemplate?: string } {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(16 * 1024 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n < 24 || buf.toString("ascii", 0, 4) !== "GGUF") return {};
    let o = 8; // magic + version
    o += 8; // tensor count
    const kv = Number(buf.readBigUInt64LE(o));
    o += 8;
    const str = (): string => {
      const len = Number(buf.readBigUInt64LE(o));
      o += 8;
      const s = buf.toString("utf8", o, o + len);
      o += len;
      return s;
    };
    const SIZES: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
    const value = (t: number): unknown => {
      if (t === 8) return str();
      if (t === 9) {
        const et = buf.readUInt32LE(o);
        const len = Number(buf.readBigUInt64LE(o + 4));
        o += 12;
        for (let i = 0; i < len; i++) value(et); // skipped: only scalars are kept
        return undefined;
      }
      const sz = SIZES[t];
      if (sz === undefined) throw new Error("unknown GGUF type");
      const v = t === 4 ? buf.readUInt32LE(o) : t === 5 ? buf.readInt32LE(o) : t === 10 ? Number(buf.readBigUInt64LE(o)) : t === 11 ? Number(buf.readBigInt64LE(o)) : undefined;
      o += sz;
      return v;
    };
    const out: { architecture?: string; contextLength?: number; params?: number; chatTemplate?: string } = {};
    for (let i = 0; i < kv && o < n - 16; i++) {
      const key = str();
      const t = buf.readUInt32LE(o);
      o += 4;
      const v = value(t);
      if (key === "general.architecture" && typeof v === "string") out.architecture = v;
      else if (key.endsWith(".context_length") && typeof v === "number") out.contextLength = v;
      else if (key === "general.parameter_count" && typeof v === "number") out.params = v;
      else if (key === "tokenizer.chat_template" && typeof v === "string") out.chatTemplate = v;
    }
    return out;
  } catch {
    return {}; // truncated read or an unexpected type: the model is still addable, just less described
  } finally {
    closeSync(fd);
  }
}

// ---- one directory → what it holds ----------------------------------------------------------------

function mlxCandidate(dir: string, repo: string, source: string): FoundModel | undefined {
  const all = readdirSync(dir);
  if (!all.includes("config.json") || !all.some((f) => f.endsWith(".safetensors"))) return undefined;
  const files = all.filter((f) => /\.(safetensors|json|jinja|model|tiktoken)$/i.test(f) || /^(merges|vocab)[^/]*\.txt$/i.test(f));
  let template = "";
  let contextLength: number | undefined;
  let architecture: string | undefined;
  try {
    const tc = JSON.parse(readFileSync(join(dir, "tokenizer_config.json"), "utf8")) as { chat_template?: unknown };
    template = typeof tc.chat_template === "string" ? tc.chat_template : JSON.stringify(tc.chat_template ?? "");
  } catch {
    // no tokenizer config
  }
  if (all.includes("chat_template.jinja")) template += readFileSync(join(dir, "chat_template.jinja"), "utf8");
  try {
    const c = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as { max_position_embeddings?: number; model_type?: string; text_config?: { max_position_embeddings?: number } };
    contextLength = c.max_position_embeddings ?? c.text_config?.max_position_embeddings;
    architecture = c.model_type;
  } catch {
    // unreadable config: the engine will say so when it loads
  }
  const bytes = files.reduce((n, f) => n + size(join(dir, f)), 0);
  const name = repo.split("/").pop()!;
  return {
    id: modelId(repo, "mlx"),
    repo,
    quant: "mlx",
    format: "mlx",
    path: dir,
    files,
    bytes,
    source,
    params: paramsFromName(name) ?? Math.round((bytes * 8) / mlxBitsPerWeight(name)),
    contextLength,
    architecture,
    tools: templateHasTools(template),
    thinking: templateHasThinking(template),
    added: false,
  };
}

function ggufCandidates(dir: string, repo: string, source: string): FoundModel[] {
  const ggufs = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".gguf") && !isAuxiliary(f));
  const byQuant = new Map<string, string[]>();
  for (const f of ggufs) {
    const q = quantOf(f) ?? basename(f, ".gguf");
    byQuant.set(q, [...(byQuant.get(q) ?? []), f].sort());
  }
  return [...byQuant.entries()].map(([quant, files]) => {
    const meta = ggufMetadata(join(dir, files[0]!));
    const bytes = files.reduce((n, f) => n + size(join(dir, f)), 0);
    return {
      id: modelId(repo, quant),
      repo,
      quant,
      format: "gguf" as const,
      path: dir,
      files,
      bytes,
      source,
      params: meta.params ?? paramsFromName(repo.split("/").pop()!) ?? Math.round((bytes * 8) / bitsPerWeight(quant)),
      contextLength: meta.contextLength,
      architecture: meta.architecture,
      tools: meta.chatTemplate ? templateHasTools(meta.chatTemplate) : undefined,
      thinking: meta.chatTemplate ? templateHasThinking(meta.chatTemplate) : undefined,
      added: false,
    };
  });
}

// A repo id niti accepts ("publisher/name"), from a folder pair that may hold anything.
const clean = (s: string) => s.replace(/[^\w.-]/g, "-");

export function discoverModels(): FoundModel[] {
  const out: FoundModel[] = [];
  const addedPaths = new Map(listInstalled().filter((m) => m.path).map((m) => [`${m.path}|${m.quant}`, m.id]));
  for (const root of discoverRoots()) {
    if (!isDir(root.dir)) continue;
    try {
      if (root.layout === "lmstudio") {
        for (const pub of readdirSync(root.dir)) {
          const pubDir = join(root.dir, pub);
          if (!isDir(pubDir) || pub.startsWith(".")) continue;
          for (const name of readdirSync(pubDir)) {
            const dir = join(pubDir, name);
            if (!isDir(dir)) continue;
            const repo = `${clean(pub)}/${clean(name)}`;
            const mlx = mlxCandidate(dir, repo, root.source);
            if (mlx) out.push(mlx);
            else out.push(...ggufCandidates(dir, repo, root.source));
          }
        }
      } else {
        // models--org--name/snapshots/<revision>/…
        for (const entry of readdirSync(root.dir)) {
          const m = /^models--(.+?)--(.+)$/.exec(entry);
          if (!m) continue;
          const snaps = join(root.dir, entry, "snapshots");
          if (!isDir(snaps)) continue;
          const rev = readdirSync(snaps).map((r) => join(snaps, r)).filter(isDir).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
          if (!rev) continue;
          const repo = `${clean(m[1]!)}/${clean(m[2]!)}`;
          const mlx = mlxCandidate(rev, repo, root.source);
          if (mlx) out.push(mlx);
          else out.push(...ggufCandidates(rev, repo, root.source));
        }
      }
    } catch {
      // an unreadable folder costs its models, not the scan
    }
  }
  for (const f of out) f.added = addedPaths.has(`${f.path}|${f.quant}`) || !!getInstalled(f.id);
  return out.filter((f) => f.files.length > 0 && f.bytes > 0);
}

// Adds a found model by its id. The manifest records where the files are; they stay there.
export function addFoundModel(id: string): InstalledModel {
  const f = discoverModels().find((x) => x.id === id);
  if (!f) throw new Error(`${id} isn't among the models found on this Mac`);
  if (getInstalled(id)) throw new Error(`${id} is already in niti`);
  const m: InstalledModel = {
    id: f.id,
    repo: f.repo,
    quant: f.quant,
    format: f.format,
    files: f.files,
    bytes: f.bytes,
    path: realpathSync(f.path),
    source: f.source,
    params: f.params,
    architecture: f.architecture,
    contextLength: f.contextLength,
    tools: f.tools,
    thinking: f.thinking,
    installedAt: Date.now(),
  };
  saveManifest(m);
  return m;
}
