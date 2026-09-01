import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const PALETTES = [
  { name: "neon graveyard", bg: "#0a0a0f", panel: "#121218", fg: "#e4e4f0", muted: "#6b6b80", line: "#1e1e2a", accent: "#ff2e63", alt: "#08d9d6", green: "#39ff14", red: "#ff5470", amber: "#f5d800", blue: "#00b4ff", pink: "#ff6ec7" },
  { name: "hazard tape", bg: "#0d0d0d", panel: "#161616", fg: "#f5f5f0", muted: "#8a8a80", line: "#2b2b2b", accent: "#ffd400", alt: "#ff6b00", green: "#7cff00", red: "#ff3b30", amber: "#ffab00", blue: "#00b8d4", pink: "#ff5fa2" },
];

// theme.js is a plain browser script — same stub-DOM technique as app.test.ts/graph.test.ts.
function load(opts: { fetchOk?: boolean; savedName?: string; serverTheme?: string } = {}) {
  const elements = new Map<string, any>();
  const el = (id: string) => {
    if (!elements.has(id)) {
      const classes = new Set<string>();
      const listeners: Record<string, ((e: any) => void)[]> = {};
      const node: any = {
        addEventListener: (type: string, fn: (e: any) => void) => (listeners[type] ??= []).push(fn),
        // fires this element's own listeners — real dispatch would also bubble to document, tests
        // trigger that half explicitly via `dispatchDocClick` so both halves of a click are visible.
        dispatch: (type: string, e: any = {}) => (listeners[type] || []).forEach((fn) => fn({ target: node, ...e })),
        classList: {
          add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c),
          toggle: (c: string) => (classes.has(c) ? classes.delete(c) : classes.add(c)),
        },
        style: {}, innerHTML: "",
        querySelectorAll: () => [],
        contains: (t: any) => t === node,
      };
      elements.set(id, node);
    }
    return elements.get(id);
  };
  // theme-btn has a child dot (#theme-dot) in the real DOM — a click landing on the dot still
  // "contains"-matches the button, which is exactly the case that used to slip past the old
  // `e.target !== btn` check (see the click-outside test below).
  el("theme-btn").contains = (t: any) => t === el("theme-btn") || t === el("theme-dot");
  el("theme-menu").classList.add("hidden"); // matches index.html's initial markup: class="theme-menu hidden"
  const rootStyle: Record<string, string> = {};
  const documentElement = { style: { setProperty: (k: string, v: string) => (rootStyle[k] = v) } };
  const docListeners: Record<string, ((e: any) => void)[]> = {};
  const doc = {
    getElementById: el,
    documentElement,
    addEventListener: (type: string, fn: (e: any) => void) => (docListeners[type] ??= []).push(fn),
    dispatchEvent: (e: any) => (docListeners[e.type] || []).forEach((fn) => fn(e)),
    dispatchDocClick: (target: any) => (docListeners["click"] || []).forEach((fn) => fn({ target })),
  };
  const storage = new Map<string, string>();
  if (opts.savedName) storage.set("niti-theme", opts.savedName);
  const localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
  };
  // Same stub-EventSource convention as app.test.ts/graph.test.ts — theme.js opens its own SSE
  // connection to watch for live theme changes from other clients (the TUI carousel, other tabs).
  class StubEventSource {
    onmessage: any;
    constructor(public url: string) {
      StubEventSource.instances.push(this);
    }
    static instances: StubEventSource[] = [];
  }
  const win = {
    fetch: (path: string) => {
      if (opts.fetchOk === false) return Promise.reject(new Error("offline"));
      if (path.startsWith("/session")) return Promise.resolve({ json: async () => ({ theme: opts.serverTheme }) });
      return Promise.resolve({ json: async () => PALETTES });
    },
    document: doc, location: { search: "?token=t" }, localStorage,
    EventSource: StubEventSource,
  };
  const src = readFileSync(new URL("./theme.js", import.meta.url), "utf8");
  new Function("window", "document", "location", "fetch", "URLSearchParams", "localStorage", "EventSource", `${src}`)(
    win, doc, win.location, win.fetch, URLSearchParams, localStorage, win.EventSource,
  );
  return { rootStyle, elFor: el, storage, StubEventSource, dispatchDocClick: doc.dispatchDocClick };
}

const settled = async () => { await new Promise((r) => setTimeout(r, 0)); };

test("boot applies the first palette by default and marks it in the menu", async () => {
  const g = load();
  await settled();
  expect(g.rootStyle["--bg"]).toBe("#0a0a0f"); // neon graveyard, first in the list
  expect(g.rootStyle["--violet"]).toBe("#ff2e63"); // accent maps to the --violet var
  expect(g.elFor("theme-menu").innerHTML).toContain("neon graveyard ✓");
  expect(g.elFor("theme-menu").innerHTML).toContain("hazard tape");
});

test("a saved choice in localStorage wins over the default", async () => {
  const g = load({ savedName: "hazard tape" });
  await settled();
  expect(g.rootStyle["--bg"]).toBe("#0d0d0d");
  expect(g.elFor("theme-menu").innerHTML).toContain("hazard tape ✓");
});

// Regression: a browser that has never opened this page before (no localStorage entry) used to
// always land on palettes[0] and stay there, no matter what theme the TUI/server actually had
// active — the dashboard/graph looked "stuck" in a fixed theme. boot() must correct itself from the
// server's real current theme once that request resolves.
test("boot reconciles to the server's active theme when there's no local preference", async () => {
  const g = load({ serverTheme: "hazard tape" });
  await settled();
  expect(g.rootStyle["--bg"]).toBe("#0d0d0d");
  expect(g.storage.get("niti-theme")).toBe("hazard tape");
  expect(g.elFor("theme-menu").innerHTML).toContain("hazard tape ✓");
});

test("offline (fetch fails) leaves the CSS fallback alone rather than throwing", async () => {
  const g = load({ fetchOk: false });
  await settled();
  expect(g.rootStyle["--bg"]).toBeUndefined();
});

// Regression: theme-btn has a child dot (#theme-dot); clicking it makes that span the event's
// target, not the button. A strict `e.target !== btn` check in the document click-outside handler
// treated that as an outside click and closed the menu the same instant it had just opened — the
// button "sometimes worked, sometimes didn't" depending on whether the click landed on the button's
// own box or its child dot.
test("clicking the theme dot (a child of the button) opens the menu instead of instantly re-closing it", async () => {
  const g = load();
  await settled();
  const btn = g.elFor("theme-btn"), dot = g.elFor("theme-dot"), menu = g.elFor("theme-menu");
  expect(menu.classList.contains("hidden")).toBe(true); // starts closed

  btn.dispatch("click"); // the button's own listener toggles it open
  g.dispatchDocClick(dot); // the same physical click bubbles to document with target = the dot

  expect(menu.classList.contains("hidden")).toBe(false);
});

test("a theme event from another client (TUI carousel, another tab) is applied live", async () => {
  const g = load();
  await settled();
  expect(g.rootStyle["--bg"]).toBe("#0a0a0f"); // still neon graveyard

  const es = g.StubEventSource.instances[0];
  es.onmessage({ data: JSON.stringify({ kind: "theme", theme: "hazard tape" }) });

  expect(g.rootStyle["--bg"]).toBe("#0d0d0d");
  expect(g.storage.get("niti-theme")).toBe("hazard tape");
  expect(g.elFor("theme-menu").innerHTML).toContain("hazard tape ✓");
});
