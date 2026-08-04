"use strict";
// The theme palette picker — a monkeytype-style swatch button in the header. Palettes come from
// GET /palettes.json, the exact same file the TUI embeds (tui/internal/theme/palettes.json), so
// both surfaces offer identical palettes from one source. A separate file from app.js (which was
// already sizable) — this is a small, self-contained piece of state (current palette, applied via
// CSS custom properties) with no dependency on anything else in the dashboard.
//
// Wrapped in an IIFE: app.js and this file are both loaded as plain classic <script> tags sharing
// one global scope, so top-level `const params`/`TOKEN`/`$` would otherwise collide with app.js's
// own (identical-looking) declarations and throw a SyntaxError that aborts the whole file.
(function () {
  const params = new URLSearchParams(location.search);
  const TOKEN = params.get("token") || "";
  const STORAGE_KEY = "niti-theme";
  const SWATCH_KEYS = ["accent", "alt", "green", "blue", "pink"];

  const $ = (id) => document.getElementById(id);

  // The shared palette shape has one "panel" shade (matching the TUI's single BgPane); --panel-2
  // reuses it rather than inventing a second computed shade the TUI has no equivalent for.
  function applyPalette(p) {
    const root = document.documentElement.style;
    root.setProperty("--bg", p.bg);
    root.setProperty("--panel", p.panel);
    root.setProperty("--panel-2", p.panel);
    root.setProperty("--ink", p.fg);
    root.setProperty("--muted", p.muted);
    root.setProperty("--line", p.line);
    root.setProperty("--violet", p.accent);
    root.setProperty("--green", p.green);
    root.setProperty("--red", p.red);
    root.setProperty("--amber", p.amber);
    root.setProperty("--blue", p.blue);
    root.setProperty("--pink", p.pink);
    const dot = $("theme-dot");
    if (dot) dot.style.background = p.accent;
  }

  // Set once boot() has the catalog — the SSE handler below needs it to resolve a theme name
  // pushed by another client (TUI carousel, another tab) into the full palette object.
  let palettes = [];

  function renderMenu(current) {
    const menu = $("theme-menu");
    if (!menu) return;
    menu.innerHTML = palettes
      .map(
        (p) => `<div class="theme-row" data-name="${esc(p.name)}">
          <span>${esc(p.name)}${p.name === current ? " ✓" : ""}</span>
          <span class="dots">${SWATCH_KEYS.map((k) => `<i style="background:${esc(p[k])}"></i>`).join("")}</span>
        </div>`,
      )
      .join("");
    menu.querySelectorAll(".theme-row").forEach((row) => {
      row.addEventListener("click", () => {
        const p = palettes.find((x) => x.name === row.dataset.name);
        if (!p) return;
        selectTheme(p);
        menu.classList.add("hidden");
      });
    });
  }

  // A theme picked from this dropdown: apply it locally, remember it, and tell the server so the
  // TUI carousel, the graph page and any other open tab converge on the same choice.
  function selectTheme(p) {
    applyPalette(p);
    localStorage.setItem(STORAGE_KEY, p.name);
    renderMenu(p.name);
    fetch(`/theme?token=${encodeURIComponent(TOKEN)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: p.name }),
    }).catch(() => {}); // best-effort — the local preview above already applied
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // A dedicated SSE connection (separate from app.js's/graph.js's own) so this file stays a
  // self-contained piece of state, same as its localStorage handling — it doesn't need to hook
  // into either page's event-parsing switch. `from` is set past any possible buffered seq so this
  // only ever receives *live* theme changes, not a replay of the whole session's event history.
  function watchLiveChanges() {
    const es = new EventSource(`/events?from=${Number.MAX_SAFE_INTEGER}&token=${encodeURIComponent(TOKEN)}`);
    es.onmessage = (ev) => {
      let e;
      try {
        e = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (e.kind !== "theme") return;
      const p = palettes.find((x) => x.name === e.theme);
      if (!p) return;
      applyPalette(p);
      localStorage.setItem(STORAGE_KEY, p.name);
      renderMenu(p.name);
    };
  }

  async function boot() {
    try {
      palettes = await fetch(`/palettes.json?token=${encodeURIComponent(TOKEN)}`).then((r) => r.json());
    } catch {
      return; // offline — style.css's built-in dark/light fallback covers this
    }
    if (!Array.isArray(palettes) || !palettes.length) return;

    const saved = localStorage.getItem(STORAGE_KEY);
    const initial = palettes.find((p) => p.name === saved) || palettes[0];
    applyPalette(initial);
    renderMenu(initial.name);
    watchLiveChanges();

    const btn = $("theme-btn");
    const menu = $("theme-menu");
    if (!btn || !menu) return;
    btn.addEventListener("click", () => menu.classList.toggle("hidden"));
    document.addEventListener("click", (e) => {
      // theme-btn has a child dot (#theme-dot) — clicking it makes e.target that span, not the
      // button itself, so a strict `!== btn` check missed most clicks on the dot and closed the
      // menu the same instant btn's own listener had just opened it. `contains` covers the child.
      if (!btn.contains(e.target) && !menu.contains(e.target)) menu.classList.add("hidden");
    });
  }
  boot();
})();
