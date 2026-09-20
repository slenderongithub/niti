import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildRepoMap, repoMapSection } from "./repomap.ts";

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
