"use strict";
// niti graph — a self-contained, dependency-free interactive force graph on canvas.
// Goals over Obsidian's graph: drag+pin, hover/click connection highlighting, zoom-to-cursor + pan,
// Barnes–Hut physics (smooth at hundreds of nodes), directional edges, live "Models" mode over SSE,
// touch + pinch, and a control panel with live force sliders. No external libraries, same-origin only.

const TOKEN = new URLSearchParams(location.search).get("token") || "";
const q = (id) => document.getElementById(id);

// Theme-derived (avatar.js's themeColors()/hexToRgbTriplet(), loaded first) so this canvas matches
// whatever theme the TUI/dashboard has active instead of a fixed palette. `let`, not `const` —
// refreshGraphTheme() reassigns these on the "niti-theme" event (see boot, bottom of file).
let PALETTE, STATUS_FILL, KIND_COLORS, ACCENT, ACCENT_RGB, INK, MUTED;
function refreshGraphTheme() {
  const t = themeColors();
  PALETTE = [t.violet, t.blue, t.green, t.amber, t.pink, t.red];
  STATUS_FILL = { idle: t.muted, working: t.blue, done: t.green, failed: t.red };
  KIND_COLORS = { question: t.amber, answer: t.green, handoff: t.blue, artifact: t.blue, review: t.pink, broadcast: t.violet };
  ACCENT = t.violet; ACCENT_RGB = hexToRgbTriplet(t.violet); INK = t.ink; MUTED = t.muted;
}
refreshGraphTheme();

// ---------- model ----------
let mode = "project"; // "project" | "models"
let nodes = [];       // {id,label,group,role,lead,status,tokens,x,y,vx,vy,pinned,r,deg,color}
let links = [];       // {s,t}  (indices into nodes)
let adj = [];         // adjacency: adj[i] = Set of neighbor indices
let labelOrder = [];  // node indices, largest first — label collision priority
const byId = new Map();
let pulses = [];      // models mode: {s,t,color,born}

let hover = -1, selected = -1, dragging = -1;
let searchHits = new Set(), searchTerm = "";
let showLabels = true;

// force params (bound to sliders). velocityDecay damps the integrator; alphaMin is the temperature
// at which we freeze the sim outright — without a hard freeze the layout buzzes forever.
const sim = { link: 42, charge: 30, gravity: 6, alpha: 1, alphaDecay: 0.021, alphaMin: 0.0006, velocityDecay: 0.72, dragAlpha: 0.15 };

// camera in world space: looks at (cx,cy) with scale k
const cam = { cx: 0, cy: 0, k: 1, tcx: 0, tcy: 0, tk: 1 }; // t* = eased targets
let autoFit = false;    // while set, the fit target is recomputed every frame (see fitTarget)
let autoCentre = false; // like autoFit, but for recenter() — keeps k fixed, only moves cx/cy
let glide = null;     // {x,y} world-units/ms while a flicked pan coasts to a stop
let overMini = false; // pointer is over the minimap

// ---------- canvas ----------
const canvas = q("gcanvas");
const ctx = canvas.getContext("2d");
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.floor(W * DPR); canvas.height = Math.floor(H * DPR);
  canvas.style.width = W + "px"; canvas.style.height = H + "px";
  measureFree();
}
window.addEventListener("resize", resize);

const toScreen = (wx, wy) => ({ x: (wx - cam.cx) * cam.k + W / 2, y: (wy - cam.cy) * cam.k + H / 2 });
const toWorld = (sx, sy) => ({ x: cam.cx + (sx - W / 2) / cam.k, y: cam.cy + (sy - H / 2) / cam.k });

// ---------- data loading ----------
// A file changed on disk (engine.ts's watcher, via SSE) refetches the project graph — debounced so a
// git checkout or formatter touching many files at once triggers one refetch, not one per file.
let liveRefreshTimer = null;
function scheduleLiveRefresh() {
  clearTimeout(liveRefreshTimer);
  liveRefreshTimer = setTimeout(() => { if (mode === "project") loadProject(); }, 400);
}
async function loadProject() {
  setConn("loading…", "");
  try {
    const r = await fetch(`/graph?token=${encodeURIComponent(TOKEN)}`);
    // 401 is not "failed to load" — it is a specific, fixable thing (the URL lost its token), and
    // reporting it as a generic failure sends people looking at the server instead of the link.
    if (r.status === 401) { setConn(TOKEN ? "unauthorized — check the ?token=" : "no token in this URL", "dead"); return; }
    if (!r.ok) { setConn(`failed to load (${r.status})`, "dead"); return; }
    const g = await r.json();
    const ns = g.nodes.map((n) => ({ id: n.id, label: n.label.replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|go)$/, ""), group: n.group }));
    const gi = new Map(); let gc = 0;
    for (const n of ns) { if (!gi.has(n.group)) gi.set(n.group, PALETTE[gc++ % PALETTE.length]); n.color = gi.get(n.group); }
    setGraph(ns, g.edges.map((e) => ({ from: e.from, to: e.to })));
    buildLegend([...gi.entries()].map(([g, c]) => ({ label: g, color: c })), "directories");
    setConn(`${ns.length} files`, "live");
  } catch (e) {
    setConn("failed to load", "dead");
  }
}

// Models mode: seed from /session, then live-update over SSE (mirrors web/app.js). The same SSE
// connection also carries file-change events used to live-refresh project mode (see connectEvents).
let es = null;
let sseOpen = false;
const mnodes = new Map(); // id -> node record (persists across toggles within models mode)
const medges = new Map(); // "a\0b" -> {from,to}
// Pseudo-senders, not teammates: "system" announces file edits made outside niti (engine.ts's
// watcher), "orchestrator" announces undo/rewind — neither is a configured agent, and treating
// either as a graph node put phantom extras in what's supposed to be a fixed, small team.
const NON_AGENT_IDS = new Set(["system", "orchestrator"]);
function ensureM(id, role, lead) {
  if (!id || id === "*" || NON_AGENT_IDS.has(id)) return null;
  let n = mnodes.get(id);
  if (!n) { n = { id, label: role || id, role: role || id, lead: !!lead, status: "idle", tokens: 0, group: "agent", colorIndex: mnodes.size }; mnodes.set(id, n); }
  if (role) { n.role = role; n.label = role; } if (lead) n.lead = true;
  return n;
}
function addEdge(a, b) { if (!a || !b || a === b) return; const k = a < b ? a + "\0" + b : b + "\0" + a; if (!medges.has(k)) medges.set(k, { from: a, to: b }); }
function syncModels() {
  if (mode !== "models") return;
  for (const n of mnodes.values()) n.color = STATUS_FILL[n.status] || STATUS_FILL.idle;
  setGraph([...mnodes.values()], [...medges.values()]);
}
async function loadModels() {
  setConn("connecting…", "");
  try {
    const r = await fetch(`/session?token=${encodeURIComponent(TOKEN)}`, { method: "POST" });
    if (r.ok) { const s = await r.json(); for (const a of s.agents || []) ensureM(a.id, a.role, a.lead); }
  } catch {}
  syncModels();
  buildLegend(Object.entries(STATUS_FILL).map(([k, c]) => ({ label: k, color: c })), "agent status");
  setConn(sseOpen ? "live" : "connecting…", sseOpen ? "live" : "");
}
// One SSE connection for the life of the page, independent of mode — project mode needs it for
// live file-change refreshes just as much as models mode needs it for agent status.
function connectEvents() {
  es = new EventSource(`/events?from=0&token=${encodeURIComponent(TOKEN)}`);
  es.onopen = () => { sseOpen = true; if (mode === "models") setConn("live", "live"); };
  es.onerror = () => {
    if (mode === "models") setConn(sseOpen ? "reconnecting…" : TOKEN ? "unauthorized — check the ?token=" : "no token in this URL", "dead");
    sseOpen = false;
  };
  es.onmessage = (ev) => { let e; try { e = JSON.parse(ev.data); } catch { return; } onEvent(e); };
}
function onEvent(e) {
  // external_change: the watcher noticed an edit made outside niti. file_edit: an agent's own
  // write_file/edit *inside* this session — self-write suppression on the watcher means that one
  // never fires external_change, so without this the graph never refreshed for the case people
  // actually watch it for: agents creating/editing files live.
  if (e.kind === "agent_event" && (e.event?.type === "external_change" || e.event?.type === "file_edit")) {
    if (mode === "project") scheduleLiveRefresh();
    return; // the watcher's "system" pseudo-sender isn't an agent — nothing for models mode to do here
  }
  if (e.kind === "agent_message" && e.message) {
    const m = e.message; ensureM(m.from); if (m.to !== "*") ensureM(m.to);
    const targets = m.to === "*" ? [...mnodes.keys()].filter((k) => k !== m.from) : [m.to];
    for (const t of targets) { addEdge(m.from, t); pulses.push({ a: m.from, b: t, color: KIND_COLORS[m.kind] || ACCENT, born: performance.now() }); }
    syncModels();
  } else if (e.kind === "orchestration") {
    const ev = e.event;
    if (ev.type === "plan") { for (const t of ev.tasks) ensureM(t.role); syncModels(); }
    if (ev.type === "task_started") { const n = mnodes.get(ev.role); if (n) n.status = "working"; }
    if (ev.type === "task_done") { const n = mnodes.get(ev.role); if (n) n.status = ev.ok ? "done" : "failed"; }
    if (ev.type === "handoff") { addEdge(ev.from, ev.to && ev.to[0]); syncModels(); }
    syncModels();
  } else if (e.kind === "agent_event") {
    const ae = e.event, n = ensureM(ae.agentId);
    if (n) { if (["delta", "tool_call", "message", "thought"].includes(ae.type)) n.status = n.status === "done" ? "done" : "working"; if (ae.type === "error") n.status = "failed"; syncModels(); }
  } else if (e.kind === "usage") {
    for (const a of e.agents || []) { const n = mnodes.get(a.agentId); if (n) n.tokens = a.usage.inputTokens + a.usage.outputTokens; }
    syncModels();
  }
}

// setGraph rebuilds nodes/links, preserving positions of nodes that already existed (so live updates
// and mode re-entry don't teleport the layout).
function setGraph(rawNodes, rawEdges) {
  const before = nodes, prevLinks = links.length;
  const prev = new Map(nodes.map((n) => [n.id, n]));
  // Models mode: a handful of agents laid out on an even ring, not the file graph's degree-spiral —
  // with so few nodes the spiral put them at wildly different radii (looked scattered/random) and
  // physics spent every frame fighting to hold that shape. A fixed ring reads as "a team", stays put,
  // and leaves the pulses (drawn in render()) to carry the actual who's-talking-to-whom information.
  const ringR = rawNodes.length > 1 ? 70 + rawNodes.length * 22 : 0;
  const spread = Math.max(120, Math.sqrt(rawNodes.length) * 46);
  nodes = rawNodes.map((n, i) => {
    const old = prev.get(n.id);
    let x, y;
    // Models mode always recomputes the ring fresh (unless the user pinned it) — the ring's angle
    // per node depends on the CURRENT total, so keeping an old position from before the roster's
    // count last changed puts nodes at angles meant for a different-sized ring, and they collide.
    if (mode === "models" && !(old && old.pinned)) {
      const a = (i / rawNodes.length) * Math.PI * 2 - Math.PI / 2; x = Math.cos(a) * ringR; y = Math.sin(a) * ringR;
    } else if (old) { x = old.x; y = old.y; }
    else if (mode === "models") { const a = (i / rawNodes.length) * Math.PI * 2 - Math.PI / 2; x = Math.cos(a) * ringR; y = Math.sin(a) * ringR; }
    else { const a = i * 2.399963, R = spread * Math.sqrt(i + 1) / Math.sqrt(rawNodes.length + 1); x = Math.cos(a) * R; y = Math.sin(a) * R; }
    return {
      ...n, x, y,
      vx: 0, vy: 0, pinned: old ? old.pinned : false, hl: old ? old.hl : 1,
      deg: 0, r: 4,
    };
  });
  byId.clear(); nodes.forEach((n, i) => byId.set(n.id, i));
  links = [];
  for (const e of rawEdges) { const s = byId.get(e.from), t = byId.get(e.to); if (s !== undefined && t !== undefined && s !== t) links.push({ s, t }); }
  adj = nodes.map(() => new Set());
  for (const l of links) { adj[l.s].add(l.t); adj[l.t].add(l.s); nodes[l.s].deg++; nodes[l.t].deg++; }
  // Models-mode avatars are a fixed, readable size for every agent, lead included — the pixel
  // mascot isn't meant to shrink to a dot for a quiet agent the way a plain degree-sized circle
  // was, and a *different* fixed size for lead just made same-shaped sprites look inconsistent
  // side by side. Lead gets a ring around it instead (drawn in render()).
  for (const n of nodes) n.r = mode === "models" ? 20 : 4 + Math.sqrt(n.deg) * 2.4 + (n.lead ? 3 : 0);
  labelOrder = nodes.map((_, i) => i).sort((a, b) => nodes[b].r - nodes[a].r); // best-connected labels win collisions
  // every index into `nodes` shifts on a rebuild — re-resolve the live ones by id or drop them.
  const keep = (i) => { const id = i >= 0 && before[i] ? before[i].id : null; return id != null && byId.has(id) ? byId.get(id) : -1; };
  selected = keep(selected); hover = keep(hover); dragging = keep(dragging); lastFocus = -1;
  // a live tick that added nothing shouldn't re-explode a settled layout.
  reheat(nodes.length !== prev.size || links.length !== prevLinks || nodes.some((n) => !prev.has(n.id)) ? 1 : 0.06);
  applySearch(searchTerm);
  const s = `<b>${nodes.length}</b> nodes · <b>${links.length}</b> ${mode === "project" ? "imports" : "links"}`;
  if (q("stat").innerHTML !== s) q("stat").innerHTML = s;
}

// ---------- Barnes–Hut quadtree (approximate repulsion, O(n log n)) ----------
function buildTree(ns) {
  if (!ns.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of ns) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
  const size = Math.max(x1 - x0, y1 - y0) + 1;
  const root = { x: x0, y: y0, s: size, mass: 0, cx: 0, cy: 0, body: null, kids: null };
  for (const n of ns) insert(root, n, 0);
  return root;
}
// depth/size guard: coincident or near-coincident nodes would otherwise subdivide forever (the cell
// keeps splitting but never separates them). Past the guard we stop subdividing and just accumulate
// mass at the leaf's centre — Barnes–Hut treats it as one body, which is exactly what we want.
function insert(node, p, depth) {
  node.mass++; node.cx += (p.x - node.cx) / node.mass; node.cy += (p.y - node.cy) / node.mass;
  if (node.s < 1e-3 || depth > 48) return;
  if (!node.kids && !node.body) { node.body = p; return; }
  if (!node.kids) { node.kids = subdivide(node); const b = node.body; node.body = null; place(node, b, depth); }
  place(node, p, depth);
}
function subdivide(node) {
  const h = node.s / 2;
  return [
    { x: node.x, y: node.y, s: h, mass: 0, cx: 0, cy: 0, body: null, kids: null },
    { x: node.x + h, y: node.y, s: h, mass: 0, cx: 0, cy: 0, body: null, kids: null },
    { x: node.x, y: node.y + h, s: h, mass: 0, cx: 0, cy: 0, body: null, kids: null },
    { x: node.x + h, y: node.y + h, s: h, mass: 0, cx: 0, cy: 0, body: null, kids: null },
  ];
}
function place(node, p, depth) {
  const h = node.s / 2, i = (p.x >= node.x + h ? 1 : 0) + (p.y >= node.y + h ? 2 : 0);
  insert(node.kids[i], p, depth + 1);
}
function repulse(tree, p, k2, theta, out) {
  if (!tree || tree.mass === 0 || tree.body === p) return;
  let dx = p.x - tree.cx, dy = p.y - tree.cy, d2 = dx * dx + dy * dy;
  if (d2 < 1e-6) { dx = (Math.random() - 0.5) * 0.1; dy = (Math.random() - 0.5) * 0.1; d2 = dx * dx + dy * dy; }
  // A leaf (no children — a single body or an accumulated coincident cluster) or a cell far enough
  // to approximate → treat as one mass at its centre. Force is Fruchterman–Reingold's k²/d law:
  // out += (dx/d)·(k²·mass/d) = dx·(k²·mass/d²), a gentle 1/d falloff that spreads the graph.
  if (!tree.kids || (tree.s * tree.s) < theta * theta * d2) {
    const f = k2 * tree.mass / d2;
    out.x += dx * f; out.y += dy * f;
  } else {
    for (const c of tree.kids) repulse(c, p, k2, theta, out);
  }
}

// ---------- physics tick (Fruchterman–Reingold: k²/d repulsion, d²/k edge attraction) ----------
// Forces drive *velocity*, which is damped every step, not position directly. Position-driven FR
// overshoots equilibrium on every frame and buzzes there forever; damped velocity converges — and
// once alpha falls under alphaMin we freeze the sim outright so a settled graph is perfectly still.
let disp = new Float64Array(0);
const acc = { x: 0, y: 0 }; // reused: a per-node accumulator object per frame was pure GC churn
function tick() {
  const n = nodes.length;
  if (n === 0) return;
  // Models mode keeps its ring layout (see setGraph) — no file-graph physics fighting to hold a
  // shape that isn't a spring system. Dragging still works: pointermove sets position directly.
  if (mode === "models") { for (const p of nodes) { p.vx = 0; p.vy = 0; } sim.alpha = 0; return; }
  if (dragging >= 0) sim.alpha = Math.max(sim.alpha, sim.dragAlpha); // warm, not boiling
  if (sim.alpha < sim.alphaMin) { if (sim.alpha > 0) freeze(); return; } // settled — no work
  sim.alpha *= 1 - sim.alphaDecay;
  const a = sim.alpha;
  const k = sim.link;
  const krep = k * k * (sim.charge / 30); // repulsion strength, 1× at the default slider value
  const tree = buildTree(nodes);
  if (disp.length < n * 2) disp = new Float64Array(n * 2 + 128);

  for (let i = 0; i < n; i++) {
    acc.x = 0; acc.y = 0;
    repulse(tree, nodes[i], krep, 0.9, acc);
    disp[i * 2] = acc.x; disp[i * 2 + 1] = acc.y;
  }
  for (const l of links) { // edge attraction: pull toward each other with magnitude d²/k
    const s = nodes[l.s], t = nodes[l.t];
    const ex = t.x - s.x, ey = t.y - s.y, d = Math.hypot(ex, ey) || 1;
    const fa = d * 0.9 / k; // ex·fa = ux·d²/k·0.9
    disp[l.s * 2] += ex * fa; disp[l.s * 2 + 1] += ey * fa;
    disp[l.t * 2] -= ex * fa; disp[l.t * 2 + 1] -= ey * fa;
  }
  // Pull toward the centroid, normalised so the graph settles inside a disc of radius ≈ spread
  // whatever the node count and slider values. With a fixed constant it can't: repulsion falls off
  // as 1/d, so a degree-0 node parks at sqrt(krep·n / grav) — thousands of units out for a few dozen
  // files, which squashes the part you care about into a dot and makes "fit" frame mostly emptiness.
  let cx = 0, cy = 0; for (const p of nodes) { cx += p.x; cy += p.y; } cx /= n; cy /= n;
  const spread = Math.max(160, Math.sqrt(n) * 46);
  const grav = (sim.gravity / 6) * krep * n / (spread * spread);
  const cap = k * 0.5; // clamp on force magnitude, so one huge spring can't fling a node
  const vd = sim.velocityDecay;

  let vmax = 0;
  for (let i = 0; i < n; i++) {
    const p = nodes[i];
    if (i === dragging || p.pinned) { p.vx = 0; p.vy = 0; continue; }
    let gx = disp[i * 2] + (cx - p.x) * grav, gy = disp[i * 2 + 1] + (cy - p.y) * grav;
    const dl = Math.hypot(gx, gy);
    if (dl > cap) { const s = cap / dl; gx *= s; gy *= s; }
    p.vx = (p.vx + gx * a) * vd; p.vy = (p.vy + gy * a) * vd;
    p.x += p.vx; p.y += p.vy;
    const sp = p.vx * p.vx + p.vy * p.vy;
    if (sp > vmax) vmax = sp;
  }
  // Freeze on actual stillness, not just on a cold alpha: parking the layout while it's still
  // creeping means the next reheat resumes that leftover motion, and the whole graph lurches the
  // moment you touch one node. 0.05 world-units/frame is ~3/sec — invisible.
  if (dragging < 0 && vmax < 0.0025) freeze();
}
function freeze() { sim.alpha = 0; for (const p of nodes) { p.vx = 0; p.vy = 0; } }
function reheat(v = 1) { sim.alpha = Math.max(sim.alpha, v); }

// ---------- render ----------
// Everything time-based is driven by dt, so 60Hz and 120Hz displays behave identically: physics runs
// on a fixed 60Hz accumulator, camera and highlight fades use frame-rate-independent exponential easing.
const STEP = 1000 / 60;
let lastT = 0, physAcc = 0;
let dimAmt = 0, lastFocus = -1, fading = false, lastKey = "";

const ease = (dt, tau) => 1 - Math.exp(-dt / tau);

// A flick keeps coasting instead of stopping dead under your finger. glide is world-units/ms, so it
// stays honest across zoom levels and frame rates; it dies at 20 screen-px/s rather than asymptoting.
function glideStep(dt) {
  if (!glide) return;
  cam.cx += glide.x * dt; cam.cy += glide.y * dt;
  cam.tcx = cam.cx; cam.tcy = cam.cy;
  const d = Math.exp(-dt / 260);
  glide.x *= d; glide.y *= d;
  if (Math.hypot(glide.x, glide.y) * cam.k < 0.02) glide = null;
}
function easeCam(dt) {
  const s = ease(dt, 90);
  cam.cx += (cam.tcx - cam.cx) * s; cam.cy += (cam.tcy - cam.cy) * s; cam.k += (cam.tk - cam.k) * s;
  // snap once we're sub-pixel, otherwise the camera asymptotes forever and never counts as settled
  if (Math.abs(cam.tk - cam.k) < cam.tk * 2e-4) cam.k = cam.tk;
  if (Math.abs(cam.tcx - cam.cx) * cam.k < 0.02) cam.cx = cam.tcx;
  if (Math.abs(cam.tcy - cam.cy) * cam.k < 0.02) cam.cy = cam.tcy;
}
const camSettled = () => cam.cx === cam.tcx && cam.cy === cam.tcy && cam.k === cam.tk;

// hover/search highlighting fades instead of snapping: per-node `hl` for the nodes, one global
// `dimAmt` for the (batched) edges.
function updateFades(dt) {
  const s = ease(dt, 60);
  const focus = selected >= 0 ? selected : hover;
  if (focus >= 0) lastFocus = focus;
  const near = focus >= 0 ? adj[focus] : null;
  const dimT = focus >= 0 || searchHits.size > 0 ? 1 : 0;
  fading = Math.abs(dimT - dimAmt) > 0.002;
  dimAmt = fading ? dimAmt + (dimT - dimAmt) * s : dimT;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const want = (focus < 0 || i === focus || near.has(i)) && (searchHits.size === 0 || searchHits.has(i)) ? 1 : 0;
    const d = want - n.hl;
    if (Math.abs(d) > 0.002) { n.hl += d * s; fading = true; } else n.hl = want;
  }
}

// A fully settled project graph is a static image — redrawing it 60×/s just heats the laptop (and a
// throttled laptop is exactly what makes the next interaction feel laggy). Derived purely from state,
// so any change self-heals on the next frame; models mode is live, so it never idles.
function still() {
  if (mode !== "project") return false;
  if (sim.alpha !== 0 || dragging >= 0 || autoFit || autoCentre || fading || pulses.length || !camSettled()) return false;
  // the camera goes in the key, not just camSettled(): a drag-pan moves cam and target together, so
  // it stays "settled" the whole way and rendering would freeze mid-gesture.
  const key = `${hover}|${selected}|${searchTerm}|${showLabels}|${W}|${H}|${nodes.length}|${cam.cx},${cam.cy},${cam.k}|${overMini}`;
  if (key !== lastKey) { lastKey = key; return false; }
  return true;
}

function draw(now) {
  const dt = Math.min(64, now - lastT) || STEP; lastT = now;
  physAcc += dt;
  let steps = 0;
  while (physAcc >= STEP && steps < 4) { tick(); physAcc -= STEP; steps++; }
  if (steps === 4) physAcc = 0; // long frame / backgrounded tab: drop the backlog, don't spiral
  glideStep(dt); easeCam(dt);
  if (autoFit && nodes.length) { fitTarget(); if (sim.alpha === 0 && camSettled()) autoFit = false; }
  if (autoCentre && nodes.length) { recenterTarget(); if (sim.alpha === 0 && camSettled()) autoCentre = false; }
  updateFades(dt);
  if (!still()) render();
  requestAnimationFrame(draw);
}

function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2, H / 2); ctx.scale(cam.k, cam.k); ctx.translate(-cam.cx, -cam.cy);

  const focus = selected >= 0 ? selected : hover;
  // keep classifying against the last focus while the dim fades out, so un-hovering fades instead of snapping
  const fx = focus >= 0 ? focus : dimAmt > 0.01 && lastFocus < nodes.length ? lastFocus : -1;
  const hits = searchHits;
  const mix = (a, b) => Math.round(a + (b - a) * dimAmt);

  // edges: three batched paths (dim / normal / focused) — one stroke each instead of one per edge.
  // At dimAmt = 0 all three styles collapse to the same colour, so the transition is seamless.
  const pd = new Path2D(), pn = new Path2D(), pf = new Path2D(), pa = new Path2D();
  const wantArrows = mode === "project" && cam.k > 1.05;
  for (const l of links) {
    const s = nodes[l.s], t = nodes[l.t];
    const on = fx >= 0 && (l.s === fx || l.t === fx);
    const p = on ? pf : (fx < 0 && hits.size === 0) || hits.has(l.s) || hits.has(l.t) ? pn : pd;
    p.moveTo(s.x, s.y); p.lineTo(t.x, t.y);
    if (mode === "project" && (on || (wantArrows && p === pn))) arrow(pa, s, t, t.r);
  }
  ctx.lineWidth = 1 / cam.k;
  ctx.strokeStyle = `rgba(130,140,170,${0.22 - 0.17 * dimAmt})`; ctx.stroke(pd);
  ctx.strokeStyle = "rgba(130,140,170,0.22)"; ctx.stroke(pn);
  ctx.lineWidth = (1 + 0.6 * dimAmt) / cam.k;
  ctx.strokeStyle = `rgba(${mix(130, 167)},${mix(140, 139)},${mix(170, 250)},${0.22 + 0.33 * dimAmt})`; ctx.stroke(pf);
  ctx.fillStyle = `rgba(${ACCENT_RGB},0.5)`; ctx.fill(pa);

  // message pulses (models mode) — keyed by id, since indices shift on every live rebuild
  const now = performance.now();
  if (pulses.length) pulses = pulses.filter((p) => now - p.born < 1600);
  for (const p of pulses) {
    const s = nodes[byId.get(p.a)], t = nodes[byId.get(p.b)]; if (!s || !t) continue;
    const tt = (now - p.born) / 1600;
    ctx.globalAlpha = 1 - tt; ctx.fillStyle = p.color;
    const mx = s.x + (t.x - s.x) * tt, my = s.y + (t.y - s.y) * tt;
    ctx.beginPath(); ctx.arc(mx, my, 3 / cam.k, 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // nodes (off-screen ones cost nothing when zoomed in)
  const v0 = toWorld(-40, -40), v1 = toWorld(W + 40, H + 40);
  const vis = (n) => n.x + n.r > v0.x && n.x - n.r < v1.x && n.y + n.r > v0.y && n.y - n.r < v1.y;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!vis(n)) continue;
    const alpha = 1 - (1 - n.hl) * 0.84;
    ctx.globalAlpha = alpha;
    if (i === hover || i === selected || hits.has(i)) {
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 4 / cam.k, 0, 7);
      ctx.fillStyle = `rgba(${ACCENT_RGB},0.20)`; ctx.fill();
    }
    if (mode === "models") {
      // Agent identity is the pixel avatar's color/face now, not a plain fill — no border, per the
      // mascot reference art. Status moves to a small dot instead of the old fill color.
      drawPixelAvatar(ctx, n.x, n.y, n.r * 2, n.colorIndex);
      if (n.lead) { ctx.lineWidth = 2 / cam.k; ctx.strokeStyle = ACCENT; ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 5 / cam.k, 0, 7); ctx.stroke(); }
      ctx.fillStyle = STATUS_FILL[n.status] || STATUS_FILL.idle;
      ctx.beginPath(); ctx.arc(n.x + n.r * 0.7, n.y - n.r * 0.7, 4 / cam.k, 0, 7); ctx.fill();
    } else {
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 7);
      ctx.fillStyle = n.color || MUTED; ctx.fill();
      if (n.lead) { ctx.lineWidth = 2 / cam.k; ctx.strokeStyle = "#fff"; ctx.stroke(); }
      else if (n.pinned) { ctx.lineWidth = 1 / cam.k; ctx.strokeStyle = "rgba(231,233,242,0.45)"; ctx.stroke(); }
    }
    if (n.status === "working") {
      const pw = (now % 1200) / 1200;
      ctx.globalAlpha = (1 - pw) * alpha; ctx.strokeStyle = STATUS_FILL.working; ctx.lineWidth = 2 / cam.k;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r + (2 + pw * 7) / cam.k, 0, 7); ctx.stroke();
    }
  }

  // Labels last, so nodes never overdraw them; font set once per frame, not once per label. Biggest
  // nodes claim their space first and anything that would collide is dropped — in a dense core every
  // label drawn on top of every other one is just noise. Zoom in and the boxes separate.
  // ponytail: O(labels × placed) box scan, fine to a few hundred labels; grid-bucket it past that.
  const zoomA = Math.min(1, Math.max(0, (cam.k - 0.62) / 0.28)); // fade in with zoom instead of popping
  if (showLabels) {
    ctx.font = `${11 / cam.k}px ui-monospace, monospace`;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const boxes = [];
    // two passes so a dimmed label can never claim the space a highlighted one needs
    for (const pass of [1, 0]) for (const i of labelOrder) {
      const n = nodes[i];
      if ((n.hl > 0.5 ? 1 : 0) !== pass || !vis(n)) continue;
      const forced = i === hover || i === selected;
      const a = (1 - (1 - n.hl) * 0.84) * (forced || n.r > 8 ? 1 : zoomA);
      if (a < 0.03) continue;
      const p = toScreen(n.x, n.y), w = n.label.length * 6.7, top = p.y + (n.r + 2) * cam.k;
      const b = { x0: p.x - w / 2, y0: top, x1: p.x + w / 2, y1: top + 12 };
      if (!forced && boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0)) continue;
      boxes.push(b);
      ctx.globalAlpha = a;
      ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillText(n.label, n.x + 0.6 / cam.k, n.y + n.r + 2.6 / cam.k);
      ctx.fillStyle = INK; ctx.fillText(n.label, n.x, n.y + n.r + 2 / cam.k);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  drawMinimap();
}
function arrow(path, s, t, rT) {
  const dx = t.x - s.x, dy = t.y - s.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
  const ax = t.x - ux * (rT + 2 / cam.k), ay = t.y - uy * (rT + 2 / cam.k), a = 5 / cam.k;
  path.moveTo(ax, ay);
  path.lineTo(ax - ux * a + -uy * a * 0.6, ay - uy * a + ux * a * 0.6);
  path.lineTo(ax - ux * a - -uy * a * 0.6, ay - uy * a - ux * a * 0.6);
  path.closePath();
}
// One source of truth for the minimap's placement and world↔minimap scale, so drawing it and
// clicking it can't disagree. Sits on free.y1 rather than the window bottom — the stat panel is a DOM
// element on top of the canvas, and anything under it would swallow the clicks.
function miniRect() {
  if (nodes.length < 12) return null;
  const w = 150, h = 110, pad = 8, x = W - w - 14, y = free.y1 - h;
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const n of nodes) { a = Math.min(a, n.x); b = Math.min(b, n.y); c = Math.max(c, n.x); d = Math.max(d, n.y); }
  const sc = Math.min((w - pad * 2) / (c - a || 1), (h - pad * 2) / (d - b || 1));
  return { x, y, w, h, pad, a, b, sc };
}
const inMini = (m, sx, sy) => !!m && sx >= m.x && sx <= m.x + m.w && sy >= m.y && sy <= m.y + m.h;
const miniToWorld = (m, sx, sy) => ({ x: m.a + (sx - m.x - m.pad) / m.sc, y: m.b + (sy - m.y - m.pad) / m.sc });

function drawMinimap() {
  const m = miniRect(); if (!m) return;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = "rgba(13,15,22,0.7)"; ctx.strokeStyle = overMini ? `rgba(${ACCENT_RGB},0.55)` : "rgba(38,43,61,1)";
  roundRect(m.x, m.y, m.w, m.h, 8); ctx.fill(); ctx.stroke();
  ctx.globalAlpha = 0.5;
  for (const n of nodes) {
    ctx.fillStyle = n.color || MUTED;
    ctx.fillRect(m.x + m.pad + (n.x - m.a) * m.sc - 0.7, m.y + m.pad + (n.y - m.b) * m.sc - 0.7, 1.6, 1.6);
  }
  ctx.globalAlpha = 1;
  // viewport rectangle — filled, so it reads as the handle you can grab. Clipped to the frame:
  // zoomed out far enough the viewport is bigger than the whole map and would spill onto the canvas.
  const tl = toWorld(0, 0), br = toWorld(W, H);
  const vx = m.x + m.pad + (tl.x - m.a) * m.sc, vy = m.y + m.pad + (tl.y - m.b) * m.sc;
  ctx.save();
  roundRect(m.x, m.y, m.w, m.h, 8); ctx.clip();
  ctx.fillStyle = `rgba(${ACCENT_RGB},0.10)`; ctx.fillRect(vx, vy, (br.x - tl.x) * m.sc, (br.y - tl.y) * m.sc);
  ctx.strokeStyle = `rgba(${ACCENT_RGB},0.8)`; ctx.lineWidth = 1; ctx.strokeRect(vx, vy, (br.x - tl.x) * m.sc, (br.y - tl.y) * m.sc);
  ctx.restore();
}
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

// ---------- camera helpers ----------
// The screen area that isn't behind a floating panel — "fit" centres the graph in what the user can
// actually see, not behind the 250px control column. Measured on resize/fit only (layout reads are
// expensive, and the panels are fixed-size).
let free = { x0: 20, y0: 80, x1: 400, y1: 400 };
function measureFree() {
  const c = q("controls").getBoundingClientRect(), t = q("topbar").getBoundingClientRect();
  free = { x0: 20, y0: t.bottom + 14, x1: Math.max(160, c.left - 14), y1: H - 68 };
}
// Put a world point at the centre of the free area, not at the centre of the window — the camera
// looks at (cx,cy) through the window centre, so the offset has to be baked into the target.
function centreOn(wx, wy, k = cam.tk) {
  cam.tk = k;
  cam.tcx = wx + (W / 2 - (free.x0 + free.x1) / 2) / k;
  cam.tcy = wy + (H / 2 - (free.y0 + free.y1) / 2) / k;
}
function fitTarget() {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const n of nodes) { a = Math.min(a, n.x - n.r); b = Math.min(b, n.y - n.r); c = Math.max(c, n.x + n.r); d = Math.max(d, n.y + n.r); }
  const vw = Math.max(120, free.x1 - free.x0), vh = Math.max(120, free.y1 - free.y0);
  centreOn((a + c) / 2, (b + d) / 2, Math.min(4, Math.max(0.04, 0.92 * Math.min(vw / (c - a || 1), vh / (d - b || 1)))));
}
// The target is recomputed every frame until the layout stops moving — a one-shot target computed
// while the sim is still hot (which is exactly what "Re-center" does) is stale before you arrive.
function fit(animate = true) {
  if (!nodes.length) return;
  glide = null;
  measureFree(); fitTarget(); autoFit = true;
  if (!animate) { cam.cx = cam.tcx; cam.cy = cam.tcy; cam.k = cam.tk; }
}
// Same idea as fitTarget, but holds the zoom the user already set — only the centre moves.
function recenterTarget() {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const n of nodes) { a = Math.min(a, n.x - n.r); b = Math.min(b, n.y - n.r); c = Math.max(c, n.x + n.r); d = Math.max(d, n.y + n.r); }
  centreOn((a + c) / 2, (b + d) / 2, cam.k);
}
function recenter(animate = true) {
  if (!nodes.length) return;
  glide = null;
  measureFree(); recenterTarget(); autoCentre = true;
  if (!animate) { cam.cx = cam.tcx; cam.cy = cam.tcy; cam.k = cam.tk; }
}
function pickNode(sx, sy) {
  const w = toWorld(sx, sy); let best = -1, bd = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i], dx = n.x - w.x, dy = n.y - w.y, d = Math.hypot(dx, dy);
    if (d < n.r + 6 / cam.k && d < bd) { bd = d; best = i; }
  }
  return best;
}

// ---------- interaction: pointer (mouse + touch), wheel, pinch ----------
const pointers = new Map();
let panLast = null, pinchDist = 0, miniDrag = false;
const grab = { x: 0, y: 0 }; // cursor→node offset, so a node doesn't jump to centre itself on grab
const panV = { x: 0, y: 0 }; // smoothed pan speed in screen px/ms, for the flick-to-glide handoff
let panT = 0;
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  autoFit = autoCentre = false; glide = null; // any manual camera move cancels an in-flight fit or coast
  if (pointers.size === 2) { pinchDist = twoDist(); dragging = -1; panLast = null; miniDrag = false; return; }
  const m = miniRect();
  if (inMini(m, e.clientX, e.clientY)) { // jump to where you clicked on the map, then track 1:1
    miniDrag = true; hideTip(); hover = -1;
    const w = miniToWorld(m, e.clientX, e.clientY); centreOn(w.x, w.y);
    return;
  }
  const hit = pickNode(e.clientX, e.clientY);
  if (hit >= 0) {
    const w = toWorld(e.clientX, e.clientY);
    dragging = hit; selected = hit; grab.x = nodes[hit].x - w.x; grab.y = nodes[hit].y - w.y;
    nodes[hit].pinned = true; reheat(sim.dragAlpha);
    canvas.style.cursor = "grabbing";
  } else {
    selected = -1; panLast = { x: e.clientX, y: e.clientY }; canvas.style.cursor = "grabbing";
    panV.x = panV.y = 0; panT = performance.now();
  }
});
canvas.addEventListener("pointermove", (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) { // pinch zoom — direct manipulation, so no easing lag
    const nd = twoDist(); if (pinchDist) zoomAt(centerX(), centerY(), nd / pinchDist, true); pinchDist = nd; return;
  }
  if (miniDrag) {
    const m = miniRect();
    if (m) { const w = miniToWorld(m, e.clientX, e.clientY); centreOn(w.x, w.y); cam.cx = cam.tcx; cam.cy = cam.tcy; }
    return;
  }
  if (dragging >= 0) {
    const w = toWorld(e.clientX, e.clientY), n = nodes[dragging];
    n.x = w.x + grab.x; n.y = w.y + grab.y; n.vx = n.vy = 0; reheat(sim.dragAlpha);
    moveTip(e.clientX, e.clientY); return;
  }
  if (panLast) {
    const dx = e.clientX - panLast.x, dy = e.clientY - panLast.y;
    cam.cx -= dx / cam.k; cam.cy -= dy / cam.k;
    cam.tcx = cam.cx; cam.tcy = cam.cy; panLast = { x: e.clientX, y: e.clientY };
    const t = performance.now(), dt = Math.max(1, t - panT); panT = t;
    panV.x = panV.x * 0.6 + (dx / dt) * 0.4; panV.y = panV.y * 0.6 + (dy / dt) * 0.4;
    return;
  }
  const overM = inMini(miniRect(), e.clientX, e.clientY);
  if (overM !== overMini) overMini = overM;
  if (overM) { hover = -1; hideTip(); canvas.style.cursor = "pointer"; return; } // don't pick nodes through the map
  const h = pickNode(e.clientX, e.clientY);
  hover = h;
  if (h >= 0) showTip(h, e.clientX, e.clientY); else hideTip();
  canvas.style.cursor = h >= 0 ? "pointer" : "grab";
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  // hand a flick off to the glide, but only if the pointer was actually moving when it lifted —
  // panning to a spot, pausing, then releasing must stop exactly where you left it.
  if (panLast && performance.now() - panT < 90 && Math.hypot(panV.x, panV.y) > 0.06) {
    glide = { x: -panV.x / cam.k, y: -panV.y / cam.k };
  }
  dragging = -1; panLast = null; miniDrag = false; if (pointers.size < 2) pinchDist = 0;
  canvas.style.cursor = hover >= 0 ? "pointer" : "grab";
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
// moving off the canvas onto a panel otherwise leaves the tooltip and the hover highlight stuck on
canvas.addEventListener("pointerleave", () => { if (dragging < 0 && !miniDrag) { hover = -1; overMini = false; hideTip(); } });
canvas.addEventListener("dblclick", (e) => {
  if (inMini(miniRect(), e.clientX, e.clientY)) return; // don't unpin whatever happens to sit under the map
  const h = pickNode(e.clientX, e.clientY);
  if (h >= 0) { nodes[h].pinned = false; reheat(0.3); } else fit(true);
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1); // lines / pages → pixels
  zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.0015));
}, { passive: false });

// Anchors the zoom on the *target* camera, so repeated wheel notches compose into one smooth eased
// zoom that still lands with the cursor over the same point.
function zoomAt(sx, sy, factor, snap) {
  autoFit = autoCentre = false; glide = null;
  const k0 = cam.tk, k1 = Math.min(8, Math.max(0.04, k0 * factor));
  if (k1 === k0) return;
  const wx = cam.tcx + (sx - W / 2) / k0, wy = cam.tcy + (sy - H / 2) / k0;
  cam.tk = k1; cam.tcx = wx - (sx - W / 2) / k1; cam.tcy = wy - (sy - H / 2) / k1;
  if (snap) { cam.k = cam.tk; cam.cx = cam.tcx; cam.cy = cam.tcy; }
}
function twoDist() { const p = [...pointers.values()]; return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); }
function centerX() { const p = [...pointers.values()]; return (p[0].x + p[1].x) / 2; }
function centerY() { const p = [...pointers.values()]; return (p[0].y + p[1].y) / 2; }

// ---------- tooltip ----------
const tip = q("tip");
function showTip(i, x, y) {
  const n = nodes[i];
  const sub = mode === "project" ? esc(n.id) : `${esc(n.status || "idle")}${n.tokens ? " · " + n.tokens.toLocaleString() + " tok" : ""}${n.lead ? " · orchestrator" : ""}`;
  tip.innerHTML = `<div class="t">${esc(n.label)}</div><div class="s">${sub} · ${n.deg} link${n.deg === 1 ? "" : "s"}</div>`;
  tip.classList.add("show"); moveTip(x, y);
}
function moveTip(x, y) { tip.style.left = Math.min(x + 14, W - tip.offsetWidth - 8) + "px"; tip.style.top = (y + 16) + "px"; }
function hideTip() { tip.classList.remove("show"); }

// ---------- search ----------
function applySearch(term) {
  searchHits = new Set();
  searchTerm = term.trim().toLowerCase();
  if (!searchTerm) return;
  nodes.forEach((n, i) => { if (n.label.toLowerCase().includes(searchTerm) || (n.id && n.id.toLowerCase().includes(searchTerm))) searchHits.add(i); });
}
function flyToSearch() {
  if (!searchHits.size) return;
  let best = -1, bd = -1;
  for (const i of searchHits) if (nodes[i].deg > bd) { bd = nodes[i].deg; best = i; }
  if (best >= 0) { selected = best; autoFit = autoCentre = false; glide = null; centreOn(nodes[best].x, nodes[best].y, Math.max(cam.k, 1.4)); }
}

// ---------- UI wiring ----------
function setMode(m) {
  if (m === mode && nodes.length) return;
  mode = m;
  document.querySelectorAll("#mode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  selected = hover = -1; pulses = [];
  // Fetching the new mode's data is async — clear the old mode's nodes/links right away instead of
  // leaving them in place until the fetch resolves. Otherwise render() draws for a frame or two with
  // `mode` already flipped but `nodes` still holding the OTHER mode's data (e.g. plain file nodes
  // with no colorIndex, drawn through the pixel-avatar path) — a real race that only shows up when
  // the switch is fast, which crashed the render loop and froze the canvas on a stale frame.
  setGraph([], []);
  if (m === "project") { loadProject().then(() => fit(false)); }
  else { loadModels(); setTimeout(() => fit(false), 60); }
}
document.querySelectorAll("#mode button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
q("fit").addEventListener("click", () => fit(true));
// unpin everything and let the layout relax back — a partial reheat, since a full one throws the
// graph across the screen and then makes you wait for it to settle again.
q("reset").addEventListener("click", () => { for (const n of nodes) n.pinned = false; reheat(0.5); recenter(true); });
q("search").addEventListener("input", (e) => applySearch(e.target.value));
q("search").addEventListener("keydown", (e) => { if (e.key === "Enter") flyToSearch(); if (e.key === "Escape") { e.target.value = ""; applySearch(""); e.target.blur(); } });
q("t-labels").addEventListener("change", (e) => { showLabels = e.target.checked; });
bindSlider("s-link", "v-link", "link"); bindSlider("s-charge", "v-charge", "charge"); bindSlider("s-grav", "v-grav", "gravity");
function bindSlider(sid, vid, key) { const s = q(sid); s.addEventListener("input", () => { sim[key] = +s.value; q(vid).textContent = s.value; reheat(); }); }

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === "1") setMode("project");
  else if (e.key === "2") setMode("models");
  else if (e.key === "f") fit(true);
  else if (e.key === "/") { e.preventDefault(); q("search").focus(); }
  else if (e.key === "Escape") { selected = -1; q("search").value = ""; applySearch(""); }
});

function buildLegend(items, title) {
  q("legend").innerHTML = `<div class="title">${esc(title)}</div>` +
    items.slice(0, 14).map((it) => `<span class="k"><i style="background:${esc(it.color)}"></i>${esc(it.label)}</span>`).join("");
}
function setConn(text, cls) { const c = q("conn"); c.textContent = text; c.className = cls; }
// Quotes too: buildLegend interpolates a colour into a style="…" attribute, where escaping only
// angle brackets still lets a crafted value close the attribute. Agent ids and task text reach
// this page from the model, and the page's URL carries the token.
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// A theme switch (this page's own dropdown, the TUI's ctrl+t, or another open tab) re-reads the CSS
// vars and re-derives every color, then repaints in place — group/status colors were assigned once
// at load time onto each node, so they need reassigning, not just a redraw.
function recolorTheme() {
  refreshGraphTheme();
  refreshAvatarColors();
  if (mode === "project") {
    const gi = new Map(); let gc = 0;
    for (const n of nodes) { if (!gi.has(n.group)) gi.set(n.group, PALETTE[gc++ % PALETTE.length]); n.color = gi.get(n.group); }
    buildLegend([...gi.entries()].map(([g, c]) => ({ label: g, color: c })), "directories");
  } else {
    syncModels();
    buildLegend(Object.entries(STATUS_FILL).map(([k, c]) => ({ label: k, color: c })), "agent status");
  }
  render(); // still() can skip idle frames in project mode — repaint now, don't wait for motion
}
document.addEventListener("niti-theme", recolorTheme);

// ---------- boot ----------
resize();
connectEvents();
loadProject().then(() => fit(false));
requestAnimationFrame(draw);
