import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

// graph.js is a plain browser script, so we run it against the smallest possible stub DOM and hand
// back its internals. Only the layout/camera maths is under test — render() is never called, so the
// canvas context can be an inert proxy.
function load() {
  const noop: any = new Proxy(() => noop, { get: () => noop });
  const el = () => ({
    addEventListener() {}, getContext: () => noop, classList: { toggle() {}, add() {}, remove() {} },
    style: {}, value: "", textContent: "", innerHTML: "", checked: true, offsetWidth: 0,
    // the controls column on the right and the topbar: fit must dodge both
    getBoundingClientRect: () => ({ left: 1220, right: 1470, top: 14, bottom: 52 }),
  });
  const doc = { getElementById: el, querySelectorAll: () => [], addEventListener() {} };
  const win = {
    innerWidth: 1470, innerHeight: 780, devicePixelRatio: 2,
    addEventListener() {}, requestAnimationFrame() {}, // no RAF: tests drive tick() themselves
    fetch: () => Promise.reject(new Error("offline")), EventSource: class {},
    document: doc, location: { search: "" }, performance,
  };
  const src = readFileSync(new URL("./graph.js", import.meta.url), "utf8");
  return new Function("window", "document", "location", "requestAnimationFrame", "fetch", "EventSource", "performance", "URLSearchParams",
    `${src}\nreturn { tick, fit, setGraph, sim, cam, free: () => free, nodes: () => nodes,
       glideStep, miniRect, inMini, miniToWorld, centreOn, setGlide: (g) => { glide = g; }, getGlide: () => glide,
       setMode: (m) => { mode = m; }, realSetMode: setMode, onEvent, ensureM, mnodes };`,
  )(win, doc, win.location, win.requestAnimationFrame, win.fetch, win.EventSource, performance, URLSearchParams);
}

// a hub, a chain and some orphans — orphans are what used to fly off to r ≈ 2000 and wreck the fit
const NODES = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, label: `n${i}`, group: "g" }));
const EDGES = [
  ...Array.from({ length: 12 }, (_, i) => ({ from: "n0", to: `n${i + 1}` })),
  ...Array.from({ length: 10 }, (_, i) => ({ from: `n${i + 13}`, to: `n${i + 14}` })),
];
const settle = (g: any, limit = 3000) => { let f = 0; while (g.sim.alpha !== 0 && f < limit) { g.tick(); f++; } return f; };

test("the layout settles and then holds perfectly still", () => {
  const g = load();
  g.setGraph(NODES, EDGES);
  const frames = settle(g);
  expect(frames).toBeLessThan(1200);          // it stops on its own…
  expect(g.sim.alpha).toBe(0);                // …and freezes rather than idling at alphaMin
  const before = g.nodes().map((n: any) => [n.x, n.y]);
  for (let i = 0; i < 500; i++) g.tick();
  const drift = Math.max(...g.nodes().map((n: any, i: number) => Math.hypot(n.x - before[i][0], n.y - before[i][1])));
  expect(drift).toBe(0);                      // any drift here is the jitter the user sees
});

test("gravity contains the layout, so disconnected nodes can't blow up the scale", () => {
  const g = load();
  g.setGraph(NODES, EDGES);
  settle(g);
  const ns = g.nodes();
  let cx = 0, cy = 0; for (const n of ns) { cx += n.x; cy += n.y; }
  cx /= ns.length; cy /= ns.length;
  const maxR = Math.max(...ns.map((n: any) => Math.hypot(n.x - cx, n.y - cy)));
  expect(maxR).toBeLessThan(3 * Math.sqrt(ns.length) * 46); // ~within a few times the seeded spread
});

test("a flicked pan coasts and comes to a complete stop", () => {
  const g = load();
  g.setGraph(NODES, EDGES);
  settle(g);
  g.fit(false);
  const from = g.cam.cx;
  g.setGlide({ x: 0.5, y: 0 }); // world-units/ms, as endPointer hands off
  let frames = 0, last = g.cam.cx, maxStep = 0;
  while (g.getGlide() && frames < 2000) {
    g.glideStep(16.7);
    maxStep = Math.max(maxStep, Math.abs(g.cam.cx - last)); // never speeds up
    last = g.cam.cx; frames++;
  }
  expect(g.cam.cx).toBeGreaterThan(from);        // it actually moved
  expect(frames).toBeGreaterThan(10);            // …and coasted rather than snapping
  expect(frames).toBeLessThan(240);              // …but stopped, no infinite asymptote
  expect(maxStep).toBeLessThanOrEqual(0.5 * 16.7 + 1e-9); // monotonically decelerating
  expect(g.cam.tcx).toBe(g.cam.cx);              // target follows, so easeCam doesn't fight it
});

test("clicking the minimap centres that world point in the visible area", () => {
  const g = load();
  g.setGraph(NODES, EDGES);
  settle(g);
  g.fit(false);
  const m = g.miniRect();
  expect(m).not.toBeNull();
  expect(m.y + m.h).toBeLessThanOrEqual(g.free().y1); // clear of the stat panel, or clicks never land
  expect(g.inMini(m, m.x + 5, m.y + 5)).toBe(true);
  expect(g.inMini(m, m.x - 5, m.y + 5)).toBe(false);

  const target = g.miniToWorld(m, m.x + m.pad + 20, m.y + m.pad + 20);
  g.centreOn(target.x, target.y);
  g.cam.cx = g.cam.tcx; g.cam.cy = g.cam.tcy; g.cam.k = g.cam.tk;
  const free = g.free(), k = g.cam.k;
  const sx = (target.x - g.cam.cx) * k + 1470 / 2, sy = (target.y - g.cam.cy) * k + 780 / 2;
  expect(Math.abs(sx - (free.x0 + free.x1) / 2)).toBeLessThan(0.001);
  expect(Math.abs(sy - (free.y0 + free.y1) / 2)).toBeLessThan(0.001);
});

test("models mode lays agents out on an even ring with fixed, readable avatar sizes", () => {
  const g = load();
  g.setMode("models");
  const agents = [
    { id: "a", label: "a", lead: true, status: "idle", tokens: 0, group: "agent", colorIndex: 0 },
    { id: "b", label: "b", lead: false, status: "idle", tokens: 0, group: "agent", colorIndex: 1 },
    { id: "c", label: "c", lead: false, status: "idle", tokens: 0, group: "agent", colorIndex: 2 },
  ];
  g.setGraph(agents, []);
  const ns = g.nodes();

  // fixed size, not degree-derived (no links yet, so a degree-based radius would've collapsed to 4)
  // and the SAME size for every node including lead — a bigger lead sprite is what made same-shaped
  // avatars look inconsistent side by side; lead is a ring drawn in render(), not a size change.
  expect(ns[0].r).toBe(20); // lead
  expect(ns[1].r).toBe(20);
  expect(ns[2].r).toBe(20);

  // evenly spaced on a ring around the origin, not a spiral at three different radii
  const dists = ns.map((n: any) => Math.hypot(n.x, n.y));
  expect(Math.abs(dists[0] - dists[1])).toBeLessThan(0.01);
  expect(Math.abs(dists[1] - dists[2])).toBeLessThan(0.01);
});

test("models mode holds its ring layout still — no file-graph physics tugging it around", () => {
  const g = load();
  g.setMode("models");
  const agents = [
    { id: "a", label: "a", lead: true, status: "idle", tokens: 0, group: "agent", colorIndex: 0 },
    { id: "b", label: "b", lead: false, status: "idle", tokens: 0, group: "agent", colorIndex: 1 },
  ];
  g.setGraph(agents, [{ from: "a", to: "b" }]); // a link, which would pull nodes together under physics
  const before = g.nodes().map((n: any) => [n.x, n.y]);
  for (let i = 0; i < 200; i++) g.tick();
  const after = g.nodes().map((n: any) => [n.x, n.y]);
  expect(after).toEqual(before);
  expect(g.sim.alpha).toBe(0);
});

// Regression: switching modes kicks off an async fetch for the new mode's data. Before this fix,
// `mode` flipped synchronously but `nodes`/`links` kept the OLD mode's data until that fetch
// resolved — so a frame in between rendered plain file nodes (no colorIndex) through the pixel-
// avatar path. Real browsers hit this: the fetch is faster than a human clicking, but not always
// faster than the very next animation frame. setMode must clear the old data immediately.
test("switching modes clears the old mode's nodes immediately, not after the fetch resolves", () => {
  const g = load();
  g.setGraph(
    [{ id: "f1", label: "f1", group: "g" }], // a plain file node — no colorIndex, no group:"agent"
    [],
  );
  expect(g.nodes()).toHaveLength(1);
  g.realSetMode("models"); // fetch('/session') rejects in this stub, but nodes must clear synchronously regardless
  expect(g.nodes()).toHaveLength(0);
});

test("\"system\" and \"orchestrator\" pseudo-senders never become graph nodes", () => {
  const g = load();
  g.setMode("models");
  g.onEvent({ kind: "agent_event", event: { agentId: "system", type: "external_change", payload: "x.ts" } });
  g.onEvent({ kind: "agent_event", event: { agentId: "orchestrator", type: "file_edit", payload: "undo: y" } });
  g.onEvent({ kind: "agent_message", message: { from: "a", to: "system", kind: "handoff" } });
  expect([...g.mnodes.keys()]).not.toContain("system");
  expect([...g.mnodes.keys()]).not.toContain("orchestrator");
});

test("the ring recomputes for every node when the roster grows, so nobody overlaps", () => {
  const g = load();
  g.setMode("models");
  g.setGraph(
    [
      { id: "a", label: "a", lead: false, status: "idle", tokens: 0, group: "agent", colorIndex: 0 },
      { id: "b", label: "b", lead: false, status: "idle", tokens: 0, group: "agent", colorIndex: 1 },
    ],
    [],
  );
  // add a third member — a's and b's ring slots were computed for a 2-node ring; if they don't
  // get recomputed for the new 3-node ring, their angles fall out of step with c's fresh one.
  g.setGraph(
    [
      { id: "a", label: "a", lead: false, status: "idle", tokens: 0, group: "agent", colorIndex: 0 },
      { id: "b", label: "b", lead: false, status: "idle", tokens: 0, group: "agent", colorIndex: 1 },
      { id: "c", label: "c", lead: false, status: "idle", tokens: 0, group: "agent", colorIndex: 2 },
    ],
    [],
  );
  const ns = g.nodes();
  const dist = (i, j) => Math.hypot(ns[i].x - ns[j].x, ns[i].y - ns[j].y);
  const d01 = dist(0, 1), d12 = dist(1, 2), d20 = dist(2, 0);
  // an even 3-node ring has every pair equidistant; a stale 2-node position for a/b would not.
  expect(Math.abs(d01 - d12)).toBeLessThan(0.01);
  expect(Math.abs(d12 - d20)).toBeLessThan(0.01);
});

test("a pinned models-mode node keeps its dragged position across a roster change", () => {
  const g = load();
  g.setMode("models");
  g.setGraph(
    [{ id: "a", label: "a", lead: false, status: "idle", tokens: 0, group: "agent", colorIndex: 0 }],
    [],
  );
  g.nodes()[0].pinned = true;
  g.nodes()[0].x = 999;
  g.nodes()[0].y = -999;
  g.setGraph(
    [
      { id: "a", label: "a", lead: false, status: "idle", tokens: 0, group: "agent", colorIndex: 0 },
      { id: "b", label: "b", lead: false, status: "idle", tokens: 0, group: "agent", colorIndex: 1 },
    ],
    [],
  );
  expect(g.nodes()[0].x).toBe(999);
  expect(g.nodes()[0].y).toBe(-999);
});

test("fit frames the graph inside the free area, centred and un-clipped", () => {
  const g = load();
  g.setGraph(NODES, EDGES);
  settle(g);
  g.cam.k = g.cam.tk = 4; g.cam.cx = g.cam.tcx = 3000; g.cam.cy = g.cam.tcy = -2000; // way off in the weeds
  g.fit(false);
  const { cam } = g, free = g.free();
  const toScreen = (x: number, y: number) => ({ x: (x - cam.cx) * cam.k + 1470 / 2, y: (y - cam.cy) * cam.k + 780 / 2 });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of g.nodes()) {
    const p = toScreen(n.x, n.y);
    x0 = Math.min(x0, p.x - n.r * cam.k); y0 = Math.min(y0, p.y - n.r * cam.k);
    x1 = Math.max(x1, p.x + n.r * cam.k); y1 = Math.max(y1, p.y + n.r * cam.k);
  }
  expect(x0).toBeGreaterThanOrEqual(free.x0 - 1);  // nothing hidden behind the control panel
  expect(x1).toBeLessThanOrEqual(free.x1 + 1);
  expect(y0).toBeGreaterThanOrEqual(free.y0 - 1);
  expect(y1).toBeLessThanOrEqual(free.y1 + 1);
  expect(Math.abs((x0 + x1) / 2 - (free.x0 + free.x1) / 2)).toBeLessThan(1); // centred in what's visible…
  expect(Math.abs((y0 + y1) / 2 - (free.y0 + free.y1) / 2)).toBeLessThan(1);
  expect(Math.max(x1 - x0, y1 - y0)).toBeGreaterThan(0.7 * Math.min(free.x1 - free.x0, free.y1 - free.y0)); // …and actually filling it
});
