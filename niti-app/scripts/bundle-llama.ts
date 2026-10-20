// Fetch llama-server for the app: the same pinned, checksum-verified release the npm packages carry
// (../../scripts/llama.ts), into resources/<arch>/llama/, which electron-builder ships as
// Contents/Resources/llama — beside niti-core, where it looks.
//   bun scripts/bundle-llama.ts            # this machine's arch
//   bun scripts/bundle-llama.ts arm64 x64  # both macOS arches
import { join } from "node:path";
import { fetchLlamaServer } from "../../scripts/llama.ts";

const host = process.arch === "arm64" ? "arm64" : "x64";
const arches = process.argv.slice(2).length ? process.argv.slice(2) : [host];
for (const arch of arches) {
  if (arch !== "arm64" && arch !== "x64") throw new Error(`unknown arch ${arch}`);
  await fetchLlamaServer(arch, join(import.meta.dir, "..", "resources", arch, "llama"));
}
