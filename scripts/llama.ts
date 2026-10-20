// The local-model runtime both packagings ship: llama.cpp's llama-server, from a pinned,
// checksum-verified release, with only the libraries it links (@loader_path, so they sit beside it).
// The npm release (scripts/build-release.ts) puts it in bin/llama/ next to niti-core; the desktop
// app (niti-app/scripts/bundle-llama.ts) in Contents/Resources/llama. niti-core looks for ./llama
// beside itself (src/local/runtime.ts findLlamaServer). Mac only for now; bumping the release is a
// deliberate edit of LLAMA_TAG and the two checksums.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LLAMA_TAG = "b11537"; // 2026-10-09
export const LLAMA_SHA256: Record<"arm64" | "x64", string> = {
  arm64: "26a97a36c0471475795760635fce44d45232f43f4cbfff00c428388c4815aaa2",
  x64: "2bf899f48336ac4893055faee6f12e60403a0ea27e225d268de4890d33ce2adc",
};

// Fills `out` with llama-server for macOS `arch`. A no-op when `out` already holds this release.
export async function fetchLlamaServer(arch: "arm64" | "x64", out: string, log: (s: string) => void = console.log): Promise<void> {
  const sha = LLAMA_SHA256[arch];
  if (!sha) throw new Error(`unknown arch ${arch}`);
  const stamp = join(out, "VERSION");
  if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === `${LLAMA_TAG} ${sha}`) {
    log(`llama-server ${LLAMA_TAG} (${arch}) already in ${out}`);
    return;
  }
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/llama-${LLAMA_TAG}-bin-macos-${arch}.tar.gz`;
  log(`llama-server ${LLAMA_TAG} (${arch}) ← ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== sha) throw new Error(`checksum mismatch for ${url}: got ${got}, pinned ${sha}`);
  // Unpacked in a fresh temp directory; only llama-server and what it links are copied out.
  const work = mkdtempSync(join(tmpdir(), "niti-llama-"));
  try {
    const tgz = join(work, "llama.tgz");
    writeFileSync(tgz, bytes);
    const x = Bun.spawnSync(["tar", "-xzf", tgz, "-C", work]);
    if (x.exitCode !== 0) throw new Error(`tar failed: ${x.stderr}`);
    const dir = join(work, `llama-${LLAMA_TAG}`);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    cpSync(join(dir, "llama-server"), join(out, "llama-server"));
    cpSync(join(dir, "LICENSE"), join(out, "LICENSE"));
    // The release also carries every other tool and its libraries, which niti never runs. Each
    // library is copied under the exact name it is linked by — a real file, never a symlink, so
    // codesign, npm and the app packer have nothing to trip over.
    const queue = [join(dir, "llama-server")];
    const seen = new Set<string>();
    while (queue.length) {
      const bin = queue.pop()!;
      for (const [, name] of Bun.spawnSync(["otool", "-L", bin]).stdout.toString().matchAll(/@rpath\/([^\s]+)/g)) {
        if (seen.has(name!)) continue;
        seen.add(name!);
        const src = realpathSync(join(dir, name!));
        cpSync(src, join(out, name!));
        queue.push(src);
      }
    }
    writeFileSync(stamp, `${LLAMA_TAG} ${sha}\n`);
    const host = process.arch === "arm64" ? "arm64" : "x64";
    if (process.platform === "darwin" && arch === host && Bun.spawnSync([join(out, "llama-server"), "--version"]).exitCode !== 0) {
      throw new Error("the bundled llama-server does not run");
    }
    log(`  → ${out}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
