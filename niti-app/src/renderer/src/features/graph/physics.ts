// The force layout behind /graph, ported from web/graph.js: Barnes–Hut repulsion (O(n log n)),
// Fruchterman–Reingold forces driving *damped velocity*, normalised gravity, and a hard freeze once
// the layout is actually still. Pure — no DOM — so it's testable on its own.

export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  pinned: boolean;
}

export interface SimLink {
  s: number;
  t: number;
}

export interface SimParams {
  link: number;
  charge: number;
  gravity: number;
  alpha: number;
  alphaDecay: number;
  alphaMin: number;
  velocityDecay: number;
  dragAlpha: number;
}

// Same values as web/graph.js `sim` — the two products run one physics. Keep them in step.
export const defaultParams = (): SimParams => ({ link: 42, charge: 30, gravity: 6, alpha: 1, alphaDecay: 0.021, alphaMin: 0.0006, velocityDecay: 0.72, dragAlpha: 0.15 });

interface Cell {
  x: number;
  y: number;
  s: number;
  mass: number;
  cx: number;
  cy: number;
  body: SimNode | null;
  kids: Cell[] | null;
}

const cell = (x: number, y: number, s: number): Cell => ({ x, y, s, mass: 0, cx: 0, cy: 0, body: null, kids: null });

export function buildTree(ns: SimNode[]): Cell | null {
  if (!ns.length) return null;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const n of ns) {
    x0 = Math.min(x0, n.x);
    y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x);
    y1 = Math.max(y1, n.y);
  }
  const root = cell(x0, y0, Math.max(x1 - x0, y1 - y0) + 1);
  for (const n of ns) insert(root, n, 0);
  return root;
}

// The depth/size guard stops coincident nodes subdividing forever: past it, mass accumulates at
// the leaf and Barnes–Hut treats the cluster as one body.
function insert(node: Cell, p: SimNode, depth: number) {
  node.mass++;
  node.cx += (p.x - node.cx) / node.mass;
  node.cy += (p.y - node.cy) / node.mass;
  if (node.s < 1e-3 || depth > 48) return;
  if (!node.kids && !node.body) {
    node.body = p;
    return;
  }
  if (!node.kids) {
    const h = node.s / 2;
    node.kids = [cell(node.x, node.y, h), cell(node.x + h, node.y, h), cell(node.x, node.y + h, h), cell(node.x + h, node.y + h, h)];
    const b = node.body!;
    node.body = null;
    place(node, b, depth);
  }
  place(node, p, depth);
}

function place(node: Cell, p: SimNode, depth: number) {
  const h = node.s / 2;
  const i = (p.x >= node.x + h ? 1 : 0) + (p.y >= node.y + h ? 2 : 0);
  insert(node.kids![i]!, p, depth + 1);
}

function repulse(tree: Cell | null, p: SimNode, k2: number, theta: number, out: { x: number; y: number }) {
  if (!tree || tree.mass === 0 || tree.body === p) return;
  let dx = p.x - tree.cx;
  let dy = p.y - tree.cy;
  let d2 = dx * dx + dy * dy;
  if (d2 < 1e-6) {
    dx = (Math.random() - 0.5) * 0.1;
    dy = (Math.random() - 0.5) * 0.1;
    d2 = dx * dx + dy * dy;
  }
  if (!tree.kids || tree.s * tree.s < theta * theta * d2) {
    const f = (k2 * tree.mass) / d2;
    out.x += dx * f;
    out.y += dy * f;
  } else {
    for (const c of tree.kids) repulse(c, p, k2, theta, out);
  }
}

// Hard collision: overlapping circles (plus room for a label) are pushed apart by position, not
// force, so they separate even late in the cooldown when alpha has decayed. The tree is queried only
// for cells whose box can reach p, keeping it O(n log n).
const PAD = 10;
function collide(tree: Cell | null, p: SimNode, reach: number) {
  if (!tree || tree.mass === 0) return;
  if (p.x + reach < tree.x || p.x - reach > tree.x + tree.s || p.y + reach < tree.y || p.y - reach > tree.y + tree.s) return;
  if (tree.kids) {
    for (const c of tree.kids) collide(c, p, reach);
    return;
  }
  const q = tree.body;
  if (!q || q === p) return;
  const min = p.r + q.r + PAD;
  let dx = p.x - q.x;
  let dy = p.y - q.y;
  let d = Math.hypot(dx, dy);
  if (d >= min) return;
  if (d < 1e-6) {
    dx = Math.random() - 0.5;
    dy = Math.random() - 0.5;
    d = Math.hypot(dx, dy);
  }
  const push = (min - d) / d;
  const pf = p.pinned ? 0 : q.pinned ? 1 : 0.5;
  const qf = q.pinned ? 0 : p.pinned ? 1 : 0.5;
  p.x += dx * push * pf;
  p.y += dy * push * pf;
  q.x -= dx * push * qf;
  q.y -= dy * push * qf;
}

let disp = new Float64Array(0);
const acc = { x: 0, y: 0 };

function freeze(nodes: SimNode[], sim: SimParams) {
  sim.alpha = 0;
  for (const p of nodes) {
    p.vx = 0;
    p.vy = 0;
  }
}

// One 60Hz step. Returns false when the layout is frozen (nothing moved).
export function tick(nodes: SimNode[], links: SimLink[], sim: SimParams, dragging = -1): boolean {
  const n = nodes.length;
  if (n === 0) return false;
  if (dragging >= 0) sim.alpha = Math.max(sim.alpha, sim.dragAlpha);
  if (sim.alpha < sim.alphaMin) {
    if (sim.alpha > 0) freeze(nodes, sim);
    return false;
  }
  sim.alpha *= 1 - sim.alphaDecay;
  const a = sim.alpha;
  const k = sim.link;
  const krep = k * k * (sim.charge / 30);
  const tree = buildTree(nodes);
  if (disp.length < n * 2) disp = new Float64Array(n * 2 + 128);
  for (let i = 0; i < n; i++) {
    acc.x = 0;
    acc.y = 0;
    repulse(tree, nodes[i]!, krep, 0.9, acc);
    disp[i * 2] = acc.x;
    disp[i * 2 + 1] = acc.y;
  }
  for (const l of links) {
    const s = nodes[l.s]!;
    const t = nodes[l.t]!;
    const ex = t.x - s.x;
    const ey = t.y - s.y;
    const d = Math.hypot(ex, ey) || 1;
    const fa = (d * 0.9) / k;
    disp[l.s * 2]! += ex * fa;
    disp[l.s * 2 + 1]! += ey * fa;
    disp[l.t * 2]! -= ex * fa;
    disp[l.t * 2 + 1]! -= ey * fa;
  }
  let cx = 0,
    cy = 0;
  for (const p of nodes) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;
  const spread = Math.max(160, Math.sqrt(n) * 46);
  const grav = ((sim.gravity / 6) * krep * n) / (spread * spread);
  const cap = k * 0.5;
  const vd = sim.velocityDecay;
  let vmax = 0;
  for (let i = 0; i < n; i++) {
    const p = nodes[i]!;
    if (i === dragging || p.pinned) {
      p.vx = 0;
      p.vy = 0;
      continue;
    }
    let gx = disp[i * 2]! + (cx - p.x) * grav;
    let gy = disp[i * 2 + 1]! + (cy - p.y) * grav;
    const dl = Math.hypot(gx, gy);
    if (dl > cap) {
      const sc = cap / dl;
      gx *= sc;
      gy *= sc;
    }
    p.vx = (p.vx + gx * a) * vd;
    p.vy = (p.vy + gy * a) * vd;
    p.x += p.vx;
    p.y += p.vy;
    const sp = p.vx * p.vx + p.vy * p.vy;
    if (sp > vmax) vmax = sp;
  }
  let rmax = 0;
  for (const p of nodes) if (p.r > rmax) rmax = p.r;
  const after = buildTree(nodes);
  for (const p of nodes) collide(after, p, p.r + rmax + PAD);
  if (dragging < 0 && vmax < 0.0025) freeze(nodes, sim);
  return true;
}

// Golden-angle spiral seeding (graph.js setGraph): new nodes spread evenly, not piled at the origin.
export function seedPosition(i: number, total: number): { x: number; y: number } {
  const spread = Math.max(120, Math.sqrt(total) * 46);
  const a = i * 2.399963;
  const R = (spread * Math.sqrt(i + 1)) / Math.sqrt(total + 1);
  return { x: Math.cos(a) * R, y: Math.sin(a) * R };
}

export function ringPosition(i: number, total: number): { x: number; y: number } {
  const r = total > 1 ? 70 + total * 22 : 0;
  const a = (i / total) * Math.PI * 2 - Math.PI / 2;
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}
