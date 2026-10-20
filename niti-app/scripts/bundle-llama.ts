// Fetch the pinned llama.cpp release and keep the one program niti runs — llama-server — with the
// libraries it links (@loader_path, so they sit beside it) in resources/<arch>/llama/, which
// electron-builder ships as Contents/Resources/llama and niti-core finds next to itself
// (src/local/runtime.ts findLlamaServer). Checksum-pinned: a release that changed under the same tag
// fails the build instead of shipping. Bumping it is a deliberate edit of these three lines.
//   bun scripts/bundle-llama.ts            # this machine's arch
//   bun scripts/bundle-llama.ts arm64 x64  # both macOS arches
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LLAMA_TAG = "b11537"; // 2026-10-09
const SHA256: Record<string, string> = {
  arm64: "26a97a36c0471475795760635fce44d45232f43f4cbfff00c428388c4815aaa2",
  x64: "2bf899f48336ac4893055faee6f12e60403a0ea27e225d268de4890d33ce2adc",
};

const host = process.arch === "arm64" ? "arm64" : "x64";
const arches = process.argv.slice(2).length ? process.argv.slice(2) : [host];

for (const arch of arches) {
  if (!SHA256[arch]) throw new Error(`unknown arch ${arch}`);
  const out = join(import.meta.dir, "..", "resources", arch, "llama");
  const stamp = join(out, "VERSION");
  if (existsSync(stamp) && (await Bun.file(stamp).text()).trim() === `${LLAMA_TAG} ${SHA256[arch]}`) {
    console.log(`llama-server ${LLAMA_TAG} (${arch}) already in ${out}`);
    continue;
  }
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/llama-${LLAMA_TAG}-bin-macos-${arch}.tar.gz`;
  console.log(`llama-server ${LLAMA_TAG} (${arch}) ← ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== SHA256[arch]) throw new Error(`checksum mismatch for ${url}: got ${got}, pinned ${SHA256[arch]}`);
  // Unpacked in a fresh temp directory, then only llama-server and the .dylibs are copied out.
  const work = mkdtempSync(join(tmpdir(), "niti-llama-"));
  try {
    const tgz = join(work, "llama.tgz");
    writeFileSync(tgz, bytes);
    const x = Bun.spawnSync(["tar", "-xzf", tgz, "-C", work]);
    if (x.exitCode !== 0) throw new Error(`tar failed: ${x.stderr}`);
    const dir = join(work, `llama-${LLAMA_TAG}`);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    // llama-server and the libraries it links, followed through their own links: the release also
    // carries every other tool and its libraries, which niti never runs. Each library is copied
    // under the exact name it is linked by (a real file, never a symlink, so codesign and the app
    // packer have nothing to trip over).
    cpSync(join(dir, "llama-server"), join(out, "llama-server"));
    cpSync(join(dir, "LICENSE"), join(out, "LICENSE"));
    const queue = [join(dir, "llama-server")];
    const seen = new Set<string>();
    while (queue.length) {
      const bin = queue.pop()!;
      const deps = Bun.spawnSync(["otool", "-L", bin]).stdout.toString().matchAll(/@rpath\/([^\s]+)/g);
      for (const [, name] of deps) {
        if (seen.has(name!)) continue;
        seen.add(name!);
        const src = realpathSync(join(dir, name!));
        cpSync(src, join(out, name!));
        queue.push(src);
      }
    }
    writeFileSync(stamp, `${LLAMA_TAG} ${SHA256[arch]}\n`);
    const check = Bun.spawnSync([join(out, "llama-server"), "--version"]);
    if (arch === host && check.exitCode !== 0) throw new Error(`llama-server does not run: ${check.stderr}`);
    console.log(`  → ${out}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
