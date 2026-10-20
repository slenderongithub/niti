#!/usr/bin/env bun
// One command for a release's version: bun run bump 0.3.4
//
// The version lives in three places that must agree — package.json's own `version`, the pins on the
// platform packages in its optionalDependencies, and the Go constant the TUI displays. Bumping them
// by hand is how the TUI showed 0.2.0 through two releases and how a root package can pin platform
// packages that were never published. (npm/*/package.json is generated from `version` by
// build-release.ts, so it is not a fourth place; bun.lock is refreshed below.) The release workflow
// re-checks all three.
import { readFileSync, writeFileSync } from "node:fs";
import { classify } from "./changelog.ts";

const next = process.argv[2];
if (!next || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(next)) {
  console.error("usage: bun run bump <x.y.z>");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.version = next;
for (const dep of Object.keys(pkg.optionalDependencies ?? {})) pkg.optionalDependencies[dep] = next;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

const goFile = "tui/internal/ui/list.go";
const go = readFileSync(goFile, "utf8");
const bumped = go.replace(/const Version = "[^"]*"/, `const Version = "${next}"`);
if (bumped === go && !go.includes(`const Version = "${next}"`)) throw new Error(`no Version constant found in ${goFile}`);
writeFileSync(goFile, bumped);

// The lockfile records the platform pins too. Left stale, `bun install --frozen-lockfile` fails in
// CI on the very next push — which is what kept CI red after the 0.3.3 bump.
if (Bun.spawnSync(["bun", "install"], { stdout: "inherit", stderr: "inherit" }).exitCode !== 0) {
  throw new Error("bun install failed — bun.lock was not refreshed");
}

// What's new: the TUI tells a user who updated what this release carries (tui/internal/whatsnew).
// Drafted from the CLI's commits since the last v* tag, sorted by their wording — edit the entry
// before committing; it's what users read.
const logFile = "tui/internal/whatsnew/changelog.json";
const releases: { version: string; features: string[]; fixes: string[]; other: string[] }[] = JSON.parse(readFileSync(logFile, "utf8"));
if (!releases.some((r) => r.version === next)) {
  const last = Bun.spawnSync(["git", "describe", "--tags", "--abbrev=0", "--match", "v*"]).stdout.toString().trim();
  const range = last ? [`${last}..HEAD`] : [];
  const subjects = Bun.spawnSync(["git", "log", "--no-merges", "--format=%s", ...range, "--", "src", "tui", "web", "bin", "scripts", "package.json"])
    .stdout.toString().split("\n").map((l) => l.trim()).filter((l) => l && !/^Bump version/i.test(l));
  releases.unshift({ version: next, ...classify(subjects) });
  writeFileSync(logFile, JSON.stringify(releases, null, 2) + "\n");
  console.log(`${logFile}: drafted ${next} from ${subjects.length} commits — edit it before committing`);
}

console.log(`version → ${next} (package.json, its optionalDependencies, ${goFile}, bun.lock)`);
