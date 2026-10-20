// The model marketplace's data: GGUF text-generation models live from the Hugging Face Hub, with
// what a person needs to choose one — popularity, freshness, licence, size, context, whether it can
// call tools — and what this Mac can run. One list request carries everything the rows show
// (`expand[]=gguf` returns parameters, architecture, context and chat template per repo); the exact
// file sizes and checksums come from a per-repo request when the detail sheet opens.
import { quantFiles, estimateBytes, mlxBitsPerWeight, mlxBits, paramsFromName, type QuantFile } from "./quant.ts";
import { mlxSupported } from "./mlx.ts";
import { bestQuant, fitModel, type Device, type Fit } from "./fit.ts";
import { listInstalled, type Sampling } from "./store.ts";

export const hfBase = () => (process.env.NITI_HF_URL ?? "https://huggingface.co").replace(/\/$/, "");

export type SortKey = "downloads" | "likes" | "trendingScore" | "lastModified";
export const SORTS: SortKey[] = ["downloads", "likes", "trendingScore", "lastModified"];

export type Format = "gguf" | "mlx";

export interface CatalogModel {
  repo: string; // "unsloth/Qwen3-4B-Instruct-2507-GGUF"
  format: Format; // GGUF runs on llama.cpp; MLX on Apple's mlx-lm (Apple Silicon only)
  name: string; // "Qwen3-4B-Instruct-2507"
  author: string;
  downloads: number; // last 30 days
  downloadsAllTime?: number;
  likes: number;
  trendingScore?: number;
  lastModified?: string;
  createdAt?: string;
  license?: string;
  baseModel?: string;
  gated: boolean;
  params?: number;
  architecture?: string;
  contextLength?: number;
  tools: boolean; // the chat template renders a tools list
  thinking: boolean; // the template has a reasoning switch
  quants: QuantFile[];
  pick?: { quant: string; fit: Fit }; // the quant this Mac should download, and how it fits
  installed: string[]; // quants of this repo already on disk
}

export interface CatalogQuery {
  tab?: "recommended" | "all";
  q?: string;
  sort?: SortKey;
  tools?: boolean; // only models that can call tools
  fits?: boolean; // only models that run well here
  size?: "small" | "medium" | "large"; // < 8B, 8–32B, > 32B parameters
  format?: Format | "any";
  limit?: number;
}

export interface CatalogResult {
  models: CatalogModel[];
  offline?: boolean;
  error?: string;
}

interface HubModel {
  id: string;
  author?: string;
  downloads?: number;
  downloadsAllTime?: number;
  likes?: number;
  trendingScore?: number;
  lastModified?: string;
  createdAt?: string;
  gated?: boolean | string;
  tags?: string[];
  cardData?: { license?: string; base_model?: string | string[] };
  gguf?: { total?: number; architecture?: string; context_length?: number; chat_template?: string };
  safetensors?: { total?: number };
  config?: { model_type?: string; tokenizer_config?: { chat_template?: unknown }; chat_template_jinja?: string };
  siblings?: { rfilename: string; size?: number; lfs?: { sha256?: string; size?: number } }[];
}

// Tool calling lives in the chat template: a template that never mentions `tools` has nowhere to
// put the tool list, so the model was not trained to call them.
export function templateHasTools(t?: string): boolean {
  return !!t && /\btools\b/.test(t);
}

export function templateHasThinking(t?: string): boolean {
  return !!t && /enable_thinking|<think>|reasoning_content|thinking/.test(t);
}

// An MLX repo's chat template sits in its tokenizer config (a string, or named variants) or in a
// separate chat_template.jinja, which the Hub surfaces as config.chat_template_jinja.
function mlxTemplate(m: HubModel): string {
  const t = m.config?.tokenizer_config?.chat_template;
  const fromTok = typeof t === "string" ? t : Array.isArray(t) ? t.map((x) => (x as { template?: string }).template ?? "").join("\n") : "";
  return `${fromTok}\n${m.config?.chat_template_jinja ?? ""}`;
}

// The files the MLX engine loads: weights, configs, tokenizer, chat template. Not the README, images,
// licences, PyTorch or GGUF copies, and never Python (which only runs with trust_remote_code).
export function mlxFiles(siblings: { rfilename: string }[]): string[] {
  return siblings
    .map((s) => s.rfilename)
    .filter((f) => /\.(safetensors|json|jinja|model|tiktoken)$/i.test(f) || /^(merges|vocab)[^/]*\.txt$/i.test(f))
    .filter((f) => !/^\.|(^|\/)(README|LICENSE|NOTICE)|\.gguf$|\.py$|^(onnx|original)\//i.test(f));
}

export function isMlxRepo(m: HubModel): boolean {
  const sib = m.siblings ?? [];
  return sib.some((s) => s.rfilename.endsWith(".safetensors")) && !sib.some((s) => s.rfilename.endsWith(".gguf")) && sib.some((s) => s.rfilename === "config.json");
}

const EXPAND = ["gguf", "safetensors", "config", "downloads", "downloadsAllTime", "likes", "trendingScore", "lastModified", "createdAt", "gated", "tags", "cardData", "siblings"];

function licenseOf(m: HubModel): string | undefined {
  return m.cardData?.license ?? m.tags?.find((t) => t.startsWith("license:"))?.slice(8);
}

function baseModelOf(m: HubModel): string | undefined {
  const b = m.cardData?.base_model ?? m.tags?.find((t) => t.startsWith("base_model:") && !t.includes(":quantized:"))?.split(":").pop();
  return Array.isArray(b) ? b[0] : b;
}

function toMlxModel(m: HubModel, dev: Pick<Device, "gpuBudget">, installed: string[]): CatalogModel {
  const name = m.id.slice(m.id.indexOf("/") + 1);
  const files = mlxFiles(m.siblings ?? []);
  const sizes = (m.siblings ?? []).filter((s) => files.includes(s.rfilename));
  const known = sizes.every((s) => s.size !== undefined || s.lfs?.size !== undefined);
  const params = paramsFromName(name) ?? m.safetensors?.total;
  const bpw = mlxBitsPerWeight(name);
  const exact = known && sizes.length ? sizes.reduce((n, s) => n + (s.lfs?.size ?? s.size ?? 0), 0) : undefined;
  const size = exact ?? (params ? Math.round((params * bpw) / 8 * 1.03) : undefined);
  // One entry per file, in order: the Hub's sha256 for the large (LFS) ones, "" for the small JSON
  // and tokenizer files it publishes none for.
  const bySib = new Map((m.siblings ?? []).map((x) => [x.rfilename, x]));
  const shas = files.map((f) => bySib.get(f)?.lfs?.sha256 ?? "");
  const quant: QuantFile = { quant: "mlx", files, bpw, ...(size ? { size } : {}), ...(exact === undefined && size ? { estimated: true } : {}), ...(shas.some(Boolean) ? { sha256: shas } : {}) };
  const template = mlxTemplate(m);
  const fit = params ? fitModel({ params, fileBytes: size, quant: `${mlxBits(name)}bit`, contextLength: undefined }, dev) : undefined;
  return {
    repo: m.id,
    format: "mlx",
    name: name.replace(/[-_.]?MLX(?=[-_.]|$)/i, "").replace(/--/g, "-"),
    author: m.author ?? m.id.split("/")[0]!,
    downloads: m.downloads ?? 0,
    downloadsAllTime: m.downloadsAllTime,
    likes: m.likes ?? 0,
    trendingScore: m.trendingScore,
    lastModified: m.lastModified,
    createdAt: m.createdAt,
    license: licenseOf(m),
    baseModel: baseModelOf(m),
    gated: !!m.gated,
    params,
    architecture: m.config?.model_type,
    tools: templateHasTools(template),
    thinking: templateHasThinking(template),
    quants: files.length ? [quant] : [],
    pick: fit && files.length ? { quant: "mlx", fit } : undefined,
    installed,
  };
}

export function toCatalogModel(m: HubModel, dev: Pick<Device, "gpuBudget">, installed: string[] = []): CatalogModel {
  if (isMlxRepo(m)) return toMlxModel(m, dev, installed);
  const quants = quantFiles(m.siblings ?? []);
  const params = m.gguf?.total;
  const pick = params ? bestQuant(quants, params, dev, 1, m.gguf?.context_length) : undefined;
  const name = m.id.slice(m.id.indexOf("/") + 1).replace(/[-_.]?GGUF$/i, "");
  return {
    repo: m.id,
    format: "gguf",
    name,
    author: m.author ?? m.id.split("/")[0]!,
    downloads: m.downloads ?? 0,
    downloadsAllTime: m.downloadsAllTime,
    likes: m.likes ?? 0,
    trendingScore: m.trendingScore,
    lastModified: m.lastModified,
    createdAt: m.createdAt,
    license: licenseOf(m),
    baseModel: baseModelOf(m),
    gated: !!m.gated,
    params,
    architecture: m.gguf?.architecture,
    contextLength: m.gguf?.context_length,
    tools: templateHasTools(m.gguf?.chat_template),
    thinking: templateHasThinking(m.gguf?.chat_template),
    // The list endpoint carries file names only; sizes there are estimates from the parameter count
    // until the detail request (blobs=true) brings the exact ones.
    quants: quants.map((q) => (q.size === undefined && params ? { ...q, size: estimateBytes(params, q.quant), estimated: true } : q)),
    pick: pick ? { quant: pick.quant.quant, fit: pick.fit } : undefined,
    installed,
  };
}

// The Hub answers a list of the same models in a few hundred ms; a person flipping tabs and sorts
// should not pay that every time, and the Hub should not see a request per keystroke.
const CACHE_MS = 15 * 60_000;
const cache = new Map<string, { at: number; data: unknown }>();

async function hubJson<T>(path: string, fetchImpl: typeof fetch): Promise<T> {
  const url = `${hfBase()}${path}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data as T;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Hugging Face answered ${res.status}`);
  const data = (await res.json()) as T;
  cache.set(url, { at: Date.now(), data });
  return data;
}

export function clearCatalogCache(): void {
  cache.clear();
}

function listPath(format: Format, sort: SortKey, q: string | undefined, limit: number): string {
  const params = new URLSearchParams({ filter: format, pipeline_tag: "text-generation", sort, direction: "-1", limit: String(limit) });
  if (q) params.set("search", q);
  for (const e of EXPAND) params.append("expand[]", e);
  return `/api/models?${params}`;
}

function sizeBucket(params?: number): "small" | "medium" | "large" | undefined {
  if (!params) return undefined;
  const b = params / 1e9;
  return b < 8 ? "small" : b <= 32 ? "medium" : "large";
}

function installedByRepo(): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const m of listInstalled()) by.set(m.repo, [...(by.get(m.repo) ?? []), m.quant]);
  return by;
}

// "Recommended for this Mac": the most downloaded models that can call tools and run well here,
// one repo per base model (the same weights are re-packaged by several uploaders, and a list of
// five Qwen3-4B copies recommends one model). "All models": the Hub's own order for the chosen sort,
// with the filters applied.
export async function searchCatalog(query: CatalogQuery, dev: Pick<Device, "gpuBudget">, fetchImpl: typeof fetch = fetch): Promise<CatalogResult> {
  if (process.env.NITI_OFFLINE === "1" && !process.env.NITI_HF_URL) return { models: [], offline: true };
  const tab = query.tab ?? "all";
  const sort = tab === "recommended" ? "downloads" : (query.sort ?? "downloads");
  const limit = Math.min(Math.max(query.limit ?? 60, 1), 100);
  // MLX only where it runs. Both formats are asked for at once and merged in the chosen order.
  const mlxOk = mlxSupported() || !!process.env.NITI_MLX_SERVER; // tests stand an engine in anywhere
  const wanted = query.format && query.format !== "any" ? [query.format] : (["gguf", ...(mlxOk ? ["mlx"] : [])] as Format[]);
  const formats = wanted.filter((f) => f === "gguf" || mlxOk);
  let raw: HubModel[];
  try {
    const lists = await Promise.all(formats.map((f) => hubJson<HubModel[]>(listPath(f, sort, query.q?.trim() || undefined, tab === "recommended" ? 100 : limit), fetchImpl)));
    const key = (m: HubModel): number | string => (sort === "lastModified" ? (m.lastModified ?? "") : ((m[sort as "downloads" | "likes" | "trendingScore"] as number | undefined) ?? 0));
    const seenIds = new Set<string>();
    raw = lists.flat().filter((m) => !seenIds.has(m.id) && (seenIds.add(m.id), true)).sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const offline = /fetch failed|ENOTFOUND|ECONNREFUSED|timed out|abort|network|Unable to connect/i.test(msg);
    return { models: [], offline, error: offline ? undefined : msg };
  }
  const inst = installedByRepo();
  let models = raw.filter((m) => m.gguf || isMlxRepo(m)).map((m) => toCatalogModel(m, dev, inst.get(m.id)));
  if (tab === "recommended") {
    const seen = new Set<string>();
    models = models.filter((m) => {
      if (!m.tools || m.gated || !m.pick || m.pick.fit.tier !== "runs-well") return false;
      // One per model family: GGUF and MLX uploads of the same weights count as one.
      const key = (m.baseModel ?? m.name).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (query.tools) models = models.filter((m) => m.tools);
  if (query.fits) models = models.filter((m) => m.pick && m.pick.fit.tier !== "wont-fit");
  if (query.size) models = models.filter((m) => sizeBucket(m.params) === query.size);
  return { models: models.slice(0, limit) };
}

export interface ModelDetail extends CatalogModel {
  readme: string; // the model card, front matter removed, trimmed
  fits: Record<string, Fit>; // per quant
}

// One repo with exact file sizes and checksums (blobs=true) and its model card — what the detail
// sheet and the downloader need.
export async function modelDetail(repo: string, dev: Pick<Device, "gpuBudget">, fetchImpl: typeof fetch = fetch): Promise<ModelDetail> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("not a Hugging Face repo id");
  const params = new URLSearchParams({ blobs: "true" });
  for (const e of EXPAND) params.append("expand[]", e);
  const m = await hubJson<HubModel>(`/api/models/${repo}?${params}`, fetchImpl);
  const base = toCatalogModel(m, dev, installedByRepo().get(repo));
  // An MLX repo's context window is in its config.json, not the Hub's summary.
  if (base.format === "mlx" && !base.contextLength) {
    try {
      const res = await fetchImpl(`${hfBase()}/${repo}/raw/main/config.json`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const c = (await res.json()) as { max_position_embeddings?: number; text_config?: { max_position_embeddings?: number } };
        base.contextLength = c.max_position_embeddings ?? c.text_config?.max_position_embeddings;
        if (base.pick && base.params) base.pick = { quant: "mlx", fit: fitModel({ params: base.params, fileBytes: base.quants[0]?.size, quant: "mlx", contextLength: base.contextLength }, dev) };
      }
    } catch {
      // the default context applies
    }
  }
  const fits: Record<string, Fit> = {};
  for (const q of base.quants) {
    if (base.params) fits[q.quant] = fitModel({ params: base.params, fileBytes: q.size, quant: q.quant, contextLength: base.contextLength }, dev);
  }
  let readme = "";
  try {
    const res = await fetchImpl(`${hfBase()}/${repo}/raw/main/README.md`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) readme = cleanReadme(await res.text());
  } catch {
    // the card is a nicety; the sheet works without it
  }
  return { ...base, readme, fits };
}

export function cleanReadme(md: string): string {
  const body = md.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return body.length > 6000 ? `${body.slice(0, 6000)}…` : body;
}

// The settings the model's authors recommend, from generation_config.json — in the GGUF repo when
// the uploader kept it, else in the base model's repo. Unknown fields are ignored; a model whose
// authors published nothing gets the runtime's defaults (see runtime.ts).
export async function recommendedSampling(repo: string, baseModel: string | undefined, fetchImpl: typeof fetch = fetch): Promise<Sampling | undefined> {
  for (const r of [repo, baseModel]) {
    if (!r || !/^[\w.-]+\/[\w.-]+$/.test(r)) continue;
    try {
      const res = await fetchImpl(`${hfBase()}/${r}/raw/main/generation_config.json`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const g = (await res.json()) as Record<string, unknown>;
      const num = (k: string) => (typeof g[k] === "number" ? (g[k] as number) : undefined);
      const s: Sampling = {
        temperature: num("temperature"),
        top_p: num("top_p"),
        top_k: num("top_k"),
        min_p: num("min_p"),
        repeat_penalty: num("repetition_penalty"),
      };
      if (Object.values(s).some((v) => v !== undefined)) return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as Sampling;
    } catch {
      // try the next repo
    }
  }
  return undefined;
}
