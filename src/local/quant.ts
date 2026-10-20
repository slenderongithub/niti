// GGUF file names → what a person picking a download needs: which quantization it is, roughly how
// many bits each weight costs, and which files belong together. Pure, so the marketplace, the fit
// check and the downloader all agree on one reading of a repo's file list.

// Bits per weight, measured across llama.cpp's own quantize table (the "bpw" column). An estimate
// of a file's size from the parameter count before its exact size is known, and the order quality
// improves in.
const BPW: Record<string, number> = {
  IQ1_S: 1.56,
  IQ1_M: 1.75,
  IQ2_XXS: 2.06,
  IQ2_XS: 2.31,
  IQ2_S: 2.5,
  IQ2_M: 2.7,
  Q2_K: 2.96,
  Q2_K_L: 3.1,
  IQ3_XXS: 3.06,
  IQ3_XS: 3.3,
  IQ3_S: 3.44,
  IQ3_M: 3.66,
  Q3_K_S: 3.5,
  Q3_K_M: 3.91,
  Q3_K_L: 4.27,
  Q3_K_XL: 4.3,
  IQ4_XS: 4.25,
  IQ4_NL: 4.5,
  MXFP4: 4.25,
  Q4_0: 4.55,
  Q4_1: 5.0,
  Q4_K_S: 4.58,
  Q4_K_M: 4.89,
  Q4_K_L: 5.0,
  Q4_K_XL: 5.0,
  Q5_0: 5.54,
  Q5_1: 6.0,
  Q5_K_S: 5.54,
  Q5_K_M: 5.69,
  Q5_K_L: 5.8,
  Q5_K_XL: 5.8,
  Q6_K: 6.56,
  Q6_K_L: 6.6,
  Q6_K_XL: 6.7,
  Q8_0: 8.5,
  Q8_K_XL: 8.6,
  BF16: 16,
  F16: 16,
  F32: 32,
};

const QUANT_RE = new RegExp(`(?:^|[-_.])((?:UD-)?(?:${Object.keys(BPW).sort((a, b) => b.length - a.length).join("|")}))(?=[-_.]|$)`, "i");
const SHARD_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;

export interface QuantFile {
  quant: string; // "Q4_K_M", "UD-Q4_K_XL", "BF16"
  files: string[]; // one, or every shard of a split model in order
  bpw: number;
  size?: number; // bytes, when the repo listing carried sizes
  sha256?: string[]; // per file, same order as files
  estimated?: boolean; // size worked out from the parameter count, not read from the repo
}

export function quantOf(file: string): string | undefined {
  const base = file.slice(file.lastIndexOf("/") + 1).replace(SHARD_RE, ".gguf");
  const m = QUANT_RE.exec(base.replace(/\.gguf$/i, ""));
  return m ? m[1]!.toUpperCase() : undefined;
}

export function bitsPerWeight(quant: string): number {
  return BPW[quant.replace(/^UD-/, "")] ?? 5;
}

// Files that sit beside the weights in a GGUF repo but are not a model you can chat with: vision
// projectors, imatrix calibration data, draft models for speculative decoding.
export function isAuxiliary(file: string): boolean {
  return /mmproj|imatrix|draft|vocab|\.dat$/i.test(file);
}

// Groups a repo's .gguf files by quantization; split models become one entry with all shards.
// Sorted smallest first, the order a person scans for "what fits".
export function quantFiles(siblings: { rfilename: string; size?: number; lfs?: { sha256?: string; size?: number } }[]): QuantFile[] {
  const groups = new Map<string, QuantFile>();
  for (const s of siblings) {
    const f = s.rfilename;
    if (!/\.gguf$/i.test(f) || isAuxiliary(f)) continue;
    const quant = quantOf(f);
    if (!quant) continue;
    const g = groups.get(quant) ?? { quant, files: [], bpw: bitsPerWeight(quant) };
    g.files.push(f);
    const size = s.lfs?.size ?? s.size;
    if (size !== undefined) g.size = (g.size ?? 0) + size;
    if (s.lfs?.sha256) (g.sha256 ??= []).push(s.lfs.sha256);
    groups.set(quant, g);
  }
  for (const g of groups.values()) {
    // Shards in order, so the first one is what llama-server is pointed at.
    const order = g.files.map((f, i) => ({ f, sha: g.sha256?.[i] })).sort((a, b) => a.f.localeCompare(b.f));
    g.files = order.map((o) => o.f);
    if (g.sha256) g.sha256 = order.map((o) => o.sha!).filter(Boolean);
  }
  return [...groups.values()].sort((a, b) => a.bpw - b.bpw || a.quant.localeCompare(b.quant));
}

// Size on disk when the listing carried none: parameters × bits per weight, plus the few percent a
// GGUF spends on its own metadata and the tensors kept at higher precision.
export function estimateBytes(params: number, quant: string): number {
  return Math.round((params * bitsPerWeight(quant)) / 8 * 1.04);
}
