import type { Task } from "./types";

export const COL_W = 250;
const COL_GAP = 70;
const ROW_H = 132;
const ROW_GAP = 16;
const PAD = 24;

// Columns by dependency depth (longest path from a task with no prerequisites). Cycles or unknown
// ids — a malformed plan — fall back to depth 0 rather than looping.
export function layoutDag(tasks: Task[]): { pos: Map<string, { x: number; y: number; depth: number }>; width: number; height: number } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const d = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const t = byId.get(id);
    const deps = (t?.dependsOn ?? []).filter((x) => byId.has(x));
    const v = deps.length ? Math.max(...deps.map(d)) + 1 : 0;
    visiting.delete(id);
    depth.set(id, v);
    return v;
  };
  tasks.forEach((t) => d(t.id));
  const cols: string[][] = [];
  for (const t of tasks) (cols[depth.get(t.id)!] ??= []).push(t.id);
  const pos = new Map<string, { x: number; y: number; depth: number }>();
  let maxRows = 0;
  cols.forEach((ids, c) => {
    maxRows = Math.max(maxRows, ids.length);
    ids.forEach((id, r) => pos.set(id, { x: PAD + c * (COL_W + COL_GAP), y: PAD + r * (ROW_H + ROW_GAP), depth: c }));
  });
  return { pos, width: PAD * 2 + cols.length * COL_W + Math.max(0, cols.length - 1) * COL_GAP, height: PAD * 2 + maxRows * ROW_H + Math.max(0, maxRows - 1) * ROW_GAP };
}

