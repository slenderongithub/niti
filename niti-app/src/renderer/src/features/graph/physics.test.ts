import { expect, test } from "bun:test";
import { defaultParams, tick, type SimNode } from "./physics";

// Agent-sized nodes (r 22) all linked to each other: springs alone settle them closer than their diameters.
test("a settled layout has no overlapping nodes", () => {
  const nodes: SimNode[] = Array.from({ length: 10 }, (_, i) => ({ id: `${i}`, x: Math.cos(i) * 2, y: Math.sin(i) * 2, vx: 0, vy: 0, r: 22, pinned: false }));
  const links = nodes.flatMap((_, s) => nodes.slice(s + 1).map((_, j) => ({ s, t: s + j + 1 })));
  const sim = defaultParams();
  for (let i = 0; i < 3000 && tick(nodes, links, sim); i++);
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!, b = nodes[j]!;
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.r + b.r);
    }
});
