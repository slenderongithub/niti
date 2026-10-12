// Compile niti-core (the repo's src/cli.ts) into resources/<arch>/niti-core for electron-builder to
// ship inside the app (extraResources → Contents/Resources/niti-core, where main/core.ts looks first).
// Reads the engine; never modifies it.
//   bun scripts/bundle-core.ts            # this machine's arch
//   bun scripts/bundle-core.ts arm64 x64  # both macOS arches
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./fixture";

const host = process.arch === "arm64" ? "arm64" : "x64";
const arches = process.argv.slice(2).length ? process.argv.slice(2) : [host];
const os = process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : "darwin";

for (const arch of arches) {
  if (arch !== "arm64" && arch !== "x64") throw new Error(`unknown arch ${arch}`);
  const dir = join(import.meta.dir, "..", "resources", arch);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, os === "windows" ? "niti-core.exe" : "niti-core");
  console.log(`niti-core → ${out}`);
  const p = Bun.spawn(["bun", "build", "--compile", `--target=bun-${os}-${arch}`, "./src/cli.ts", "--outfile", out], { cwd: REPO, stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) process.exit(1);
}
