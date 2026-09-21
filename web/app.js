"use strict";
// niti live dashboard — a self-contained SSE consumer + hand-rolled canvas force graph.
// No external libraries, no network beyond this origin's /events stream (CSP-friendly).

const params = new URLSearchParams(location.search);
const TOKEN = params.get("token") || "";
// Theme-derived (avatar.js's themeColors(), loaded first) — see graph.js's identical setup for why.
let KIND_COLORS, STATUS_FILL, INK, MUTED, ACCENT;
function refreshAppTheme() {
  const t = themeColors();
  KIND_COLORS = { question: t.amber, answer: t.green, handoff: t.blue, artifact: t.blue, review: t.pink, broadcast: t.violet };
  STATUS_FILL = { idle: t.muted, working: t.blue, done: t.green, failed: t.red };
  INK = t.ink; MUTED = t.muted; ACCENT = t.violet;
}
refreshAppTheme();
const PULSE_MS = 2200;
const AVATAR_R = 20; // every agent's pixel avatar is this size, no exceptions — lead is a ring around it, not a bigger sprite

const $ = (id) => document.getElementById(id);
const nodes = new Map(); // id -> {id,label,role,lead,x,y,vx,vy,status,activity,tokens}
let tasks = [];
const messages = [];
let pulses = []; // {from,to,kind,born}
let totals = { inputTokens: 0, outputTokens: 0, calls: 0 };
const usageByAgent = new Map();
let running = false; // session state — gates the "new goal" prompt bar
let openAgentId = null; // which node's detail panel is open, if any
let pendingApprovals = []; // the FIFO queue's current snapshot — same one the TUI answers from

// ---------- graph nodes ----------
// Pseudo-senders, not teammates: "system" announces file edits made outside niti (engine.ts's
// watcher), "orchestrator" announces undo/rewind — neither is a configured agent.
const NON_AGENT_IDS = new Set(["system", "orchestrator"]);
function ensureNode(id, role, lead) {
  if (id === "*" || NON_AGENT_IDS.has(id)) return null;
  let n = nodes.get(id);
  if (!n) {
    const angle = nodes.size * 1.3;
    n = {
      id,
      label: id,
      role: role || id,
      lead: !!lead,
      colorIndex: nodes.size, // first-seen roster position — the pixel avatar's stable identity color/face
      x: 0.5 + 0.28 * Math.cos(angle),
      y: 0.5 + 0.28 * Math.sin(angle),
      vx: 0,
      vy: 0,
      status: "idle",
      activity: "",
      tokens: 0,
      log: [], // full event history for this agent — the click-to-inspect panel's transcript
      pending: "", // streamed text not yet newline-terminated (see feedDelta)
    };
    nodes.set(id, n);
  }
  if (role) n.role = role;
  if (lead) n.lead = true;
  return n;
}

function pulse(from, to, kind) {
  const targets = to === "*" ? [...nodes.keys()].filter((k) => k !== from) : [to];
  for (const t of targets) if (nodes.has(from) && nodes.has(t)) pulses.push({ from, to: t, kind, born: performance.now() });
}

// ---------- SSE ----------
function connect() {
  const conn = $("conn");
  // No `from=0`: EventSource resends Last-Event-ID on reconnect and the server honours it, so a
  // blip replays only what was missed instead of the whole 2000-event buffer.
  const es = new EventSource(`/events?token=${encodeURIComponent(TOKEN)}`);
  let everOpened = false;
  es.onopen = () => { everOpened = true; conn.textContent = ""; };
  es.onerror = () => {
    // A bad/absent token and an unplugged network both land here, and "reconnecting…" forever is
    // a miserable way to learn the URL was missing its ?token=. If we never once connected, the
    // token is the overwhelmingly likely cause — say so instead of retrying silently.
    if (!everOpened) {
      conn.textContent = TOKEN ? "unauthorized — check the ?token= in this URL" : "no token in this URL";
      conn.className = "conn dead";
      return;
    }
    conn.textContent = "reconnecting…";
    conn.className = "conn dead";
  };
  es.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch { return; }
    handle(e);
  };
}

function handle(e) {
  switch (e.kind) {
    case "session":
      running = e.state === "started";
      setPromptEnabled();
      if (e.state === "cancelled") $("conn").textContent = "cancelled";
      break;
    case "approval_request":
      pendingApprovals = e.requests || [];
      renderApproval();
      break;
    case "orchestration":
      onOrch(e.event);
      break;
    case "agent_message": {
      const m = e.message;
      ensureNode(m.from);
      if (m.to !== "*") ensureNode(m.to);
      pulse(m.from, m.to, m.kind);
      messages.unshift(m);
      if (messages.length > 200) messages.pop();
      renderMessages();
      break;
    }
    case "agent_event":
      onAgentEvent(e.event);
      break;
    case "usage":
      totals = e.totals;
      for (const a of e.agents) usageByAgent.set(a.agentId, a.usage);
      for (const a of e.agents) { const n = nodes.get(a.agentId); if (n) n.tokens = a.usage.inputTokens + a.usage.outputTokens; }
      renderUsage();
      break;
  }
}

function onOrch(ev) {
  switch (ev.type) {
    case "plan":
      tasks = ev.tasks.map((t) => ({ ...t, status: "pending" }));
      for (const t of ev.tasks) ensureNode(t.role);
      renderTasks();
      break;
    case "task_started": {
      const n = nodes.get(ev.role);
      if (n) n.status = "working";
      setTaskStatus(ev.taskId, "in_progress");
      if (openAgentId === ev.role) renderAgentPanel(); // enables the mid-task message box
      break;
    }
    case "task_done": {
      const n = nodes.get(ev.role);
      if (n) n.status = ev.ok ? "done" : "failed";
      setTaskStatus(ev.taskId, ev.ok ? "done" : "failed");
      if (openAgentId === ev.role) renderAgentPanel(); // disables it again once the task ends
      break;
    }
    case "handoff": pulse(ev.from, ev.to?.[0] ?? "*", "handoff"); break;
    // Not unconditionally 100: a cancelled or partly-failed run leaves tasks unfinished, and
    // claiming completion there is the UI lying about the work.
    case "complete":
      for (const n of nodes.values()) if (n.status === "working") n.status = "idle";
      break;
    // The core has always emitted these; the dashboard ignored them, so a silently-rejected review
    // or a replan looked like a task that simply failed.
    case "review": {
      // ensureNode returns null for non-agent ids (orchestrator, system) — pushLog would throw on
      // it and take the whole event handler down with it.
      const rn = ensureNode(ev.reviewer);
      if (rn) pushLog(rn, `[review] ${ev.phase} ${ev.taskId}`);
      if (ev.phase === "changes_requested") setTaskStatus(ev.taskId, "in_progress");
      break;
    }
    case "replan": {
      const pn = ensureNode(ev.role);
      if (pn) pushLog(pn, `[replan] ${ev.taskId}: ${ev.action}${ev.reason ? " — " + ev.reason : ""}`);
      break;
    }
  }
}

function onAgentEvent(ae) {
  const n = ensureNode(ae.agentId);
  if (!n) return;
  if (ae.type === "delta" || ae.type === "tool_call" || ae.type === "message" || ae.type === "thought") n.status = n.status === "done" ? "done" : "working";
  if (ae.type === "done") n.status = n.status === "failed" ? "failed" : (n.status === "done" ? "done" : "idle");
  if (ae.type === "error") n.status = "failed";
  if (ae.payload && ae.type !== "delta") n.activity = ae.payload.slice(0, 60);

  // Full transcript for the click-to-inspect panel — streamed text accumulates until a newline
  // (mirrors the TUI's feedDelta), everything else is one line per event.
  if (ae.type === "delta") {
    feedDelta(n, ae.payload);
  } else if (ae.payload) {
    pushLog(n, `[${ae.type}] ${ae.payload}`);
  }
  if (openAgentId === ae.agentId) renderAgentPanel();
}

function pushLog(n, line) {
  n.log.push(line);
  if (n.log.length > 300) n.log.shift();
}

function feedDelta(n, chunk) {
  n.pending += chunk;
  const lines = n.pending.split("\n");
  n.pending = lines.pop();
  for (const l of lines) if (l) pushLog(n, l);
}

// ---------- panels ----------
function setTaskStatus(id, st) { const t = tasks.find((x) => x.id === id); if (t) { t.status = st; renderTasks(); } }

function renderTasks() {
  const el = $("tab-tasks");
  if (!tasks.length) { el.innerHTML = '<div class="empty">No plan yet.</div>'; return; }
  el.innerHTML = tasks
    .map(
      (t) => `<div class="task"><div class="row"><span class="id">${esc(t.id)}</span>
        <span class="st ${esc(t.status)}">${esc(String(t.status ?? "").replace("_", " "))}</span></div>
        <div class="who">→ ${esc(t.role)}</div>
        <div class="desc">${esc(t.description)}</div>
        ${t.dependsOn && t.dependsOn.length ? `<div class="deps">depends on ${esc(t.dependsOn.join(", "))}</div>` : ""}</div>`,
    )
    .join("");
}

function renderMessages() {
  const el = $("tab-messages");
  if (!messages.length) { el.innerHTML = '<div class="empty">No agent-to-agent messages yet.</div>'; return; }
  el.innerHTML = messages
    .map(
      (m) => `<div class="msg kind-${esc(m.kind)}"><div class="h">${esc(m.from)} → ${esc(m.to)} · ${esc(m.kind)}</div>
        <div class="sub">${esc(m.subject)}</div></div>`,
    )
    .join("");
}

function renderUsage() {
  const el = $("tab-usage");
  const rows = [...usageByAgent.entries()]
    .map(([id, u]) => `<div class="urow"><span class="n">${esc(id)}</span><span>${(u.inputTokens + u.outputTokens).toLocaleString()} tok · ${u.calls} calls</span></div>`)
    .join("");
  el.innerHTML =
    (rows || '<div class="empty">No usage yet.</div>') +
    `<div class="utotal urow"><span>total</span><span>${(totals.inputTokens + totals.outputTokens).toLocaleString()} tok · ${totals.calls} calls</span></div>`;
}

// Escapes quotes as well as angle brackets: several of the call sites below interpolate into an
// attribute (class="…"), where &lt;/&gt; alone would not stop an injected value from closing the
// attribute and adding its own. This page's URL carries the god-token, so an injected script here
// reads it out of location.search.
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const authedFetch = (path, body) =>
  fetch(`${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

// ---------- click-to-inspect agent panel ----------
function openAgentPanel(id) {
  openAgentId = id;
  $("agent-panel").classList.remove("hidden");
  $("ap-model-status").textContent = "";
  $("ap-msg-status").textContent = "";
  renderAgentPanel();
}
function closeAgentPanel() {
  openAgentId = null;
  $("agent-panel").classList.add("hidden");
}
function renderAgentPanel() {
  const n = nodes.get(openAgentId);
  if (!n) return closeAgentPanel();
  $("ap-title").textContent = `${n.role} (${n.id}) — ${n.status}`;
  const lines = n.pending ? [...n.log, n.pending] : n.log;
  const log = $("ap-log");
  log.innerHTML = lines.length ? lines.map((l) => `<div>${esc(l)}</div>`).join("") : '<div class="empty">nothing yet</div>';
  log.scrollTop = log.scrollHeight;
  // Mid-task messaging only makes sense while the agent is actually running — the server enforces
  // this too (409 otherwise), this just avoids a click that's guaranteed to fail.
  const canMessage = n.status === "working";
  $("ap-msg-input").disabled = !canMessage;
  $("ap-msg-send").disabled = !canMessage;
}
$("ap-close").addEventListener("click", closeAgentPanel);

// ---------- mid-task agent messaging (POST /agents/:id/message) ----------
async function sendAgentMessage() {
  const id = openAgentId;
  const text = $("ap-msg-input").value.trim();
  if (!id || !text) return;
  const res = await authedFetch(`/agents/${encodeURIComponent(id)}/message`, { text });
  if (res.ok) {
    $("ap-msg-input").value = "";
    $("ap-msg-status").textContent = "sent";
  } else {
    const e = await res.json().catch(() => ({}));
    $("ap-msg-status").textContent = e.error || "failed";
  }
}
$("ap-msg-send").addEventListener("click", sendAgentMessage);
$("ap-msg-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendAgentMessage(); });

// ---------- live model swap (POST /model, same route the TUI's ctrl+p carousel uses) ----------
$("ap-model-apply").addEventListener("click", async () => {
  const id = openAgentId;
  const raw = $("ap-model-input").value.trim();
  if (!id || !raw) return;
  const slash = raw.indexOf("/");
  const provider = slash > 0 ? raw.slice(0, slash) : "";
  const model = slash > 0 ? raw.slice(slash + 1) : raw;
  const res = await authedFetch("/model", { agentId: id, provider, model });
  if (res.ok) {
    $("ap-model-input").value = "";
    $("ap-model-status").textContent = `switched to ${raw}`;
  } else {
    const e = await res.json().catch(() => ({}));
    $("ap-model-status").textContent = e.error || "switch failed";
  }
});

// ---------- tool-approval popup (POST /approval — the same FIFO queue the TUI answers from, so
// answering here unblocks a concurrently open TUI session and vice versa) ----------
function renderApproval() {
  const el = $("approval-overlay");
  if (!pendingApprovals.length) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const r = pendingApprovals[0];
  const path = r.input && typeof r.input.path === "string" ? ` on ${r.input.path}` : "";
  $("approval-head").textContent = `${r.agentId} wants to run ${r.tool}${path}`;
  const diff = r.input && typeof r.input.diff === "string" ? r.input.diff : "";
  $("approval-diff").innerHTML = diff
    ? diff.split("\n").map((l) => `<div class="${l.startsWith("+") ? "plus" : l.startsWith("-") ? "minus" : l.startsWith("@@") ? "hunk" : ""}">${esc(l)}</div>`).join("")
    : `<div class="empty">${esc(JSON.stringify(r.input ?? {}))}</div>`;
}
function answerApproval(ok, scope) {
  authedFetch("/approval", { ok, scope }).catch(() => {});
  pendingApprovals = pendingApprovals.slice(1); // mirrors the TUI: pop locally, don't wait on the round trip
  renderApproval();
}
$("approval-yes").addEventListener("click", () => answerApproval(true));
$("approval-always").addEventListener("click", () => answerApproval(true, "agent"));
$("approval-no").addEventListener("click", () => answerApproval(false));

// ---------- prompt bar: submit a whole-team goal (POST /prompt) ----------
function setPromptEnabled() {
  $("prompt-send").disabled = running;
  $("prompt-input").disabled = running;
  $("goal").textContent = running ? "working…" : "waiting for a task…";
}
async function submitPrompt() {
  const text = $("prompt-input").value.trim();
  if (!text || running) return;
  const res = await authedFetch("/prompt", { text, mode: "build" });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    $("prompt-status").textContent = e.error || "failed";
    return;
  }
  $("prompt-input").value = ""; $("prompt-status").textContent = ""; growPrompt();
}
$("prompt-send").addEventListener("click", submitPrompt);
// Enter submits; Shift+Enter falls through to the textarea's own newline. isComposing keeps an IME's
// "confirm this candidate" Enter from sending half a prompt.
const promptInput = $("prompt-input");
function growPrompt() { promptInput.style.height = "auto"; promptInput.style.height = `${promptInput.scrollHeight}px`; }
promptInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  submitPrompt();
});
promptInput.addEventListener("input", growPrompt);

// ---------- canvas render loop ----------
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = window.devicePixelRatio || 1;
  W = canvas.clientWidth; H = canvas.clientHeight;
  canvas.width = W * DPR; canvas.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
// ResizeObserver, not window "resize": opening the agent panel shrinks the canvas's CSS box without
// touching the window, and a stale backing store gets stretched to the new box (squished avatars).
new ResizeObserver(resize).observe(canvas);

// Hit-test against each node's drawn circle, same x/y/radius draw() uses.
function nodeAt(ev) {
  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
  for (const n of nodes.values()) if (Math.hypot(mx - n.x * W, my - n.y * H) <= AVATAR_R) return n;
}
// Drag to move (and pin, like graph.js); a press that never moved is a click-to-inspect.
let drag = null;
canvas.addEventListener("pointerdown", (ev) => {
  const n = nodeAt(ev);
  if (!n) return;
  drag = { n, moved: false, x: ev.clientX, y: ev.clientY };
  canvas.setPointerCapture(ev.pointerId);
});
canvas.addEventListener("pointermove", (ev) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < 4) return;
  drag.moved = true;
  const rect = canvas.getBoundingClientRect();
  drag.n.x = Math.max(0.02, Math.min(0.98, (ev.clientX - rect.left) / W));
  drag.n.y = Math.max(0.02, Math.min(0.98, (ev.clientY - rect.top) / H));
  drag.n.pinned = true;
});
canvas.addEventListener("pointerup", () => {
  if (drag && !drag.moved) openAgentPanel(drag.n.id);
  drag = null;
});
canvas.addEventListener("dblclick", (ev) => { const n = nodeAt(ev); if (n) n.pinned = false; });

function step() {
  const arr = [...nodes.values()];
  // force sim (small N → O(n^2) is fine)
  for (const a of arr) {
    if (a.pinned) { a.vx = a.vy = 0; continue; }
    a.vx += (0.5 - a.x) * 0.002; // gravity to center
    a.vy += (0.5 - a.y) * 0.002;
    for (const b of arr) {
      if (a === b) continue;
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy + 1e-4;
      const rep = 0.0009 / d2;
      a.vx += dx * rep; a.vy += dy * rep;
    }
    if (!a.lead) {
      const lead = arr.find((n) => n.lead);
      if (lead) {
        const dx = lead.x - a.x, dy = lead.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const pull = (d - 0.26) * 0.01;
        a.vx += (dx / d) * pull; a.vy += (dy / d) * pull;
      }
    }
    a.vx *= 0.85; a.vy *= 0.85;
  }
  // The pull toward the lead isn't reciprocal, so the forces don't cancel and the whole team slides
  // to one side until it hits the wall. Spring the group's centroid back to the middle instead.
  let cx = 0, cy = 0;
  for (const a of arr) { cx += a.x; cy += a.y; }
  cx = 0.5 - cx / arr.length; cy = 0.5 - cy / arr.length;
  for (const a of arr) if (!a.pinned) { a.vx += cx * 0.2; a.vy += cy * 0.2; }
  // Integrate only after every force is computed. Moving each node inside the loop above made the
  // later nodes see the earlier ones' new positions, an asymmetry that added up to a steady drift
  // toward the bottom-right corner.
  for (const a of arr) {
    if (a.pinned) continue;
    a.x = Math.max(0.08, Math.min(0.92, a.x + a.vx));
    a.y = Math.max(0.1, Math.min(0.9, a.y + a.vy));
  }
}

function draw() {
  step();
  ctx.clearRect(0, 0, W, H);
  const px = (n) => n.x * W, py = (n) => n.y * H;
  const lead = [...nodes.values()].find((n) => n.lead);

  // faint base edges: orchestrator ↔ each agent
  if (lead) {
    ctx.strokeStyle = "rgba(120,130,160,0.15)";
    ctx.lineWidth = 1;
    for (const n of nodes.values()) {
      if (n === lead) continue;
      ctx.beginPath(); ctx.moveTo(px(lead), py(lead)); ctx.lineTo(px(n), py(n)); ctx.stroke();
    }
  }

  // message pulses
  const now = performance.now();
  pulses = pulses.filter((p) => now - p.born < PULSE_MS);
  for (const p of pulses) {
    const a = nodes.get(p.from), b = nodes.get(p.to);
    if (!a || !b) continue;
    const t = (now - p.born) / PULSE_MS;
    const col = KIND_COLORS[p.kind] || ACCENT;
    ctx.strokeStyle = col; ctx.globalAlpha = 0.5 * (1 - t); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px(a), py(a)); ctx.lineTo(px(b), py(b)); ctx.stroke();
    // moving dot
    const mx = px(a) + (px(b) - px(a)) * t, my = py(a) + (py(b) - py(a)) * t;
    ctx.globalAlpha = 1; ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(mx, my, 4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // nodes
  for (const n of nodes.values()) {
    const x = px(n), y = py(n), r = AVATAR_R; // every avatar is the same size — lead gets a ring, not a bigger sprite
    if (n.status === "working") {
      const t = (now % 1200) / 1200;
      ctx.strokeStyle = "rgba(96,165,250,0.5)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r + 4 + t * 8, 0, Math.PI * 2); ctx.globalAlpha = 1 - t; ctx.stroke(); ctx.globalAlpha = 1;
    }
    drawPixelAvatar(ctx, x, y, r * 2, n.colorIndex);
    if (n.lead) { ctx.strokeStyle = ACCENT; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, r + 5, 0, Math.PI * 2); ctx.stroke(); }
    // Status now lives outside the sprite (its fill/face are identity, not status) — a small dot
    // at the shoulder, same colors the legend already uses.
    ctx.fillStyle = STATUS_FILL[n.status] || STATUS_FILL.idle;
    ctx.beginPath(); ctx.arc(x + r * 0.72, y - r * 0.72, 5, 0, Math.PI * 2); ctx.fill();
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillStyle = INK; ctx.font = "bold 10px ui-monospace, monospace";
    ctx.fillText(n.id.slice(0, 3).toUpperCase(), x, y + r + 4);
    ctx.fillStyle = INK; ctx.font = "11px ui-monospace, monospace";
    ctx.fillText(n.role.slice(0, 18), x, y + r + 16);
    if (n.tokens) { ctx.fillStyle = MUTED; ctx.fillText(n.tokens.toLocaleString() + " tok", x, y + r + 30); }
  }
  requestAnimationFrame(draw);
}

// ---------- tabs ----------
document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".tab").forEach((x) => x.classList.add("hidden"));
    b.classList.add("active");
    $("tab-" + b.dataset.tab).classList.remove("hidden");
  }),
);

// legend
function renderLegend() {
  $("legend").innerHTML = Object.entries(KIND_COLORS)
    .map(([k, c]) => `<span class="k"><i style="background:${esc(c)}"></i>${esc(k)}</span>`)
    .join("");
}
renderLegend();

// A theme switch (TUI ctrl+t, another tab) re-reads the CSS vars and repaints — draw()
// already reads KIND_COLORS/STATUS_FILL fresh every frame, so refreshing them here is enough for the
// live graph; the legend and avatar mascots need an explicit rebuild.
document.addEventListener("niti-theme", () => {
  refreshAppTheme();
  refreshAvatarColors();
  renderLegend();
});

// ---------- boot ----------
async function boot() {
  try {
    const res = await fetch(`/session?token=${encodeURIComponent(TOKEN)}`, { method: "POST" });
    if (res.ok) {
      const s = await res.json();
      for (const a of s.agents || []) ensureNode(a.id, a.role, a.lead);
      if (s.tasks && s.tasks.length) { tasks = s.tasks.map((t) => ({ id: t.id, description: t.description, role: t.assignedTo || t.role, dependsOn: t.dependsOn || [], status: t.status })); renderTasks(); }
      running = !!s.running;
    }
  } catch { /* server not reachable yet — SSE will retry */ }
  setPromptEnabled();
  renderTasks(); renderMessages(); renderUsage();
  resize(); requestAnimationFrame(draw); connect();
}
boot();
