import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, extname, basename } from "node:path";

// The project's file-dependency graph: nodes are source files, edges are intra-project imports.
// Built by scanning import statements — no build system, no AST, just the specifiers, resolved back
// to files that actually exist in the tree. Good enough to draw, and it never needs the project to
// compile. Powers GET /graph and the TUI's project graph view.

export interface FileGraph {
  nodes: { id: string; label: string; group: string }[];
  edges: { from: string; to: string }[];
}

const SRC_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go"]);
const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".amux", "vendor", ".next", "out", "target", "coverage", "old-tech"]);

export function buildFileGraph(root: string, maxFiles = 400): FileGraph {
  const files: string[] = [];
  walk(root, "", files, maxFiles);
  const set = new Set(files);
  const goModule = findGoModule(root, files);

  const edges: { from: string; to: string }[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    let text = "";
    try {
      text = readFileSync(join(root, f), "utf8");
    } catch {
      continue;
    }
    for (const target of resolveAll(f, text, set, goModule)) {
      const key = `${f}\0${target}`;
      if (target !== f && !seen.has(key)) {
        seen.add(key);
        edges.push({ from: f, to: target });
      }
    }
  }
  const nodes = files.map((f) => ({ id: f, label: basename(f), group: f.split("/")[0] ?? "" }));
  return { nodes, edges };
}

function walk(root: string, rel: string, out: string[], max: number): void {
  if (out.length >= max) return;
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= max) return;
    if (e.name.startsWith(".") && e.name !== ".") continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!IGNORE.has(e.name)) walk(root, child, out, max);
    } else if (SRC_EXT.has(extname(e.name)) && !e.name.endsWith(".d.ts")) {
      out.push(child);
    }
  }
}

// resolveAll extracts every import specifier from one file and resolves each to a project file id.
function resolveAll(from: string, text: string, set: Set<string>, goModule: GoModule | undefined): string[] {
  const ext = extname(from);
  const out: string[] = [];
  const add = (id: string | undefined) => {
    if (id) out.push(id);
  };
  if (ext === ".py") {
    for (const m of text.matchAll(/^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm)) {
      add(resolvePy(from, m[1] ?? m[2] ?? "", set));
    }
    return out;
  }
  if (ext === ".go") {
    for (const spec of goImports(text)) add(resolveGo(spec, set, goModule));
    return out;
  }
  // JS/TS family: static imports, re-exports, dynamic import(), and require().
  const re = /(?:import|export)\s+(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(re)) add(resolveJs(from, m[1] ?? m[2] ?? "", set));
  return out;
}

const JS_EXT = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

// resolveJs resolves a relative specifier against the importing file, trying the usual extension
// and index-file fallbacks. Bare specifiers (npm packages) are external → dropped.
function resolveJs(from: string, spec: string, set: Set<string>): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = normalizeRel(join(dirname(from), spec));
  const candidates = [
    ...JS_EXT.map((e) => base + e),
    ...JS_EXT.filter(Boolean).map((e) => `${base}/index${e}`),
  ];
  return candidates.find((c) => set.has(c));
}

function resolvePy(from: string, spec: string, set: Set<string>): string | undefined {
  let rel: string;
  if (spec.startsWith(".")) {
    // Leading dots climb from the current package; the rest is a dotted path.
    const up = spec.match(/^\.+/)![0].length;
    const parts = dirname(from).split("/");
    const tail = spec.slice(up).replace(/\./g, "/");
    rel = normalizeRel([...parts.slice(0, parts.length - (up - 1)), tail].filter(Boolean).join("/"));
  } else {
    rel = spec.replace(/\./g, "/");
  }
  return [`${rel}.py`, `${rel}/__init__.py`].find((c) => set.has(c));
}

interface GoModule {
  path: string; // module path from go.mod
  dir: string; // repo-relative dir containing go.mod
}

function goImports(text: string): string[] {
  const out: string[] = [];
  const block = text.match(/import\s*\(([\s\S]*?)\)/);
  if (block) {
    for (const m of block[1]!.matchAll(/"([^"]+)"/g)) out.push(m[1]!);
  }
  for (const m of text.matchAll(/^\s*import\s+"([^"]+)"/gm)) out.push(m[1]!);
  return out;
}

// resolveGo maps a local package import to the first file in that package's directory. Go imports a
// package (a directory), not a file, so any file there stands in as the edge target.
function resolveGo(spec: string, set: Set<string>, mod: GoModule | undefined): string | undefined {
  if (!mod || !spec.startsWith(mod.path)) return undefined;
  const sub = spec.slice(mod.path.length).replace(/^\//, "");
  const dir = normalizeRel([mod.dir, sub].filter(Boolean).join("/"));
  for (const id of set) {
    if (id.endsWith(".go") && dirname(id) === dir) return id;
  }
  return undefined;
}

function findGoModule(root: string, files: string[]): GoModule | undefined {
  const gomod = files.find((f) => basename(f) === "go.mod");
  if (!gomod && !existsSync(join(root, "go.mod"))) return undefined;
  const rel = gomod ?? "go.mod";
  try {
    const m = readFileSync(join(root, rel), "utf8").match(/^module\s+(\S+)/m);
    if (m) return { path: m[1]!, dir: dirname(rel) === "." ? "" : dirname(rel) };
  } catch {
    /* no module line — treat as no Go module */
  }
  return undefined;
}

// normalizeRel resolves ./ and ../ segments in a repo-relative path (join keeps them on POSIX-ish
// inputs). Kept small and dependency-free rather than reaching for path.resolve, which would anchor
// to an absolute cwd we don't want here.
function normalizeRel(p: string): string {
  const stack: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return stack.join("/");
}
