import type { HunkLine } from "./types";

// File changes as rows for the diff view, and the approval request's diff text as hunks.

export type Row = { kind: "+" | "-" | " " | "gap"; n?: number; text: string; hi?: [number, number] };

function markChange(a: string, b: string): [[number, number] | undefined, [number, number] | undefined] {
  const ra = [...a];
  const rb = [...b];
  let p = 0;
  while (p < ra.length && p < rb.length && ra[p] === rb[p]) p++;
  let s = 0;
  while (s < ra.length - p && s < rb.length - p && ra[ra.length - 1 - s] === rb[rb.length - 1 - s]) s++;
  const span = (r: string[]): [number, number] | undefined => {
    const mid = r.length - p - s;
    return mid <= 0 || mid === r.length ? undefined : [p, r.length - s];
  };
  return [span(ra), span(rb)];
}

export function toRows(hunks: { lines: HunkLine[] }[]): Row[] {
  const rows: Row[] = [];
  hunks.forEach((h, hi) => {
    if (hi > 0) rows.push({ kind: "gap", text: "" });
    const lines = h.lines;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (l.k === "-") {
        let j = i;
        while (j < lines.length && lines[j]!.k === "-") j++;
        let k = j;
        while (k < lines.length && lines[k]!.k === "+") k++;
        const dels = lines.slice(i, j);
        const adds = lines.slice(j, k);
        const paired = dels.length === adds.length;
        dels.forEach((d, x) => rows.push({ kind: "-", n: d.o, text: d.t, hi: paired ? markChange(d.t, adds[x]!.t)[0] : undefined }));
        adds.forEach((a, x) => rows.push({ kind: "+", n: a.n, text: a.t, hi: paired ? markChange(dels[x]!.t, a.t)[1] : undefined }));
        i = k - 1;
        continue;
      }
      rows.push({ kind: l.k, n: l.k === "+" ? l.n : (l.n ?? l.o), text: l.t });
    }
  });
  return rows;
}


// A unified diff string (the approval request's input.diff) → hunks, for DiffRows.
export function parseUnified(diff: string): { lines: HunkLine[] }[] {
  const hunks: { lines: HunkLine[] }[] = [];
  let cur: HunkLine[] | null = null;
  let o = 0;
  let n = 0;
  for (const raw of diff.split("\n")) {
    // The core's approval diffs say `@@ line N @@`; real unified diffs say `@@ -a,b +c,d @@`.
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw) ?? /^@@ line (\d+) @@/.exec(raw);
    if (h) {
      cur = [];
      hunks.push({ lines: cur });
      o = Number(h[1]);
      n = Number(h[2] ?? h[1]);
      continue;
    }
    if (raw.startsWith("---") || raw.startsWith("+++") || raw.startsWith("diff ") || raw.startsWith("index ")) continue;
    if (!cur) {
      cur = [];
      hunks.push({ lines: cur });
      o = 1;
      n = 1;
    }
    if (raw.startsWith("+")) cur.push({ k: "+", t: raw.slice(1), n: n++ });
    else if (raw.startsWith("-")) cur.push({ k: "-", t: raw.slice(1), o: o++ });
    else if (raw.startsWith("\\")) continue;
    else cur.push({ k: " ", t: raw.startsWith(" ") ? raw.slice(1) : raw, o: o++, n: n++ });
  }
  return hunks.filter((h) => h.lines.length);
}
