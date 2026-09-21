import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildFileGraph, ignored, isGraphFile, trackedFiles } from "../graph/filegraph.ts";

// An agent dropped into an unfamiliar repository starts with no idea what is in it. Search tools
// answer "where is X" once it knows to ask for X — but the first turn of a real task is usually
// spent finding out what the project even is, and a weak model spends that turn guessing.
//
// The map is the cheap half of the fix: a ranked outline of the project, in the system prompt,
// before the first call. Ranking matters more than completeness — a repository has far more files
// than fit in a prompt, and the useful ones are not the alphabetically first. A file that many
// other files import is load-bearing; one that nothing imports is usually a leaf. That is the same
// observation PageRank encodes, and one iteration of it over the import graph is enough to sort
// the top twenty out of hundreds.
//
// ponytail: files are ranked on import edges alone, and each shown file lists its exported symbols
// from a regex, not a parser. Aider ranks tree-sitter definitions, which is better and needs a
// grammar per language; this gets the hubs right and lets an agent pick a file without opening it.
// Upgrade if the map is measurably not enough.

const DAMPING = 0.85;
const ITERATIONS = 12; // converges well before this on graphs of a few hundred nodes

// Below this a map is noise: the agent can read the whole tree in one list_dir and a map of five
// files tells it nothing it will not see immediately.
const MIN_FILES = 12;

export interface RepoMapOptions {
  maxFiles?: number; // how many ranked files to show
  maxChars?: number; // hard ceiling on the rendered map
  path?: string; // only show files under this project-relative directory (the repo_map tool's zoom)
}

// PageRank over "A imports B" edges, reversed: importance flows to the file being imported. An
// isolated file keeps the base score rather than dropping to zero, so a brand-new module that
// nothing imports yet still appears, just low.
function rank(nodes: string[], edges: { from: string; to: string }[]): Map<string, number> {
  const score = new Map(nodes.map((n) => [n, 1 / nodes.length]));
  const outDegree = new Map<string, number>();
  for (const e of edges) outDegree.set(e.from, (outDegree.get(e.from) ?? 0) + 1);

  for (let i = 0; i < ITERATIONS; i++) {
    const next = new Map(nodes.map((n) => [n, (1 - DAMPING) / nodes.length]));
    for (const e of edges) {
      const out = outDegree.get(e.from) ?? 0;
      if (out === 0) continue;
      next.set(e.to, (next.get(e.to) ?? 0) + (DAMPING * (score.get(e.from) ?? 0)) / out);
    }
    for (const [k, v] of next) score.set(k, v);
  }
  return score;
}

// Exported names of one file, for the "what does this file give me" half of the map. Regexes per
// language family: cheap, offline, and wrong only by omission (a re-export via `export *` is missed).
const MAX_SYMBOLS = 6;
export function exportedSymbols(file: string, text: string): string[] {
  const out = new Set<string>();
  const grab = (re: RegExp) => {
    for (const m of text.matchAll(re)) if (m[1]) out.add(m[1]);
  };
  if (file.endsWith(".py")) {
    grab(/^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)/gm);
  } else if (file.endsWith(".go")) {
    grab(/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm);
    grab(/^type\s+([A-Z]\w*)/gm);
  } else {
    grab(/^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm);
    for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
      for (const part of m[1]!.split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) out.add(name);
      }
    }
  }
  return [...out].slice(0, MAX_SYMBOLS);
}

interface Analysis {
  nodes: string[];
  scores: Map<string, number>;
  importers: Map<string, number>;
}

// Reading and resolving every file's imports is the expensive part, and it is identical from one
// call to the next until a file changes — so it is memoised per root on a fingerprint of the
// source files' paths, sizes and mtimes (stat is cheap next to reading 600 files). That is what
// makes the on-demand tool safe to call freely and lets a mid-run edit show up without a flag.
// No git file list = no cheap way to know what changed: recompute.
const cache = new Map<string, { fp: string; analysis: Analysis }>();

function fingerprint(files: string[], root: string): string {
  const parts: string[] = [];
  for (const f of files) {
    if (ignored(f) || !isGraphFile(f)) continue;
    try {
      const st = statSync(join(root, f));
      parts.push(`${f}:${st.size}:${st.mtimeMs}`);
    } catch {
      /* listed but gone — drops out of the fingerprint, which is the point */
    }
  }
  return parts.join("\n");
}

function analyze(root: string): Analysis | undefined {
  const files = trackedFiles(root, true);
  const fp = files ? fingerprint(files, root) : undefined;
  const hit = cache.get(root);
  if (fp !== undefined && hit?.fp === fp) return hit.analysis;

  let graph;
  try {
    graph = buildFileGraph(root, 600, files);
  } catch {
    return undefined; // an unreadable tree is not worth failing a run over — the agent still has its tools
  }
  const nodes = graph.nodes.map((n) => n.id);
  const importers = new Map<string, number>();
  for (const e of graph.edges) importers.set(e.to, (importers.get(e.to) ?? 0) + 1);
  const analysis = { nodes, scores: rank(nodes, graph.edges), importers };
  if (fp !== undefined) cache.set(root, { fp, analysis });
  return analysis;
}

// The rendered map: directories with their file counts, then the files that matter most, each with
// what it exports. Grouping by directory first is deliberate — "where would a new route go" is
// answered by the shape of the tree, and "what is this project built around" by the ranking.
export function buildRepoMap(root: string, opts: RepoMapOptions = {}): string {
  const maxFiles = opts.maxFiles ?? 24;
  const maxChars = opts.maxChars ?? 3_000;

  const a = analyze(root);
  if (!a || a.nodes.length < MIN_FILES) return "";
  const scope = opts.path?.replace(/^\.?\/+|\/+$/g, "") ?? "";
  const nodes = scope ? a.nodes.filter((id) => id === scope || id.startsWith(`${scope}/`)) : a.nodes;
  if (nodes.length === 0) return `No source files under '${scope}'.`;

  const dirs = new Map<string, number>();
  for (const id of nodes) {
    const dir = id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : ".";
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
  }

  const top = [...nodes].sort((x, y) => (a.scores.get(y) ?? 0) - (a.scores.get(x) ?? 0)).slice(0, maxFiles);

  const lines: string[] = [];
  lines.push(`${scope ? `Under ${scope}/: ` : "This project has "}${nodes.length} source files. Directory layout:`);
  for (const [dir, count] of [...dirs].sort((x, y) => y[1] - x[1]).slice(0, 20)) {
    lines.push(`  ${dir}/  (${count} file${count === 1 ? "" : "s"})`);
  }
  lines.push("", "Most-depended-on files (ranked by how much of the project imports them), with their exports:");
  for (const id of top) {
    const n = a.importers.get(id) ?? 0;
    let syms: string[] = [];
    try {
      syms = exportedSymbols(id, readFileSync(join(root, id), "utf8"));
    } catch {
      /* deleted since the analysis — list it without symbols */
    }
    lines.push(`  ${id}${n > 0 ? `  ← imported by ${n}` : ""}${syms.length ? `  { ${syms.join(", ")} }` : ""}`);
  }
  lines.push("", "This is an outline, not a substitute for looking: use grep/glob to find anything it does not name. Call repo_map to refresh it or zoom into a directory.");

  const out = lines.join("\n");
  return out.length <= maxChars ? out : `${out.slice(0, maxChars)}\n  …(truncated)`;
}

// Wrapped for the system prompt. Empty when there is no map worth showing, so the caller can
// concatenate unconditionally.
export function repoMapSection(root: string, opts: RepoMapOptions = {}): string {
  const map = buildRepoMap(root, opts);
  return map ? `\n\n# Project map (generated at session start, may be stale — call repo_map for a fresh one)\n\n${map}` : "";
}
