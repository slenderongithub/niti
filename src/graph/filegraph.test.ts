import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFileGraph } from "./filegraph.ts";

function scaffold(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "fg-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

test("resolves relative TS imports, index files, and re-exports; drops npm packages", () => {
  const root = scaffold({
    "src/main.ts": `import { run } from "./engine.ts";\nimport { z } from "zod";\nimport { util } from "./lib";`,
    "src/engine.ts": `export * from "./store/session.ts";`,
    "src/lib/index.ts": `export const util = 1;`,
    "src/store/session.ts": `export const s = 1;`,
  });
  const g = buildFileGraph(root);
  const ids = new Set(g.nodes.map((n) => n.id));
  expect(ids).toEqual(new Set(["src/main.ts", "src/engine.ts", "src/lib/index.ts", "src/store/session.ts"]));

  const edge = (from: string, to: string) => g.edges.some((e) => e.from === from && e.to === to);
  expect(edge("src/main.ts", "src/engine.ts")).toBe(true); // ./engine.ts
  expect(edge("src/main.ts", "src/lib/index.ts")).toBe(true); // ./lib → index.ts
  expect(edge("src/engine.ts", "src/store/session.ts")).toBe(true); // re-export
  // "zod" is external → no node, no edge.
  expect([...ids].some((id) => id.includes("zod"))).toBe(false);
  // group is the top-level dir, for colouring.
  expect(g.nodes.find((n) => n.id === "src/main.ts")?.group).toBe("src");
});

test("resolves Go package imports via go.mod to a file in that package dir", () => {
  const root = scaffold({
    "go.mod": `module github.com/x/app\n\ngo 1.22\n`,
    "cmd/main.go": `package main\nimport (\n\t"github.com/x/app/internal/run"\n\t"fmt"\n)`,
    "internal/run/run.go": `package run`,
  });
  const g = buildFileGraph(root);
  expect(g.edges.some((e) => e.from === "cmd/main.go" && e.to === "internal/run/run.go")).toBe(true);
  // stdlib "fmt" is not a local package → no edge for it.
  expect(g.edges.length).toBe(1);
});
