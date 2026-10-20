import { useHarness } from "./use-harness";
import { send } from "@/lib/actions";
import { useApp } from "@/store/app";
import { PAGES, useUI, type Page } from "@/store/ui";

// NITI_APP_AUDIT: the layout test. Every page (and the setup screen, and an open file), at the
// minimum and a large window size, in both themes, checked for: clipped content, anything past the
// viewport, unequal tiles or cards in a row, sections whose edges don't line up with the page,
// uneven gaps between sections, and click targets under 24px. Reports every violation; passes
// only with none.

const SIZES: [number, number][] = [
  [960, 600],
  [1440, 900],
];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function label(el: Element): string {
  const parts: string[] = [];
  let n: Element | null = el;
  for (let i = 0; n && i < 4 && n !== document.body; i++, n = n.parentElement) {
    const slot = n.getAttribute("data-slot") || n.getAttribute("data-audit");
    const cls = (n.getAttribute("class") || "").split(/\s+/).filter((c) => /^(flex|grid|truncate|rounded|border|h-|w-|px-|py-|p-|gap-)/.test(c)).slice(0, 3).join(".");
    parts.unshift(`${n.tagName.toLowerCase()}${slot ? `[${slot}]` : ""}${cls ? `.${cls}` : ""}`);
  }
  const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
  return `${parts.join(" > ")}${text ? ` "${text}"` : ""}`;
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
}

function scrollsX(el: Element): boolean {
  const o = getComputedStyle(el).overflowX;
  return o === "auto" || o === "scroll";
}

function auditDom(scope: Element = document.body): string[] {
  const out: string[] = [];
  const all = scope.querySelectorAll<HTMLElement>("*");
  const W = window.innerWidth;
  for (const el of all) {
    if (el.closest("svg, canvas, .cm-editor, .recharts-wrapper, [data-allow-clip], [data-radix-popper-content-wrapper], [role=tooltip], [data-sonner-toaster]")) continue;
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    // 1. clipped: content wider than its hidden-overflow box, with no ellipsis to say so.
    const clamped = (cs as unknown as { webkitLineClamp?: string }).webkitLineClamp;
    if ((cs.overflowX === "hidden" || cs.overflowX === "clip") && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== "ellipsis" && (!clamped || clamped === "none") && el.children.length + (el.textContent?.trim() ? 1 : 0) > 0) {
      // Truncated children carry their own ellipsis; only flag boxes whose overflow nobody marks.
      const marked = [...el.querySelectorAll("*")].some((c) => getComputedStyle(c).textOverflow === "ellipsis" && c.scrollWidth > c.clientWidth);
      if (!marked) out.push(`clipped (${el.scrollWidth - el.clientWidth}px): ${label(el)}`);
    }
    // 2. past the viewport, with no scrolling ancestor to reach it.
    const r = el.getBoundingClientRect();
    if (r.right > W + 1) {
      let p = el.parentElement;
      let reachable = false;
      while (p) {
        if (scrollsX(p) || getComputedStyle(p).overflowX === "hidden") {
          reachable = true;
          break;
        }
        p = p.parentElement;
      }
      if (!reachable) out.push(`past the viewport by ${Math.round(r.right - W)}px: ${label(el)}`);
    }
    // 6. click targets.
    if ((el.tagName === "BUTTON" || el.getAttribute("role") === "button" || el.getAttribute("role") === "tab") && r.width < 24 && r.height < 24 && !el.closest("[data-allow-small]")) out.push(`target ${Math.round(r.width)}×${Math.round(r.height)} < 24px: ${label(el)}`);
  }
  // 7. hard outer rings (selection and focus outlines drawn as box-shadow) cut off by a clipping
  // ancestor — the scroll list or card they sit in.
  for (const el of all) {
    if (!visible(el)) continue;
    const bs = getComputedStyle(el).boxShadow;
    if (!bs || bs === "none") continue;
    for (const sh of bs.split(/,(?![^(]*\))/)) {
      if (sh.includes("inset")) continue;
      const nums = (sh.replace(/rgba?\([^)]*\)|oklab\([^)]*\)|color-mix\(.*\)|#[0-9a-f]+/gi, "").match(/-?[\d.]+px/g) ?? []).map(parseFloat);
      const [x = 0, y = 0, blur = 0, spread = 0] = nums;
      if (blur > 0.5 || spread <= 0.25) continue; // a soft drop shadow, not a ring
      const r = el.getBoundingClientRect();
      const box = { l: r.left + x - spread, t: r.top + y - spread, r: r.right + x + spread, b: r.bottom + y + spread };
      let p = el.parentElement;
      while (p && p !== document.body) {
        const o = getComputedStyle(p);
        if (o.overflowX !== "visible" || o.overflowY !== "visible") break;
        p = p.parentElement;
      }
      if (!p || p === document.body) continue;
      const pr = p.getBoundingClientRect();
      const clip = { l: pr.left + p.clientLeft, t: pr.top + p.clientTop, r: pr.left + p.clientLeft + p.clientWidth, b: pr.top + p.clientTop + p.clientHeight };
      const cut = Math.max(clip.l - box.l, box.r - clip.r, clip.t - box.t, box.b - clip.b);
      // Only where the element itself is in view: a ring scrolled off-screen with its row is fine.
      const inView = r.bottom > clip.t && r.top < clip.b && r.right > clip.l && r.left < clip.r;
      if (cut > 0.5 && inView) out.push(`ring cut off by ${cut.toFixed(1)}px: ${label(el)}`);
    }
  }
  // 3/4. equal boxes per row: tiles, and cards sharing a grid row.
  for (const sel of ["[data-audit=tile]", "[data-audit=card]"]) {
    const groups = new Map<Element, HTMLElement[]>();
    for (const el of scope.querySelectorAll<HTMLElement>(sel)) {
      if (!visible(el) || !el.parentElement) continue;
      if (getComputedStyle(el.parentElement).display !== "grid") continue;
      (groups.get(el.parentElement) ?? groups.set(el.parentElement, []).get(el.parentElement)!).push(el);
    }
    for (const els of groups.values()) {
      const rows = new Map<number, HTMLElement[]>();
      for (const el of els) {
        const top = Math.round(el.getBoundingClientRect().top);
        (rows.get(top) ?? rows.set(top, []).get(top)!).push(el);
      }
      for (const row of rows.values()) {
        const hs = row.map((e) => Math.round(e.getBoundingClientRect().height));
        if (Math.max(...hs) - Math.min(...hs) > 1) out.push(`unequal ${sel.includes("tile") ? "tiles" : "cards"} in a row (${hs.join("/")}px): ${label(row[0]!)}`);
      }
    }
  }
  // 5. sections line up with the page, and the gaps between them are equal.
  for (const page of scope.querySelectorAll<HTMLElement>("[data-audit=page]")) {
    if (!visible(page)) continue;
    const pr = page.getBoundingClientRect();
    const ps = getComputedStyle(page);
    const left = pr.left + parseFloat(ps.paddingLeft);
    const right = pr.right - parseFloat(ps.paddingRight);
    const kids = [...page.children].filter((k) => visible(k)) as HTMLElement[];
    for (const k of kids) {
      const r = k.getBoundingClientRect();
      if (Math.abs(r.left - left) > 1 || Math.abs(r.right - right) > 1) out.push(`edge off the page grid (L${Math.round(r.left - left)} R${Math.round(right - r.right)}): ${label(k)}`);
    }
    const gaps = kids.slice(1).map((k, i) => Math.round(k.getBoundingClientRect().top - kids[i]!.getBoundingClientRect().bottom));
    if (gaps.length && Math.max(...gaps) - Math.min(...gaps) > 1) out.push(`uneven section gaps (${gaps.join("/")}px): ${label(page)}`);
  }
  return out;
}

export const useAudit = () => useHarness("audit", run);

async function run() {
  const found = new Map<string, Set<string>>();
  const note = (where: string, vs: string[]) => {
    for (const v of vs) (found.get(v) ?? found.set(v, new Set()).get(v)!).add(where);
  };
  await wait(1200);
  const check = async (where: string) => {
    console.log(`[audit] ${where}`);
    await wait(700);
    note(where, auditDom());
  };

  // Every page, in both themes and at every size; `more` adds checks at each size. Run on an empty
  // project first, then after a run, so both states are covered.
  const sweep = async (state: string, more?: (at: string) => Promise<void>) => {
    for (const theme of ["dark", "light"] as const) {
      useUI.getState().setTheme(theme);
      for (const [w, h] of SIZES) {
        await window.niti.auditResize(w, h);
        for (const p of PAGES) {
          useUI.getState().go(p as Page);
          if (p === "session") useUI.getState().focusAgent(null);
          await check(`${p} · ${state} · ${w}×${h} · ${theme}`);
        }
        await more?.(`${w}×${h} · ${theme}`);
      }
    }
  };
  await sweep("empty");

  // Fill the project: a finished run, an open file.
  await useApp.getState().api?.setAuto(true);
  await send("build a tiny reddit replica", "team");
  for (let i = 0; i < 120; i++) {
    await wait(250);
    const s = useApp.getState().session;
    if (s.summary && !s.active) break;
  }
  useUI.getState().viewFile("src/a.ts");
  await wait(800);

  await sweep("after a run", async (at) => {
    useUI.getState().go("session");
    useUI.getState().viewFile("src/a.ts");
    await check(`editor · ${at}`);
    for (const section of ["team", "providers", "web", "behaviour", "integrations", "worktree", "history", "about"]) {
      useUI.getState().go("settings");
      location.hash = section;
      await check(`settings#${section} · ${at}`);
    }
    // Models: each tab, and a model's detail sheet (the fixture's Hub is fakellm's pocket copy).
    useUI.getState().go("models");
    for (const tab of ["All models", "Installed", "Recommended for this Mac"]) {
      [...document.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((b) => b.textContent?.includes(tab))?.click();
      await check(`models · ${tab} · ${at}`);
    }
    const card = document.querySelector<HTMLElement>("[aria-label$='— details']");
    if (!card) note(`models · ${at}`, ["no model card on Recommended (is the fixture's Hub up?)"]);
    card?.click();
    await check(`models · sheet · ${at}`);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(300);
  });

  // The setup wizard, step by step (Settings → Rebuild team), and Esc back from each step —
  // including from inside the filter lists, where focus sits.
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(text));
  const heading = () => document.querySelector("h2")?.textContent ?? "";
  const esc = async (from: string, expect: string) => {
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await wait(450);
    if (!heading().includes(expect)) note(`setup ${from}`, [`Esc didn't go back from "${from}" (now on "${heading()}")`]);
  };
  for (const [w, h] of SIZES) {
    await window.niti.auditResize(w, h);
    useApp.setState({ phase: "setup", harnessKeepsTeam: false });
    await wait(1200);
    await check(`setup · your team · ${w}×${h}`);
    button("Pick a new team")?.click();
    await check(`setup · size · ${w}×${h}`);
    button("3 teammates")?.click();
    await check(`setup · provider · ${w}×${h}`);
    button("On this Mac")?.click();
    await check(`setup · on this mac · ${w}×${h}`);
    button("Cloud")?.click();
    await wait(300);
    (document.querySelector("[cmdk-input]") as HTMLElement | null)?.focus();
    await esc("Provider", "How many teammates");
    button("3 teammates")?.click();
    await wait(500);
    (document.querySelector<HTMLElement>("[cmdk-item]:not([data-disabled=true])"))?.click();
    await check(`setup · key or model · ${w}×${h}`);
    await esc("the step after Provider", "Provider");
    await esc("Provider", "How many teammates");
    await esc("size", "Your team");
    useApp.setState({ phase: "session" });
    await wait(600);
  }

  const lines = [...found.entries()].map(([v, where]) => `✖ ${v}\n    on ${[...where].slice(0, 4).join("; ")}${where.size > 4 ? ` (+${where.size - 4} more)` : ""}`);
  await window.niti.perfReport({ ok: found.size === 0, text: lines.length ? `${lines.length} layout violation(s):\n${lines.join("\n")}` : "no layout violations" });
}
