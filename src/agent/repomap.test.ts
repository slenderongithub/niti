import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildRepoMap, exportedSymbols, repoMapSection } from "./repomap.ts";

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "niti-map-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

// A hub everything imports, plus enough leaves to clear the "too small to bother" threshold.
function hubAndSpokes(): Record<string, string> {
  const files: Record<string, string> = {
    "src/core.ts": "export const core = 1;\n",
    "src/util.ts": "import { core } from './core.ts';\nexport const util = core;\n",
  };
  for (let i = 0; i < 14; i++) {
    files[`src/leaf${i}.ts`] = "import { core } from './core.ts';\nexport const x = core;\n";
  }
  return files;
}

test("ranks the file the project depends on above the files that depend on it", () => {
  const map = buildRepoMap(fixture(hubAndSpokes()));
  const hub = map.indexOf("src/core.ts");
  const leaf = map.indexOf("src/leaf3.ts");
  expect(hub).toBeGreaterThan(-1);
  // Both listed, but the hub comes first — that ordering is the entire point of ranking.
  expect(leaf === -1 || hub < leaf).toBe(true);
  expect(map).toContain("imported by 15");
});

test("a project too small to need a map gets none, rather than a map of nothing", () => {
  const map = buildRepoMap(fixture({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 2;\n" }));
  expect(map).toBe("");
  expect(repoMapSection(fixture({ "a.ts": "export const a = 1;\n" }))).toBe("");
});

test("the map stays inside its character budget", () => {
  const map = buildRepoMap(fixture(hubAndSpokes()), { maxChars: 200 });
  expect(map.length).toBeLessThanOrEqual(220); // budget + the truncation marker
  expect(map).toContain("truncated");
});

test("the section is labelled as generated and possibly stale", () => {
  const section = repoMapSection(fixture(hubAndSpokes()));
  expect(section).toContain("# Project map");
  expect(section).toContain("stale");
});

test("shows each file's exports so an agent can pick a file without opening it", () => {
  const files = hubAndSpokes();
  files["src/core.ts"] = "export const core = 1;\nexport async function boot() {}\nexport interface Cfg {}\nexport { a as renamed };\n";
  const map = buildRepoMap(fixture(files));
  expect(map).toContain("{ core, boot, Cfg, renamed }");
  expect(exportedSymbols("m.py", "def run():\n  pass\nclass Job:\n  pass\n")).toEqual(["run", "Job"]);
  expect(exportedSymbols("m.go", "func Serve() {}\nfunc (s *S) Stop() {}\nfunc private() {}\ntype Conf struct{}\n")).toEqual(["Serve", "Stop", "Conf"]);
});

test("path zooms into one directory", () => {
  const files = hubAndSpokes();
  for (let i = 0; i < 3; i++) files[`lib/thing${i}.ts`] = "export const t = 1;\n";
  const map = buildRepoMap(fixture(files), { path: "lib" });
  expect(map).toContain("Under lib/: 3 source files");
  expect(map).not.toContain("src/core.ts");
  expect(buildRepoMap(fixture(files), { path: "nope" })).toContain("No source files under 'nope'");
});

test("in a git repo, gitignored files stay out and new files appear on the next call", () => {
  const files = hubAndSpokes();
  files["dist/bundle.ts"] = "export const built = 1;\n";
  files["gen/out.ts"] = "export const generated = 1;\n";
  files[".gitignore"] = "gen/\n";
  const root = fixture(files);
  spawnSync("git", ["-C", root, "init", "-q"]);
  expect(buildRepoMap(root)).not.toContain("gen/out.ts");
  expect(buildRepoMap(root)).not.toContain("dist/bundle.ts");

  writeFileSync(join(root, "src/fresh.ts"), "export const fresh = 1;\n");
  expect(buildRepoMap(root, { maxFiles: 100 })).toContain("src/fresh.ts");
});
