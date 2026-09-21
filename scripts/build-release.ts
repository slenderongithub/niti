// Builds the publishable artefacts: one npm package per platform, each carrying both binaries and
// the dashboard assets, plus nothing else. The root package is a Node shim (bin/) that resolves
// whichever of these npm installed — see bin/resolve.js.
//
//   bun run build:release            → all targets into npm/
//   bun run build:release darwin-arm64 linux-x64   → just those
//
// Cross-compiling works because neither binary links a platform-specific native module: the Go TUI
// is pure Go (CGO off), and the core's one native dependency (@napi-rs/keyring) is loaded lazily
// and degrades to the file/env credential path when its binding is missing (src/keystore).
import { rmSync, mkdirSync, cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TARGETS = [
  { platform: "darwin-arm64", goos: "darwin", goarch: "arm64", bun: "bun-darwin-arm64" },
  { platform: "darwin-x64", goos: "darwin", goarch: "amd64", bun: "bun-darwin-x64" },
  { platform: "linux-x64", goos: "linux", goarch: "amd64", bun: "bun-linux-x64" },
  { platform: "linux-arm64", goos: "linux", goarch: "arm64", bun: "bun-linux-arm64" },
  { platform: "win32-x64", goos: "windows", goarch: "amd64", bun: "bun-windows-x64" },
];

// The dashboard's runtime files. Explicit, not a directory copy, so the *.test.ts siblings in web/
// never end up in a published tarball (or served by GET /dashboard/*).
const WEB_FILES = ["index.html", "graph.html", "app.js", "graph.js", "style.css", "theme.js", "avatar.js", "favicon.png"];

const pkg = await Bun.file("package.json").json();
// Deliberately not pkg.name: pkg.name is the scoped root wrapper (`@slenderbuilds/niti`), but the
// platform packages are unscoped (`niti-darwin-arm64`, …), published before the scope existed —
// see bin/resolve.js's PLATFORM_BASE for the matching constant on the consuming side.
const PLATFORM_BASE = "niti";
const only = process.argv.slice(2);
const targets = only.length ? TARGETS.filter((t) => only.includes(t.platform)) : TARGETS;
if (!targets.length) {
  console.error(`no such target. known: ${TARGETS.map((t) => t.platform).join(", ")}`);
  process.exit(1);
}

const run = async (cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) => {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) {
    console.error(`\nfailed: ${cmd.join(" ")}`);
    process.exit(1);
  }
};

for (const t of targets) {
  const out = join("npm", t.platform);
  const ext = t.goos === "windows" ? ".exe" : "";
  console.log(`\n=== ${t.platform} ===`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "bin"), { recursive: true });
  mkdirSync(join(out, "web"), { recursive: true });

  await run(["go", "build", "-trimpath", "-ldflags=-s -w", "-o", join("..", out, "bin", `niti${ext}`), "./cmd/niti"], {
    cwd: "tui",
    env: { GOOS: t.goos, GOARCH: t.goarch, CGO_ENABLED: "0" },
  });
  await run(["bun", "build", "--compile", `--target=${t.bun}`, "./src/cli.ts", "--outfile", join(out, "bin", "niti-core")]);
  for (const f of WEB_FILES) cpSync(join("web", f), join(out, "web", f));

  writeFileSync(
    join(out, "package.json"),
    JSON.stringify(
      {
        name: `${PLATFORM_BASE}-${t.platform}`,
        version: pkg.version,
        description: `${PLATFORM_BASE} binaries for ${t.platform}`,
        license: pkg.license,
        repository: pkg.repository,
        // npm skips a package whose os/cpu don't match, which is what makes five
        // optionalDependencies install as one.
        os: [t.platform.split("-")[0]],
        cpu: [t.platform.split("-")[1]],
        files: ["bin/", "web/"],
        publishConfig: { access: "public" },
      },
      null,
      2,
    ) + "\n",
  );
}

console.log(
  `\nBuilt ${targets.length} package(s) in npm/.\n` +
    `Publish the platform packages first, then the root:\n` +
    // The leading ./ is load-bearing: `npm publish npm/linux-x64` is parsed as the GitHub
    // shorthand owner/repo, so npm tries to clone github.com/npm/linux-x64 instead of publishing
    // the directory. A path has to look like a path.
    targets.map((t) => `  npm publish ./npm/${t.platform}`).join("\n") +
    `\n  npm publish\n`,
);
