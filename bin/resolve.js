import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// This package ships no binaries. The real executables live in per-platform packages
// (`<name>-darwin-arm64`, …) declared as optionalDependencies with `os`/`cpu` set, so npm installs
// exactly the one that matches and skips the other four. The name is derived rather than hardcoded
// so renaming the package renames its platform packages with it — see scripts/build-release.ts,
// which publishes under the same convention.
export function binPath(exe) {
  const { name } = require("../package.json");
  const platformPkg = `${name}-${process.platform}-${process.arch}`;
  const ext = process.platform === "win32" ? ".exe" : "";
  try {
    return require.resolve(`${platformPkg}/bin/${exe}${ext}`);
  } catch {
    console.error(
      `amux: no prebuilt binary for ${process.platform}-${process.arch} (looked for ${platformPkg}).\n` +
        `Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64.\n` +
        `If your platform is on that list, reinstall — npm sometimes skips optional dependencies ` +
        `(https://github.com/npm/cli/issues/4828).`,
    );
    process.exit(1);
  }
}
