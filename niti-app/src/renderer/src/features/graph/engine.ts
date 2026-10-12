import { AVATAR_BLINK, AVATAR_OPEN, avatarIndex, isBlinking } from "@/lib/avatars";
import { defaultParams, ringPosition, seedPosition, tick, type SimLink, type SimNode, type SimParams } from "./physics";

// The /graph canvas, ported from web/graph.js: physics on a fixed 60Hz step, an eased camera
// (zoom-to-cursor, pan with flick-glide, fit), hover/search highlighting that fades, batched edge
// strokes, collision-aware labels, a clickable minimap — and no redraws once a graph has settled.

export type GraphMode = "project" | "agents";

export interface GNode extends SimNode {
  label: string;
  group: string;
  color: string;
  deg: number;
  hl: number;
  // agents mode
  slot?: number;
  status?: string;
  lead?: boolean;
}

export interface GraphTheme {
  ink: string;
  muted: string;
  accent: string;
  bg: string;
  line: string;
  info: string;
  success: string;
  destructive: string;
  groups: string[];
  avatarInk: string;
}

export interface HoverInfo {
  node: GNode;
  x: number;
  y: number;
  neighbours: string[];
}

interface Callbacks {
  onHover?(h: HoverInfo | null): void;
  onSelect?(id: string | null): void;
  onStats?(nodes: number, links: number): void;
}

function rgb(color: string): string {
  // Accepts #rgb/#rrggbb (what the theme tokens are); anything else falls back to mid grey.
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return "128,128,128";
  let h = m[1]!;
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return `${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)}`;
}

const STEP = 1000 / 60;

// Avatar images for agents mode, decoded once and shared by every graph.
const avatarImages: { open: HTMLImageElement; blink: HTMLImageElement | null }[] = [];
function avatarImage(slot: number, blinking: boolean): HTMLImageElement | null {
  if (!avatarImages.length) {
    for (let i = 0; i < 6; i++) {
      const open = new Image();
      open.src = AVATAR_OPEN[i]!;
      let blink: HTMLImageElement | null = null;
      if (AVATAR_BLINK[i]) {
        blink = new Image();
        blink.src = AVATAR_BLINK[i]!;
      }
      avatarImages.push({ open, blink });
    }
  }
  const a = avatarImages[avatarIndex(slot)]!;
  const img = blinking && a.blink?.complete ? a.blink : a.open;
  return img.complete && img.naturalWidth ? img : null;
}
const ease = (dt: number, tau: number) => 1 - Math.exp(-dt / tau);

export class GraphEngine {
  mode: GraphMode = "project";
  nodes: GNode[] = [];
  links: SimLink[] = [];
  sim: SimParams = defaultParams();
  showLabels = true;
  insets = { top: 70, right: 20, bottom: 20, left: 20 };

  private ctx: CanvasRenderingContext2D;
  private W = 0;
  private H = 0;
  private DPR = 1;
  private theme!: GraphTheme;
  private byId = new Map<string, number>();
  private adj: Set<number>[] = [];
  private labelOrder: number[] = [];
  private pulses: { a: string; b: string; color: string; born: number }[] = [];
  private hover = -1;
  private selected = -1;
  private dragging = -1;
  private searchHits = new Set<number>();
  private searchTerm = "";
  private cam = { cx: 0, cy: 0, k: 1, tcx: 0, tcy: 0, tk: 1 };
  private autoFit = false;
  private glide: { x: number; y: number } | null = null;
  private overMini = false;
  private lastT = 0;
  private physAcc = 0;
  private dimAmt = 0;
  private lastFocus = -1;
  private fading = false;
  private lastKey = "";
  private raf = 0;
  private dead = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private panLast: { x: number; y: number } | null = null;
  private pinchDist = 0;
  private miniDrag = false;
  private grab = { x: 0, y: 0 };
  private panV = { x: 0, y: 0 };
  private panT = 0;
  private dirty = true;
  private frameNo = 0;
  private lastBlink = "";

  constructor(
    private canvas: HTMLCanvasElement,
    private cb: Callbacks = {},
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.bind();
    this.raf = requestAnimationFrame(this.draw);
  }

  destroy() {
    this.dead = true;
    cancelAnimationFrame(this.raf);
    this.unbind();
  }

  setTheme(t: GraphTheme) {
    this.theme = t;
    this.recolor();
    this.dirty = true;
  }

  resize(w: number, h: number) {
    this.DPR = Math.min(window.devicePixelRatio || 1, 2);
    this.W = w;
    this.H = h;
    this.canvas.width = Math.floor(w * this.DPR);
    this.canvas.height = Math.floor(h * this.DPR);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.dirty = true;
  }

  // Rebuild nodes/links, keeping the positions of nodes that already existed.
  setGraph(raw: { id: string; label: string; group: string; slot?: number; status?: string; lead?: boolean; color?: string }[], edges: { from: string; to: string }[]) {
    const before = this.nodes;
    const prevLinks = this.links.length;
    const prev = new Map(this.nodes.map((n) => [n.id, n]));
    this.nodes = raw.map((n, i) => {
      const old = prev.get(n.id);
      const p = this.mode === "agents" && !old?.pinned ? ringPosition(i, raw.length) : old ? { x: old.x, y: old.y } : seedPosition(i, raw.length);
      return { ...n, color: n.color ?? "", x: p.x, y: p.y, vx: 0, vy: 0, pinned: old?.pinned ?? false, hl: old?.hl ?? 1, deg: 0, r: 4 };
    });
    this.byId.clear();
    this.nodes.forEach((n, i) => this.byId.set(n.id, i));
    this.links = [];
    for (const e of edges) {
      const s = this.byId.get(e.from);
      const t = this.byId.get(e.to);
      if (s !== undefined && t !== undefined && s !== t) this.links.push({ s, t });
    }
    this.adj = this.nodes.map(() => new Set<number>());
    for (const l of this.links) {
      this.adj[l.s]!.add(l.t);
      this.adj[l.t]!.add(l.s);
      this.nodes[l.s]!.deg++;
      this.nodes[l.t]!.deg++;
    }
    for (const n of this.nodes) n.r = this.mode === "agents" ? 22 : 4 + Math.sqrt(n.deg) * 2.4;
    this.labelOrder = this.nodes.map((_, i) => i).sort((a, b) => this.nodes[b]!.r - this.nodes[a]!.r);
    const keep = (i: number) => {
      const id = i >= 0 && before[i] ? before[i]!.id : null;
      return id != null && this.byId.has(id) ? this.byId.get(id)! : -1;
    };
    this.selected = keep(this.selected);
    this.hover = keep(this.hover);
    this.dragging = keep(this.dragging);
    this.lastFocus = -1;
    const changed = this.nodes.length !== prev.size || this.links.length !== prevLinks || this.nodes.some((n) => !prev.has(n.id));
    this.reheat(changed ? 1 : 0.06);
    this.recolor();
    this.setSearch(this.searchTerm);
    this.cb.onStats?.(this.nodes.length, this.links.length);
    this.dirty = true;
  }

  // Group colours are assigned by first appearance, from the theme's palette.
  private recolor() {
    if (!this.theme) return;
    if (this.mode === "project") {
      const gi = new Map<string, string>();
      for (const n of this.nodes) {
        if (!gi.has(n.group)) gi.set(n.group, this.theme.groups[gi.size % this.theme.groups.length]!);
        n.color = gi.get(n.group)!;
      }
    }
  }

  groups(): { label: string; color: string; count: number }[] {
    const m = new Map<string, { label: string; color: string; count: number }>();
    for (const n of this.nodes) {
      const g = m.get(n.group) ?? { label: n.group, color: n.color, count: 0 };
      g.count++;
      m.set(n.group, g);
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }

  setMode(m: GraphMode) {
    this.mode = m;
    this.selected = this.hover = -1;
    this.pulses = [];
    this.setGraph([], []);
  }

  updateAgent(id: string, patch: Partial<Pick<GNode, "status" | "label" | "color" | "lead">>) {
    const i = this.byId.get(id);
    if (i === undefined) return;
    Object.assign(this.nodes[i]!, patch);
    this.dirty = true;
  }

  pulse(a: string, b: string, color: string) {
    if (!this.byId.has(a) || !this.byId.has(b)) return;
    this.pulses.push({ a, b, color, born: performance.now() });
  }

  setSearch(term: string) {
    this.searchHits = new Set();
    this.searchTerm = term.trim().toLowerCase();
    if (this.searchTerm) this.nodes.forEach((n, i) => (n.label.toLowerCase().includes(this.searchTerm) || n.id.toLowerCase().includes(this.searchTerm)) && this.searchHits.add(i));
    this.dirty = true;
    return this.searchHits.size;
  }

  flyToSearch() {
    let best = -1;
    let bd = -1;
    for (const i of this.searchHits)
      if (this.nodes[i]!.deg > bd) {
        bd = this.nodes[i]!.deg;
        best = i;
      }
    if (best >= 0) this.focusIndex(best);
  }

  focusNode(id: string) {
    const i = this.byId.get(id);
    if (i !== undefined) this.focusIndex(i);
  }

  private focusIndex(i: number) {
    this.selected = i;
    this.autoFit = false;
    this.glide = null;
    this.centreOn(this.nodes[i]!.x, this.nodes[i]!.y, Math.max(this.cam.k, 1.4));
    this.cb.onSelect?.(this.nodes[i]!.id);
  }

  clearSelection() {
    this.selected = -1;
    this.cb.onSelect?.(null);
    this.dirty = true;
  }

  reheat(v = 1) {
    this.sim.alpha = Math.max(this.sim.alpha, v);
  }

  unpinAll() {
    for (const n of this.nodes) n.pinned = false;
    this.reheat(0.5);
    this.fit();
  }

  fit(animate = true) {
    if (!this.nodes.length) return;
    this.glide = null;
    this.fitTarget();
    this.autoFit = true;
    if (!animate) {
      this.cam.cx = this.cam.tcx;
      this.cam.cy = this.cam.tcy;
      this.cam.k = this.cam.tk;
    }
  }

  zoomBy(factor: number) {
    this.zoomAt(this.W / 2, this.H / 2, factor);
  }

  // ---- camera ----
  private toScreen(wx: number, wy: number) {
    return { x: (wx - this.cam.cx) * this.cam.k + this.W / 2, y: (wy - this.cam.cy) * this.cam.k + this.H / 2 };
  }
  private toWorld(sx: number, sy: number) {
    return { x: this.cam.cx + (sx - this.W / 2) / this.cam.k, y: this.cam.cy + (sy - this.H / 2) / this.cam.k };
  }
  private free() {
    const i = this.insets;
    return { x0: i.left, y0: i.top, x1: Math.max(i.left + 120, this.W - i.right), y1: Math.max(i.top + 120, this.H - i.bottom) };
  }
  private centreOn(wx: number, wy: number, k = this.cam.tk) {
    const f = this.free();
    this.cam.tk = k;
    this.cam.tcx = wx + (this.W / 2 - (f.x0 + f.x1) / 2) / k;
    this.cam.tcy = wy + (this.H / 2 - (f.y0 + f.y1) / 2) / k;
  }
  private fitTarget() {
    let a = Infinity,
      b = Infinity,
      c = -Infinity,
      d = -Infinity;
    for (const n of this.nodes) {
      a = Math.min(a, n.x - n.r);
      b = Math.min(b, n.y - n.r - 4);
      c = Math.max(c, n.x + n.r);
      d = Math.max(d, n.y + n.r + 18);
    }
    const f = this.free();
    const vw = Math.max(120, f.x1 - f.x0);
    const vh = Math.max(120, f.y1 - f.y0);
    this.centreOn((a + c) / 2, (b + d) / 2, Math.min(this.mode === "agents" ? 1.6 : 4, Math.max(0.04, 0.88 * Math.min(vw / (c - a || 1), vh / (d - b || 1)))));
  }
  private zoomAt(sx: number, sy: number, factor: number, snap = false) {
    this.autoFit = false;
    this.glide = null;
    const k0 = this.cam.tk;
    const k1 = Math.min(8, Math.max(0.04, k0 * factor));
    if (k1 === k0) return;
    const wx = this.cam.tcx + (sx - this.W / 2) / k0;
    const wy = this.cam.tcy + (sy - this.H / 2) / k0;
    this.cam.tk = k1;
    this.cam.tcx = wx - (sx - this.W / 2) / k1;
    this.cam.tcy = wy - (sy - this.H / 2) / k1;
    if (snap) {
      this.cam.k = this.cam.tk;
      this.cam.cx = this.cam.tcx;
      this.cam.cy = this.cam.tcy;
    }
  }
  private camSettled() {
    const c = this.cam;
    return c.cx === c.tcx && c.cy === c.tcy && c.k === c.tk;
  }

  // ---- frame loop ----
  private draw = (now: number) => {
    if (this.dead) return;
    const dt = Math.min(64, now - this.lastT) || STEP;
    this.lastT = now;
    this.physAcc += dt;
    let steps = 0;
    while (this.physAcc >= STEP && steps < 4) {
      if (this.mode === "agents") {
        for (const p of this.nodes) p.vx = p.vy = 0;
        this.sim.alpha = 0;
      } else tick(this.nodes, this.links, this.sim, this.dragging);
      this.physAcc -= STEP;
      steps++;
    }
    if (steps === 4) this.physAcc = 0;
    if (this.glide) {
      this.cam.cx += this.glide.x * dt;
      this.cam.cy += this.glide.y * dt;
      this.cam.tcx = this.cam.cx;
      this.cam.tcy = this.cam.cy;
      const dd = Math.exp(-dt / 260);
      this.glide.x *= dd;
      this.glide.y *= dd;
      if (Math.hypot(this.glide.x, this.glide.y) * this.cam.k < 0.02) this.glide = null;
    }
    const s = ease(dt, 90);
    const c = this.cam;
    c.cx += (c.tcx - c.cx) * s;
    c.cy += (c.tcy - c.cy) * s;
    c.k += (c.tk - c.k) * s;
    if (Math.abs(c.tk - c.k) < c.tk * 2e-4) c.k = c.tk;
    if (Math.abs(c.tcx - c.cx) * c.k < 0.02) c.cx = c.tcx;
    if (Math.abs(c.tcy - c.cy) * c.k < 0.02) c.cy = c.tcy;
    if (this.autoFit && this.nodes.length) {
      this.fitTarget();
      if (this.sim.alpha === 0 && this.camSettled()) this.autoFit = false;
    }
    this.updateFades(dt);
    if (!this.still()) this.render(now);
    this.raf = requestAnimationFrame(this.draw);
  };

  private updateFades(dt: number) {
    const s = ease(dt, 60);
    const focus = this.selected >= 0 ? this.selected : this.hover;
    if (focus >= 0) this.lastFocus = focus;
    const near = focus >= 0 ? this.adj[focus] : null;
    const dimT = focus >= 0 || this.searchHits.size > 0 ? 1 : 0;
    this.fading = Math.abs(dimT - this.dimAmt) > 0.002;
    this.dimAmt = this.fading ? this.dimAmt + (dimT - this.dimAmt) * s : dimT;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i]!;
      const want = (focus < 0 || i === focus || near!.has(i)) && (this.searchHits.size === 0 || this.searchHits.has(i)) ? 1 : 0;
      const d = want - n.hl;
      if (Math.abs(d) > 0.002) {
        n.hl += d * s;
        this.fading = true;
      } else n.hl = want;
    }
  }

  private still(): boolean {
    if (this.dirty) {
      this.dirty = false;
      return false;
    }
    if (this.mode === "agents") {
      // Live only while something moves: a pulse in flight (60fps), or a working agent's ring
      // (30fps is plenty for a slow pulse). A quiet team costs nothing.
      if (this.pulses.length || this.dragging >= 0 || this.fading || !this.camSettled()) return false;
      if (this.nodes.some((n) => n.status === "working")) return (this.frameNo++ & 1) === 1;
      // Blinks: redraw only when one starts or ends.
      const now = performance.now();
      const blinkKey = this.nodes.map((n) => (isBlinking(n.slot ?? 0, now) ? 1 : 0)).join("");
      if (blinkKey !== this.lastBlink) {
        this.lastBlink = blinkKey;
        return false;
      }
    } else if (this.sim.alpha !== 0 || this.dragging >= 0 || this.autoFit || this.fading || this.pulses.length || !this.camSettled()) return false;
    const key = `${this.hover}|${this.selected}|${this.searchTerm}|${this.showLabels}|${this.W}|${this.H}|${this.nodes.length}|${this.cam.cx},${this.cam.cy},${this.cam.k}|${this.overMini}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      return false;
    }
    return true;
  }

  private render(now: number) {
    const { ctx, cam, theme: T } = this;
    if (!T) return;
    const MUTED = rgb(T.muted);
    const ACC = rgb(T.accent);
    const BG = rgb(T.bg);
    ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.save();
    ctx.translate(this.W / 2, this.H / 2);
    ctx.scale(cam.k, cam.k);
    ctx.translate(-cam.cx, -cam.cy);

    const focus = this.selected >= 0 ? this.selected : this.hover;
    const fx = focus >= 0 ? focus : this.dimAmt > 0.01 && this.lastFocus < this.nodes.length ? this.lastFocus : -1;
    const hits = this.searchHits;
    const pd = new Path2D();
    const pn = new Path2D();
    const pf = new Path2D();
    const pa = new Path2D();
    const wantArrows = this.mode === "project" && cam.k > 1.05;
    for (const l of this.links) {
      const s = this.nodes[l.s]!;
      const t = this.nodes[l.t]!;
      const on = fx >= 0 && (l.s === fx || l.t === fx);
      const p = on ? pf : (fx < 0 && hits.size === 0) || hits.has(l.s) || hits.has(l.t) ? pn : pd;
      p.moveTo(s.x, s.y);
      p.lineTo(t.x, t.y);
      if (this.mode === "project" && (on || (wantArrows && p === pn))) this.arrow(pa, s, t);
    }
    const agentsMode = this.mode === "agents";
    ctx.lineWidth = (agentsMode ? 1.5 : 1) / cam.k;
    ctx.strokeStyle = `rgba(${MUTED},${0.3 - 0.22 * this.dimAmt})`;
    ctx.stroke(pd);
    ctx.strokeStyle = `rgba(${MUTED},${agentsMode ? 0.4 : 0.3})`;
    ctx.stroke(pn);
    ctx.lineWidth = (1 + 0.6 * this.dimAmt) / cam.k;
    ctx.strokeStyle = `rgba(${this.dimAmt > 0.5 ? ACC : MUTED},${0.3 + 0.4 * this.dimAmt})`;
    ctx.stroke(pf);
    ctx.fillStyle = `rgba(${ACC},0.5)`;
    ctx.fill(pa);

    if (this.pulses.length) this.pulses = this.pulses.filter((p) => now - p.born < 1600);
    for (const p of this.pulses) {
      const s = this.nodes[this.byId.get(p.a)!];
      const t = this.nodes[this.byId.get(p.b)!];
      if (!s || !t) continue;
      const tt = (now - p.born) / 1600;
      const e = 1 - Math.pow(1 - tt, 3);
      ctx.globalAlpha = 1 - tt * tt;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(s.x + (t.x - s.x) * e, s.y + (t.y - s.y) * e, 4.5 / cam.k, 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const v0 = this.toWorld(-40, -40);
    const v1 = this.toWorld(this.W + 40, this.H + 40);
    const vis = (n: GNode) => n.x + n.r > v0.x && n.x - n.r < v1.x && n.y + n.r > v0.y && n.y - n.r < v1.y;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i]!;
      if (!vis(n)) continue;
      const alpha = 1 - (1 - n.hl) * 0.84;
      ctx.globalAlpha = alpha;
      if (i === this.hover || i === this.selected || hits.has(i)) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 4 / cam.k, 0, 7);
        ctx.fillStyle = `rgba(${ACC},0.2)`;
        ctx.fill();
      }
      if (agentsMode) {
        this.mascot(n.x, n.y, n.r * 2.1, n.slot ?? 0, now);
        if (n.lead) {
          ctx.fillStyle = T.groups[3] ?? T.accent;
          ctx.font = `${12}px ui-sans-serif, system-ui`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("★", n.x + n.r * 0.85, n.y - n.r * 0.85);
        }
        const st = n.status === "working" ? T.info : n.status === "failed" ? T.destructive : n.status === "done" ? T.success : T.muted;
        ctx.fillStyle = st;
        ctx.beginPath();
        ctx.arc(n.x + n.r * 0.72, n.y + n.r * 0.72, 4.5, 0, 7);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = T.bg;
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, 7);
        ctx.fillStyle = n.color || T.muted;
        ctx.fill();
        if (n.pinned) {
          ctx.lineWidth = 1 / cam.k;
          ctx.strokeStyle = `rgba(${rgb(T.ink)},0.45)`;
          ctx.stroke();
        }
      }
      if (n.status === "working") {
        const pw = (now % 1200) / 1200;
        ctx.globalAlpha = (1 - pw) * alpha;
        ctx.strokeStyle = T.info;
        ctx.lineWidth = 2 / cam.k;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + (2 + pw * 9) / cam.k, 0, 7);
        ctx.stroke();
      }
    }

    // ponytail: O(labels × placed) box scan, fine to a few hundred labels; grid-bucket it past that.
    const zoomA = agentsMode ? 1 : Math.min(1, Math.max(0, (cam.k - 0.62) / 0.28));
    if (this.showLabels) {
      const fs = agentsMode ? 12.5 : 11;
      ctx.font = `${agentsMode ? 600 : 400} ${fs / cam.k}px ${agentsMode ? '"Inter Variable", ui-sans-serif' : '"JetBrains Mono Variable", ui-monospace'}, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
      for (const pass of [1, 0])
        for (const i of this.labelOrder) {
          const n = this.nodes[i]!;
          if ((n.hl > 0.5 ? 1 : 0) !== pass || !vis(n)) continue;
          const forced = i === this.hover || i === this.selected;
          const a = (1 - (1 - n.hl) * 0.84) * (forced || n.r > 8 ? 1 : zoomA);
          if (a < 0.03) continue;
          const p = this.toScreen(n.x, n.y);
          const w = n.label.length * (agentsMode ? 7.4 : 6.7);
          const top = p.y + (n.r + 3) * cam.k;
          const b = { x0: p.x - w / 2, y0: top, x1: p.x + w / 2, y1: top + 14 };
          if (!forced && boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0)) continue;
          boxes.push(b);
          ctx.globalAlpha = a;
          ctx.fillStyle = `rgba(${BG},0.85)`;
          ctx.fillText(n.label, n.x + 0.6 / cam.k, n.y + n.r + (agentsMode ? 6.6 : 2.6) / cam.k);
          ctx.fillStyle = T.ink;
          ctx.fillText(n.label, n.x, n.y + n.r + (agentsMode ? 6 : 2) / cam.k);
        }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    this.drawMinimap();
  }

  // An agent's avatar image, centred on (cx, cy) in world space; the blink frame for an instant.
  private mascot(cx: number, cy: number, size: number, slot: number, now: number) {
    const img = avatarImage(slot, isBlinking(slot, now));
    if (img) this.ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    else this.dirty = true; // not decoded yet: try again next frame
  }

  private arrow(path: Path2D, s: GNode, t: GNode) {
    const k = this.cam.k;
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const ax = t.x - ux * (t.r + 2 / k);
    const ay = t.y - uy * (t.r + 2 / k);
    const a = 5 / k;
    path.moveTo(ax, ay);
    path.lineTo(ax - ux * a - uy * a * 0.6, ay - uy * a + ux * a * 0.6);
    path.lineTo(ax - ux * a + uy * a * 0.6, ay - uy * a - ux * a * 0.6);
    path.closePath();
  }

  private miniRect() {
    if (this.nodes.length < 12 || this.mode !== "project") return null;
    const w = 150;
    const h = 110;
    const pad = 8;
    const x = this.W - w - 14;
    const y = this.H - this.insets.bottom - h;
    let a = Infinity,
      b = Infinity,
      c = -Infinity,
      d = -Infinity;
    for (const n of this.nodes) {
      a = Math.min(a, n.x);
      b = Math.min(b, n.y);
      c = Math.max(c, n.x);
      d = Math.max(d, n.y);
    }
    const sc = Math.min((w - pad * 2) / (c - a || 1), (h - pad * 2) / (d - b || 1));
    return { x, y, w, h, pad, a, b, sc };
  }
  private inMini(m: ReturnType<GraphEngine["miniRect"]>, sx: number, sy: number) {
    return !!m && sx >= m.x && sx <= m.x + m.w && sy >= m.y && sy <= m.y + m.h;
  }
  private miniToWorld(m: NonNullable<ReturnType<GraphEngine["miniRect"]>>, sx: number, sy: number) {
    return { x: m.a + (sx - m.x - m.pad) / m.sc, y: m.b + (sy - m.y - m.pad) / m.sc };
  }
  private drawMinimap() {
    const m = this.miniRect();
    if (!m) return;
    const { ctx, theme: T } = this;
    const ACC = rgb(T.accent);
    ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    ctx.fillStyle = `rgba(${rgb(T.bg)},0.9)`;
    ctx.strokeStyle = this.overMini ? `rgba(${ACC},0.8)` : T.line;
    ctx.lineWidth = 1;
    this.roundRect(m.x, m.y, m.w, m.h, 8);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 0.6;
    for (const n of this.nodes) {
      ctx.fillStyle = n.color || T.muted;
      ctx.fillRect(m.x + m.pad + (n.x - m.a) * m.sc - 0.8, m.y + m.pad + (n.y - m.b) * m.sc - 0.8, 1.8, 1.8);
    }
    ctx.globalAlpha = 1;
    const tl = this.toWorld(0, 0);
    const br = this.toWorld(this.W, this.H);
    const vx = m.x + m.pad + (tl.x - m.a) * m.sc;
    const vy = m.y + m.pad + (tl.y - m.b) * m.sc;
    ctx.save();
    this.roundRect(m.x, m.y, m.w, m.h, 8);
    ctx.clip();
    ctx.fillStyle = `rgba(${ACC},0.1)`;
    ctx.fillRect(vx, vy, (br.x - tl.x) * m.sc, (br.y - tl.y) * m.sc);
    ctx.strokeStyle = `rgba(${ACC},0.8)`;
    ctx.strokeRect(vx, vy, (br.x - tl.x) * m.sc, (br.y - tl.y) * m.sc);
    ctx.restore();
  }
  private roundRect(x: number, y: number, w: number, h: number, r: number) {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  private pick(sx: number, sy: number): number {
    const w = this.toWorld(sx, sy);
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i]!;
      const d = Math.hypot(n.x - w.x, n.y - w.y);
      if (d < n.r + 6 / this.cam.k && d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  // ---- input ----
  private local(e: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  private hoverInfo(i: number, x: number, y: number): HoverInfo {
    return { node: this.nodes[i]!, x, y, neighbours: [...this.adj[i]!].map((j) => this.nodes[j]!.label).sort() };
  }
  private onDown = (e: PointerEvent) => {
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    this.autoFit = false;
    this.glide = null;
    if (this.pointers.size === 2) {
      this.pinchDist = this.twoDist();
      this.dragging = -1;
      this.panLast = null;
      this.miniDrag = false;
      return;
    }
    const m = this.miniRect();
    if (this.inMini(m, p.x, p.y)) {
      this.miniDrag = true;
      this.hover = -1;
      this.cb.onHover?.(null);
      const w = this.miniToWorld(m!, p.x, p.y);
      this.centreOn(w.x, w.y);
      return;
    }
    const hit = this.pick(p.x, p.y);
    if (hit >= 0) {
      const w = this.toWorld(p.x, p.y);
      this.dragging = hit;
      this.selected = hit;
      this.grab = { x: this.nodes[hit]!.x - w.x, y: this.nodes[hit]!.y - w.y };
      this.nodes[hit]!.pinned = true;
      this.reheat(this.sim.dragAlpha);
      this.canvas.style.cursor = "grabbing";
      this.cb.onSelect?.(this.nodes[hit]!.id);
    } else {
      if (this.selected >= 0) this.cb.onSelect?.(null);
      this.selected = -1;
      this.panLast = p;
      this.canvas.style.cursor = "grabbing";
      this.panV = { x: 0, y: 0 };
      this.panT = performance.now();
    }
    this.dirty = true;
  };
  private onMove = (e: PointerEvent) => {
    const p = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 2) {
      const nd = this.twoDist();
      const pts = [...this.pointers.values()];
      if (this.pinchDist) this.zoomAt((pts[0]!.x + pts[1]!.x) / 2, (pts[0]!.y + pts[1]!.y) / 2, nd / this.pinchDist, true);
      this.pinchDist = nd;
      return;
    }
    if (this.miniDrag) {
      const m = this.miniRect();
      if (m) {
        const w = this.miniToWorld(m, p.x, p.y);
        this.centreOn(w.x, w.y);
        this.cam.cx = this.cam.tcx;
        this.cam.cy = this.cam.tcy;
      }
      return;
    }
    if (this.dragging >= 0) {
      const w = this.toWorld(p.x, p.y);
      const n = this.nodes[this.dragging]!;
      n.x = w.x + this.grab.x;
      n.y = w.y + this.grab.y;
      n.vx = n.vy = 0;
      this.reheat(this.sim.dragAlpha);
      this.dirty = true;
      return;
    }
    if (this.panLast) {
      const dx = p.x - this.panLast.x;
      const dy = p.y - this.panLast.y;
      this.cam.cx -= dx / this.cam.k;
      this.cam.cy -= dy / this.cam.k;
      this.cam.tcx = this.cam.cx;
      this.cam.tcy = this.cam.cy;
      this.panLast = p;
      const t = performance.now();
      const dt = Math.max(1, t - this.panT);
      this.panT = t;
      this.panV = { x: this.panV.x * 0.6 + (dx / dt) * 0.4, y: this.panV.y * 0.6 + (dy / dt) * 0.4 };
      return;
    }
    const overM = this.inMini(this.miniRect(), p.x, p.y);
    if (overM !== this.overMini) this.overMini = overM;
    if (overM) {
      this.hover = -1;
      this.cb.onHover?.(null);
      this.canvas.style.cursor = "pointer";
      return;
    }
    const h = this.pick(p.x, p.y);
    if (h !== this.hover) this.cb.onHover?.(h >= 0 ? this.hoverInfo(h, p.x, p.y) : null);
    else if (h >= 0) this.cb.onHover?.(this.hoverInfo(h, p.x, p.y));
    this.hover = h;
    this.canvas.style.cursor = h >= 0 ? "pointer" : "grab";
  };
  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.panLast && performance.now() - this.panT < 90 && Math.hypot(this.panV.x, this.panV.y) > 0.06) {
      this.glide = { x: -this.panV.x / this.cam.k, y: -this.panV.y / this.cam.k };
    }
    this.dragging = -1;
    this.panLast = null;
    this.miniDrag = false;
    if (this.pointers.size < 2) this.pinchDist = 0;
    this.canvas.style.cursor = this.hover >= 0 ? "pointer" : "grab";
  };
  private onLeave = () => {
    if (this.dragging < 0 && !this.miniDrag) {
      this.hover = -1;
      this.overMini = false;
      this.cb.onHover?.(null);
    }
  };
  private onDbl = (e: MouseEvent) => {
    const p = this.local(e);
    if (this.inMini(this.miniRect(), p.x, p.y)) return;
    const h = this.pick(p.x, p.y);
    if (h >= 0) {
      this.nodes[h]!.pinned = false;
      this.reheat(0.3);
    } else this.fit(true);
  };
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = this.local(e);
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.H : 1);
    this.zoomAt(p.x, p.y, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)));
  };
  private twoDist() {
    const p = [...this.pointers.values()];
    return Math.hypot(p[0]!.x - p[1]!.x, p[0]!.y - p[1]!.y);
  }
  private bind() {
    const c = this.canvas;
    c.addEventListener("pointerdown", this.onDown);
    c.addEventListener("pointermove", this.onMove);
    c.addEventListener("pointerup", this.onUp);
    c.addEventListener("pointercancel", this.onUp);
    c.addEventListener("pointerleave", this.onLeave);
    c.addEventListener("dblclick", this.onDbl);
    c.addEventListener("wheel", this.onWheel, { passive: false });
  }
  private unbind() {
    const c = this.canvas;
    c.removeEventListener("pointerdown", this.onDown);
    c.removeEventListener("pointermove", this.onMove);
    c.removeEventListener("pointerup", this.onUp);
    c.removeEventListener("pointercancel", this.onUp);
    c.removeEventListener("pointerleave", this.onLeave);
    c.removeEventListener("dblclick", this.onDbl);
    c.removeEventListener("wheel", this.onWheel);
  }
}

