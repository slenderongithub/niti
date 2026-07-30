"use strict";
// amux live dashboard — a self-contained SSE consumer + hand-rolled canvas force graph.
// No external libraries, no network beyond this origin's /events stream (CSP-friendly).

const params = new URLSearchParams(location.search);
const TOKEN = params.get("token") || "";
const KIND_COLORS = {
  question: "#fbbf24",
  answer: "#4ade80",
  handoff: "#60a5fa",
  artifact: "#60a5fa",
  review: "#f472b6",
  broadcast: "#a78bfa",
};
const STATUS_FILL = { idle: "#3a3f52", working: "#60a5fa", done: "#4ade80", failed: "#f87171" };
const PULSE_MS = 2200;

const $ = (id) => document.getElementById(id);
const nodes = new Map(); // id -> {id,label,role,lead,x,y,vx,vy,status,activity,tokens}
let tasks = [];
const messages = [];
let pulses = []; // {from,to,kind,born}
let totals = { inputTokens: 0, outputTokens: 0, calls: 0 };
const usageByAgent = new Map();
let progress = 0;

// ---------- graph nodes ----------
function ensureNode(id, role, lead) {
  if (id === "*") return null;
  let n = nodes.get(id);
  if (!n) {
    const angle = nodes.size * 1.3;
    n = {
      id,
      label: id,
      role: role || id,
      lead: !!lead,
      x: 0.5 + 0.28 * Math.cos(angle),
      y: 0.5 + 0.28 * Math.sin(angle),
      vx: 0,
      vy: 0,
      status: "idle",
      activity: "",
      tokens: 0,
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
  const es = new EventSource(`/events?from=0&token=${encodeURIComponent(TOKEN)}`);
  es.onopen = () => { conn.textContent = "live"; conn.className = "conn live"; };
  es.onerror = () => { conn.textContent = "reconnecting…"; conn.className = "conn dead"; };
  es.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch { return; }
    handle(e);
  };
}

function handle(e) {
  switch (e.kind) {
    case "session":
      if (e.state === "started") { $("goal").textContent = e.goal || "working…"; setProgress(0); }
      if (e.state === "ended") setProgress(100);
      if (e.state === "cancelled") $("conn").textContent = "cancelled";
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
    case "task_started": { const n = nodes.get(ev.role); if (n) n.status = "working"; setTaskStatus(ev.taskId, "in_progress"); break; }
    case "task_done": {
      const n = nodes.get(ev.role); if (n) n.status = ev.ok ? "done" : "failed";
      setTaskStatus(ev.taskId, ev.ok ? "done" : "failed");
      if (ev.total) setProgress(Math.round((ev.completed / ev.total) * 100));
      break;
    }
    case "handoff": pulse(ev.from, ev.to?.[0] ?? "*", "handoff"); break;
    case "complete": setProgress(100); for (const n of nodes.values()) if (n.status === "working") n.status = "idle"; break;
  }
}

function onAgentEvent(ae) {
  const n = ensureNode(ae.agentId);
  if (!n) return;
  if (ae.type === "delta" || ae.type === "tool_call" || ae.type === "message" || ae.type === "thought") n.status = n.status === "done" ? "done" : "working";
  if (ae.type === "done") n.status = n.status === "failed" ? "failed" : (n.status === "done" ? "done" : "idle");
  if (ae.type === "error") n.status = "failed";
  if (ae.payload && ae.type !== "delta") n.activity = ae.payload.slice(0, 60);
}

// ---------- panels ----------
function setProgress(p) { progress = p; $("bar").style.width = p + "%"; $("pct").textContent = p + "%"; }
function setTaskStatus(id, st) { const t = tasks.find((x) => x.id === id); if (t) { t.status = st; renderTasks(); } }

function renderTasks() {
  const el = $("tab-tasks");
  if (!tasks.length) { el.innerHTML = '<div class="empty">No plan yet.</div>'; return; }
  el.innerHTML = tasks
    .map(
      (t) => `<div class="task"><div class="row"><span class="id">${t.id}</span>
        <span class="st ${t.status}">${t.status.replace("_", " ")}</span></div>
        <div class="who">→ ${esc(t.role)}</div>
        <div class="desc">${esc(t.description)}</div>
        ${t.dependsOn && t.dependsOn.length ? `<div class="deps">depends on ${t.dependsOn.join(", ")}</div>` : ""}</div>`,
    )
    .join("");
}

function renderMessages() {
  const el = $("tab-messages");
  if (!messages.length) { el.innerHTML = '<div class="empty">No agent-to-agent messages yet.</div>'; return; }
  el.innerHTML = messages
    .map(
      (m) => `<div class="msg kind-${m.kind}"><div class="h">${esc(m.from)} → ${esc(m.to)} · ${m.kind}</div>
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

function esc(s) { return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

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
window.addEventListener("resize", resize);

function step() {
  const arr = [...nodes.values()];
  // force sim (small N → O(n^2) is fine)
  for (const a of arr) {
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
    const col = KIND_COLORS[p.kind] || "#a78bfa";
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
    const x = px(n), y = py(n), r = n.lead ? 26 : 20;
    if (n.status === "working") {
      const t = (now % 1200) / 1200;
      ctx.strokeStyle = "rgba(96,165,250,0.5)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r + 4 + t * 8, 0, Math.PI * 2); ctx.globalAlpha = 1 - t; ctx.stroke(); ctx.globalAlpha = 1;
    }
    ctx.fillStyle = STATUS_FILL[n.status] || "#3a3f52";
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    if (n.lead) { ctx.strokeStyle = "#a78bfa"; ctx.lineWidth = 3; ctx.stroke(); }
    ctx.fillStyle = "#0d0f16"; ctx.font = "bold 11px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(n.id.slice(0, 3).toUpperCase(), x, y);
    ctx.fillStyle = "#e7e9f2"; ctx.font = "11px ui-monospace, monospace"; ctx.textBaseline = "top";
    ctx.fillText(n.role.slice(0, 18), x, y + r + 4);
    if (n.tokens) { ctx.fillStyle = "#8b90a6"; ctx.fillText(n.tokens.toLocaleString() + " tok", x, y + r + 18); }
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
$("legend").innerHTML = Object.entries(KIND_COLORS)
  .map(([k, c]) => `<span class="k"><i style="background:${c}"></i>${k}</span>`)
  .join("");

// ---------- boot ----------
async function boot() {
  try {
    const res = await fetch(`/session?token=${encodeURIComponent(TOKEN)}`, { method: "POST" });
    if (res.ok) {
      const s = await res.json();
      for (const a of s.agents || []) ensureNode(a.id, a.role, a.lead);
      if (s.tasks && s.tasks.length) { tasks = s.tasks.map((t) => ({ id: t.id, description: t.description, role: t.assignedTo || t.role, dependsOn: t.dependsOn || [], status: t.status })); renderTasks(); }
    }
  } catch { /* server not reachable yet — SSE will retry */ }
  renderTasks(); renderMessages(); renderUsage();
  resize(); requestAnimationFrame(draw); connect();
}
boot();
