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

test("a nested go.mod resolves Go imports instead of leaving every file an island", () => {
  // The walk collected only source files, so tui/go.mod was never seen and findGoModule could not
  // map an import path to a directory — the whole Go TUI rendered as disconnected nodes.
  const root = mkdtempSync(join(tmpdir(), "niti-graph-go-"));
  mkdirSync(join(root, "tui", "internal", "api"), { recursive: true });
  mkdirSync(join(root, "tui", "cmd", "niti"), { recursive: true });
  writeFileSync(join(root, "tui", "go.mod"), "module github.com/example/tui\n\ngo 1.22\n");
  writeFileSync(join(root, "tui", "internal", "api", "client.go"), "package api\n");
  writeFileSync(
    join(root, "tui", "cmd", "niti", "main.go"),
    'package main\n\nimport "github.com/example/tui/internal/api"\n',
  );

  const g = buildFileGraph(root);
  expect(g.nodes.some((n) => n.id.endsWith("go.mod"))).toBe(false); // walked, but not a node
  expect(g.edges).toContainEqual({ from: "tui/cmd/niti/main.go", to: "tui/internal/api/client.go" });
});

test("a caller-supplied file list is held to the same boundary as the walk", () => {
  // niti's sibling products (ide/, desktop/) and the archived v1 TUI (old-tech/) live in this tree
  // but are not the CLI. A supplied list used to bypass IGNORE entirely, so they were handed to
  // CLI agents as part of the project — and a checked-out editor outnumbers src/ many times over.
  const supplied = [
    "src/a.ts",
    "ide/extensions/x.ts",
    "desktop/main.ts",
    "old-tech/ink-tui/theme.ts",
    "node_modules/pkg/index.js",
  ];
  const dir = scaffold({ "src/a.ts": "export const a = 1;" });
  const g = buildFileGraph(dir, 400, supplied);
  const ids = g.nodes.map((n) => n.id);
  expect(ids).not.toContain("ide/extensions/x.ts");
  expect(ids).not.toContain("desktop/main.ts");
  expect(ids).not.toContain("old-tech/ink-tui/theme.ts");
  expect(ids).not.toContain("node_modules/pkg/index.js");
});
