import { buildFileGraph, trackedFiles } from "../graph/filegraph.ts";

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
// ponytail: import edges only, no symbol extraction. Aider ranks tree-sitter symbol definitions,
// which is better and needs a parser per language; file-level ranking needs nothing and gets the
// directory structure and the hubs right, which is most of the value. Upgrade if the map is
// measurably not enough.

const DAMPING = 0.85;
const ITERATIONS = 12; // converges well before this on graphs of a few hundred nodes

// Below this a map is noise: the agent can read the whole tree in one list_dir and a map of five
// files tells it nothing it will not see immediately.
const MIN_FILES = 12;

export interface RepoMapOptions {
  maxFiles?: number; // how many ranked files to show
  maxChars?: number; // hard ceiling on the rendered map
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

// The rendered map: directories with their file counts, then the files that matter most. Grouping
// by directory first is deliberate — "where would a new route go" is answered by the shape of the
// tree, and "what is this project built around" by the ranking.
export function buildRepoMap(root: string, opts: RepoMapOptions = {}): string {
  const maxFiles = opts.maxFiles ?? 24;
  const maxChars = opts.maxChars ?? 2_000;

  let graph;
  try {
    graph = buildFileGraph(root, 600, trackedFiles(root));
  } catch {
    return ""; // an unreadable tree is not worth failing a run over — the agent still has its tools
  }
  const nodes = graph.nodes.map((n) => n.id);
  if (nodes.length < MIN_FILES) return "";

  const scores = rank(nodes, graph.edges);
  const importers = new Map<string, number>();
  for (const e of graph.edges) importers.set(e.to, (importers.get(e.to) ?? 0) + 1);

  const dirs = new Map<string, number>();
  for (const id of nodes) {
    const dir = id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : ".";
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
  }

  const top = [...nodes].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0)).slice(0, maxFiles);

  const lines: string[] = [];
  lines.push(`This project has ${nodes.length} source files. Directory layout:`);
  for (const [dir, count] of [...dirs].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    lines.push(`  ${dir}/  (${count} file${count === 1 ? "" : "s"})`);
  }
  lines.push("", "Most-depended-on files (ranked by how much of the project imports them):");
  for (const id of top) {
    const n = importers.get(id) ?? 0;
    lines.push(`  ${id}${n > 0 ? `  ← imported by ${n}` : ""}`);
  }
  lines.push("", "This is an outline, not a substitute for looking: use grep/glob to find anything it does not name.");

  const out = lines.join("\n");
  return out.length <= maxChars ? out : `${out.slice(0, maxChars)}\n  …(truncated)`;
}

// Wrapped for the system prompt. Empty when there is no map worth showing, so the caller can
// concatenate unconditionally.
export function repoMapSection(root: string, opts: RepoMapOptions = {}): string {
  const map = buildRepoMap(root, opts);
  return map ? `\n\n# Project map (generated, may be stale — verify before relying on it)\n\n${map}` : "";
}
