// Will this model run on this Mac, and how well? Pure arithmetic over the device's memory and the
// model's size, so the marketplace can say "Runs well / Tight / Won't fit" before a byte is
// downloaded, and the runtime can pick a context size that leaves room for every agent using it.
import { totalmem, cpus } from "node:os";
import { bitsPerWeight, estimateBytes, type QuantFile } from "./quant.ts";

export type FitTier = "runs-well" | "tight" | "wont-fit";

export interface Device {
  totalMemory: number; // bytes
  gpuBudget: number; // bytes the GPU may use for weights + KV cache
  appleSilicon: boolean;
  chip: string; // "Apple M3 Pro", "Intel(R) Core(TM) i9…"
}

export function device(): Device {
  const total = totalmem();
  const chip = cpus()[0]?.model ?? "unknown";
  const appleSilicon = process.platform === "darwin" && process.arch === "arm64";
  return { totalMemory: total, gpuBudget: gpuBudget(total, appleSilicon), appleSilicon, chip };
}

// Apple Silicon shares one pool between CPU and GPU, and Metal caps what the GPU may wire down
// (recommendedMaxWorkingSetSize): about two thirds of memory up to 36 GB, three quarters above.
// Elsewhere there is no GPU we drive, so the model runs from system memory with room left for the OS.
export function gpuBudget(total: number, appleSilicon: boolean): number {
  const GB = 1024 ** 3;
  if (!appleSilicon) return Math.round(total * 0.6);
  return Math.round(total * (total <= 36 * GB ? 0.67 : 0.75));
}

// KV cache bytes per token of context at f16. The exact figure needs layer and head counts the
// Hub's summary doesn't carry; across Llama/Qwen/Mistral/Gemma models with grouped-query attention
// it grows slowly with size (Qwen3-4B ≈ 144 KB, Llama-3-8B ≈ 128 KB, Llama-3-70B ≈ 320 KB).
export function kvBytesPerToken(params: number): number {
  const b = params / 1e9;
  return Math.round(Math.min(400, Math.max(64, 110 + 3 * b)) * 1024);
}

// llama.cpp's compute buffers and the Metal context, independent of model size.
const OVERHEAD = 768 * 1024 ** 2;

export interface FitInput {
  params: number; // total parameters (gguf.total)
  fileBytes?: number; // exact download size, when known
  quant: string;
  contextLength?: number; // the model's trained window
  slots?: number; // agents sharing the loaded model; each gets its own context
  ctx?: number; // per-slot context; chosen below when absent
}

export interface Fit {
  tier: FitTier;
  need: number; // bytes: weights + KV for every slot + overhead
  budget: number;
  ctx: number; // per-slot context this fit assumes
}

const CONTEXTS = [32_768, 16_384, 8_192];
export const MIN_CONTEXT = 8_192;

// Picks the largest standard context (32k → 16k → 8k, never above what the model was trained on)
// that still runs well, and reports the tier at that size. "Tight" means it loads but leaves the
// rest of the Mac little room — apps get swapped out, and generation slows.
export function fitModel(f: FitInput, dev: Pick<Device, "gpuBudget">): Fit {
  const weights = f.fileBytes ?? estimateBytes(f.params, f.quant);
  const slots = Math.max(1, f.slots ?? 1);
  const cap = f.contextLength && f.contextLength > 0 ? f.contextLength : 32_768;
  const options = f.ctx ? [f.ctx] : CONTEXTS.map((c) => Math.min(c, cap)).filter((c, i, a) => a.indexOf(c) === i);
  const needAt = (ctx: number) => weights + kvBytesPerToken(f.params) * ctx * slots + OVERHEAD;
  for (const ctx of options) {
    const need = needAt(ctx);
    if (need <= dev.gpuBudget * 0.85) return { tier: "runs-well", need, budget: dev.gpuBudget, ctx };
  }
  const ctx = options[options.length - 1]!;
  const need = needAt(ctx);
  return { tier: need <= dev.gpuBudget ? "tight" : "wont-fit", need, budget: dev.gpuBudget, ctx };
}

// The quant a person should download: Q4_K_M is the long-standing sweet spot of size, speed and
// quality, so it wins whenever it runs well. With plenty of room, step up (Q5_K_M, Q6_K, Q8_0 —
// slower but closer to the original); without, step down to the largest smaller one that fits.
// Never a 16/32-bit file, which no one needs for chatting with a model.
export function bestQuant(quants: QuantFile[], params: number, dev: Pick<Device, "gpuBudget">, slots = 1, contextLength?: number): { quant: QuantFile; fit: Fit } | undefined {
  const usable = quants.filter((q) => bitsPerWeight(q.quant) < 16);
  if (!usable.length) return undefined;
  const fitOf = (q: QuantFile) => fitModel({ params, fileBytes: q.size, quant: q.quant, slots, contextLength }, dev);
  const byName = (n: string) => usable.find((q) => q.quant === n || q.quant === `UD-${n}`);
  const base = byName("Q4_K_M") ?? usable.find((q) => /^(UD-)?Q4_/.test(q.quant)) ?? usable.find((q) => q.bpw >= 4 && q.bpw < 5.5);
  if (base) {
    const baseFit = fitOf(base);
    if (baseFit.tier === "runs-well") {
      // Room to spare (under half the budget at the base quant): step up while it still runs well.
      if (baseFit.need < dev.gpuBudget * 0.5) {
        for (const n of ["Q8_0", "Q6_K", "Q5_K_M"]) {
          const q = byName(n);
          if (!q) continue;
          const fit = fitOf(q);
          if (fit.tier === "runs-well" && fit.need < dev.gpuBudget * 0.6) return { quant: q, fit };
        }
      }
      return { quant: base, fit: baseFit };
    }
  }
  // Largest quant that runs well, else the smallest that loads at all.
  const ranked = [...usable].sort((a, b) => b.bpw - a.bpw);
  for (const q of ranked) {
    const fit = fitOf(q);
    if (fit.tier === "runs-well") return { quant: q, fit };
  }
  const smallest = ranked[ranked.length - 1]!;
  return { quant: smallest, fit: fitOf(smallest) };
}
