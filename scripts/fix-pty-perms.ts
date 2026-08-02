// node-pty's prebuilt spawn-helper binaries lose their executable bit during bun's package
// extraction (confirmed: node-pty@1.1.0's darwin-arm64/darwin-x64 prebuilds land as -rw-r--r--,
// which makes posix_spawnp fail at runtime with no other symptom) — restore it after every
// install. A no-op on platforms with no spawn-helper (e.g. win32, which uses conpty instead).
import { chmodSync } from "node:fs";
import { Glob } from "bun";

for (const f of new Glob("node_modules/node-pty/prebuilds/*/spawn-helper").scanSync(".")) {
  chmodSync(f, 0o755);
}
