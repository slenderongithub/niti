import { useEffect, useRef } from "react";
import { useApp } from "@/store/app";
import { PAGES, useUI, type Page } from "@/store/ui";

// NITI_APP_PERF: drive the real app with real input (injected by main through Chromium's input
// pipeline) and measure what a person feels — click → page shown, keystroke → paint, dialog open,
// a streamed run, and what each page costs while idle. Fails the run over budget.

// "shown" = the first painted frame with the result on screen (what responsiveness means);
// "settled" = its entrance animation done (reported, not budgeted).
const BUDGET = { navP95: 60, keyP95: 24, dialogP95: 100, streamLongTaskMax: 50, idleCpuMax: 5 };

type Entry = { name: string; duration: number; startTime: number };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise<number>((r) => requestAnimationFrame(() => r(performance.now())));

function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

function centre(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

// Resolves when `ready()` holds on a painted frame: the time a person would see the result.
async function until(ready: () => boolean, timeout = 3000): Promise<number> {
  const t0 = performance.now();
  for (;;) {
    const t = await frame();
    if (ready()) return t;
    if (t - t0 > timeout) return t;
  }
}

function visible(el: Element | null): boolean {
  if (!el) return false;
  let n: Element | null = el;
  while (n && n !== document.body) {
    if (Number(getComputedStyle(n).opacity) <= 0.01) return false;
    n = n.parentElement;
  }
  return true;
}

function settled(el: Element | null): boolean {
  if (!el) return false;
  let n: Element | null = el;
  // Fully opaque all the way up: an entering page that's still fading in isn't "shown" yet.
  while (n && n !== document.body) {
    if (Number(getComputedStyle(n).opacity) < 0.99) return false;
    n = n.parentElement;
  }
  return true;
}

export function usePerf() {
  const perf = useApp((s) => s.info?.harness === "perf");
  const phase = useApp((s) => s.phase);
  const ready = useApp((s) => s.session.ready);
  const ran = useRef(false);
  useEffect(() => {
    if (!perf || phase !== "session" || !ready || ran.current) return;
    ran.current = true;
    void run();
  }, [perf, phase, ready]);
}

async function run() {
  const events: Entry[] = [];
  const longtasks: Entry[] = [];
  const loafs: { duration: number; startTime: number; scripts: { src: string; fn: string; duration: number }[] }[] = [];
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) events.push({ name: e.name, duration: e.duration, startTime: e.startTime });
  }).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) longtasks.push({ name: e.name, duration: e.duration, startTime: e.startTime });
  }).observe({ type: "longtask", buffered: true });
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as unknown as { duration: number; startTime: number; scripts: { sourceURL: string; sourceFunctionName: string; invoker: string; duration: number }[] }[]) {
        loafs.push({ duration: e.duration, startTime: e.startTime, scripts: (e.scripts ?? []).map((s) => ({ src: (s.sourceURL || "").split("/").pop() ?? "", fn: s.sourceFunctionName || s.invoker, duration: s.duration })) });
      }
    }).observe({ type: "long-animation-frame", buffered: true });
  } catch {
    /* older Chromium: LoAF attribution unavailable */
  }

  const out: string[] = [];
  const fails: string[] = [];
  const click = async (el: Element | null) => {
    if (!el) throw new Error("perf: target not found");
    const p = centre(el);
    await window.niti.perfInput([{ type: "click", ...p }]);
  };
  const keys = async (text: string, gap = 35) => window.niti.perfInput([...text].map((k) => ({ type: "key" as const, key: k === " " ? "Space" : k, gapMs: gap })));

  await wait(1500);
  // Auto-approve, so the streamed run below never blocks on a dialog.
  await useApp.getState().api?.setAuto(true);
  useApp.getState().setAutoLocal(true);

  // --- navigation: click → the new page fully shown ---------------------------------------
  const nav: number[] = [];
  const navSettled: number[] = [];
  const order: Page[] = ["tasks", "tokens", "graph", "dashboard", "settings", "session"];
  for (let round = 0; round < 3; round++) {
    for (const p of order) {
      const target = document.querySelector(`[data-nav="${p}"]`);
      const t0 = performance.now();
      await click(target);
      const t1 = await until(() => useUI.getState().page === p && visible(document.querySelector(`[data-page="${p}"]`)));
      nav.push(t1 - t0);
      const t2 = await until(() => settled(document.querySelector(`[data-page="${p}"]`)));
      navSettled.push(t2 - t0);
      await wait(250);
    }
  }
  out.push(`nav click → page shown   p50 ${pct(nav, 50).toFixed(0)}ms  p95 ${pct(nav, 95).toFixed(0)}ms  (settled p50 ${pct(navSettled, 50).toFixed(0)}ms, n=${nav.length})`);
  if (pct(nav, 95) > BUDGET.navP95) fails.push(`nav p95 ${pct(nav, 95).toFixed(0)}ms > ${BUDGET.navP95}`);

  // --- the floor: typing into a bare <input> outside React, in this same window ------------
  const raw = document.createElement("input");
  raw.style.cssText = "position:fixed;left:8px;bottom:8px;width:200px;height:24px;z-index:99999";
  document.body.appendChild(raw);
  await click(raw);
  await wait(150);
  const fb = events.length;
  await keys("the quick brown fox jumps over the lazy dog");
  await wait(500);
  const floorKeys = events.slice(fb).filter((e) => e.name === "keydown").map((e) => e.duration);
  const floor = [...floorKeys, ...Array(Math.max(0, 43 - floorKeys.length)).fill(8)];
  raw.remove();
  out.push(`keystroke floor (bare)   p50 ${pct(floor, 50).toFixed(0)}ms  p95 ${pct(floor, 95).toFixed(0)}ms`);
  // The same with the app hidden: whether the app's DOM makes every frame expensive.
  const rootEl = document.getElementById("root")!;
  rootEl.style.visibility = "hidden";
  const raw2 = document.createElement("input");
  raw2.style.cssText = raw.style.cssText;
  document.body.appendChild(raw2);
  await click(raw2);
  await wait(150);
  const fb2 = events.length;
  await keys("the quick brown fox jumps over the lazy dog");
  await wait(500);
  const k2 = events.slice(fb2).filter((e) => e.name === "keydown").map((e) => e.duration);
  const floor2 = [...k2, ...Array(Math.max(0, 43 - k2.length)).fill(8)];
  raw2.remove();
  rootEl.style.visibility = "";
  out.push(`keystroke floor (no app) p50 ${pct(floor2, 50).toFixed(0)}ms  p95 ${pct(floor2, 95).toFixed(0)}ms`);

  // --- typing in the composer ------------------------------------------------------------
  useUI.getState().go("session");
  await wait(400);
  await click(document.querySelector('[data-perf="composer"]'));
  await wait(200);
  const before = events.length;
  await keys("the quick brown fox jumps over the lazy dog while agents work");
  await wait(600);
  const keyEvents = events.slice(before).filter((e) => e.name === "keydown" || e.name === "keypress" || e.name === "input" || e.name === "keyup");
  // Event Timing only records events over 16ms, so the unrecorded ones were faster than that.
  const typed = 63;
  const keyDur = [...keyEvents.filter((e) => e.name === "keydown").map((e) => e.duration), ...Array(Math.max(0, typed - keyEvents.filter((e) => e.name === "keydown").length)).fill(8)];
  out.push(`keystroke → paint        p50 ${pct(keyDur, 50).toFixed(0)}ms  p95 ${pct(keyDur, 95).toFixed(0)}ms  (slow keydowns ${keyEvents.filter((e) => e.name === "keydown").length}/${typed})`);
  // Budget relative to the floor: what React and the app add on top of the browser's own cost.
  if (pct(keyDur, 95) > Math.max(BUDGET.keyP95, pct(floor, 95) + 8)) fails.push(`keystroke p95 ${pct(keyDur, 95).toFixed(0)}ms > max(${BUDGET.keyP95}, floor ${pct(floor, 95).toFixed(0)} + 8)`);
  // Clear what was typed.
  await window.niti.perfInput([{ type: "key", key: "a", modifiers: ["meta"] }, { type: "key", key: "Backspace" }]);

  // --- dialogs ---------------------------------------------------------------------------
  const dialog: number[] = [];
  const dialogSettled: number[] = [];
  for (let i = 0; i < 4; i++) {
    const t0 = performance.now();
    await click(document.querySelector('[data-perf="palette"]'));
    const t1 = await until(() => visible(document.querySelector("[role=dialog]")));
    dialog.push(t1 - t0);
    const t2 = await until(() => settled(document.querySelector("[role=dialog]")));
    dialogSettled.push(t2 - t0);
    await window.niti.perfInput([{ type: "key", key: "Escape" }]);
    await until(() => !document.querySelector("[role=dialog]"));
    await wait(200);
  }
  out.push(`palette open → shown     p50 ${pct(dialog, 50).toFixed(0)}ms  p95 ${pct(dialog, 95).toFixed(0)}ms  (settled p50 ${pct(dialogSettled, 50).toFixed(0)}ms)`);
  if (pct(dialog, 95) > BUDGET.dialogP95) fails.push(`dialog p95 ${pct(dialog, 95).toFixed(0)}ms > ${BUDGET.dialogP95}`);

  // --- a streamed run ----------------------------------------------------------------------
  useUI.getState().go("session");
  await wait(300);
  const ltBefore = longtasks.length;
  const loafBefore = loafs.length;
  const t0 = performance.now();
  await useApp.getState().api?.prompt("build a tiny reddit replica", "build");
  for (;;) {
    await wait(250);
    const s = useApp.getState().session;
    if ((s.summary && !s.active) || performance.now() - t0 > 90_000) break;
  }
  const runMs = performance.now() - t0;
  const lt = longtasks.slice(ltBefore);
  // The run's first second swaps the welcome screen for the agent grid once; the budget is for
  // the streaming itself, which is what repeats.
  const streaming = lt.filter((e) => e.startTime - t0 > 1000);
  const worst = Math.max(0, ...streaming.map((e) => e.duration));
  const first = Math.max(0, ...lt.filter((e) => e.startTime - t0 <= 1000).map((e) => e.duration));
  out.push(`streamed run             ${(runMs / 1000).toFixed(1)}s · ${streaming.length} long tasks while streaming · worst ${worst.toFixed(0)}ms (run start ${first.toFixed(0)}ms)`);
  if (worst > BUDGET.streamLongTaskMax) fails.push(`long task while streaming ${worst.toFixed(0)}ms > ${BUDGET.streamLongTaskMax}`);
  const runLoafs = loafs.slice(loafBefore);

  // --- idle cost per page --------------------------------------------------------------------
  for (const p of PAGES) {
    useUI.getState().go(p);
    await wait(1200);
    const cpu = await window.niti.perfCpu(3000);
    out.push(`idle ${p.padEnd(10)}          renderer ${cpu.renderer.toFixed(1)}% · gpu ${cpu.gpu.toFixed(1)}%`);
    if (cpu.renderer > BUDGET.idleCpuMax) fails.push(`idle ${p} renderer ${cpu.renderer.toFixed(1)}% > ${BUDGET.idleCpuMax}%`);
  }

  // --- attribution ---------------------------------------------------------------------------
  const byScript = new Map<string, number>();
  for (const f of [...loafs]) for (const s of f.scripts) byScript.set(`${s.fn} (${s.src})`, (byScript.get(`${s.fn} (${s.src})`) ?? 0) + s.duration);
  const top = [...byScript.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  out.push("", `long animation frames: ${loafs.length} total, ${runLoafs.length} during the run`);
  for (const f of runLoafs) out.push(`  run frame ${f.duration.toFixed(0)}ms at +${((f.startTime - t0) / 1000).toFixed(1)}s: ${f.scripts.map((x) => `${x.fn || "?"}(${x.src || "?"}) ${x.duration.toFixed(0)}ms`).join(", ") || "rendering/layout (no script)"}`);
  for (const [k, v] of top) out.push(`  ${v.toFixed(0).padStart(6)}ms  ${k}`);
  const slowEvents = events.filter((e) => e.duration > 50).slice(0, 12);
  if (slowEvents.length) out.push("", "slow events (>50ms):", ...slowEvents.map((e) => `  ${e.duration.toFixed(0).padStart(5)}ms ${e.name}`));
  if (fails.length) out.push("", "over budget:", ...fails.map((f) => `  ✖ ${f}`));

  await window.niti.perfReport({ ok: fails.length === 0, text: out.join("\n") });
}
