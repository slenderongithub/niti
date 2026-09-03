import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// This package ships no binaries. The real executables live in per-platform packages
// (`niti-darwin-arm64`, …) declared as optionalDependencies with `os`/`cpu` set, so npm installs
// exactly the one that matches and skips the other four.
//
// PLATFORM_BASE is deliberately NOT derived from this package's own `name`: the root wrapper is
// published as a scoped package (`@slenderbuilds/niti`, npm's own suggestion — the unscoped `niti`
// collided with its squatting-prevention check against jiti/vite/nib/…), but the five platform
// packages are unscoped (`niti-darwin-arm64`, …) and were already published under that name before
// the scope existed. `${name}-${platform}` would have produced `@slenderbuilds/niti-darwin-arm64`,
// which is not a real package — see scripts/build-release.ts, which publishes under this same
// hardcoded base.
const PLATFORM_BASE = "niti";

export function binPath(exe) {
  const platformPkg = `${PLATFORM_BASE}-${process.platform}-${process.arch}`;
  const ext = process.platform === "win32" ? ".exe" : "";
  try {
    return require.resolve(`${platformPkg}/bin/${exe}${ext}`);
  } catch {
    console.error(
      `niti: no prebuilt binary for ${process.platform}-${process.arch} (looked for ${platformPkg}).\n` +
        `Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64.\n` +
        `If your platform is on that list, reinstall — npm sometimes skips optional dependencies ` +
        `(https://github.com/npm/cli/issues/4828).`,
    );
    process.exit(1);
  }
}
