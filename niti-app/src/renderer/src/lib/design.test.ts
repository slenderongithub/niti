import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyEvents, fromSession } from "./reducer";
import type { ServerEvent, SessionInfo } from "./types";

test("avatars: six slots, and the blink schedule staggers them", () => {
  // The image imports need Vite; the schedule is plain maths.
  const blinkOffset = (slot: number) => ((((slot % 6) + 6) % 6) * 1700) % 5200;
  const offsets = [0, 1, 2, 3, 4, 5].map(blinkOffset);
  expect(new Set(offsets).size).toBe(6);
  expect(blinkOffset(6)).toBe(blinkOffset(0));
});

// WCAG relative luminance contrast.
function lum(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x! + 0.05) / (y! + 0.05);
};

test("theme tokens meet WCAG AA in both themes", () => {
  const css = readFileSync(join(import.meta.dir, "../styles/globals.css"), "utf8");
  const block = (sel: string) => {
    const m = new RegExp(`${sel.replace(".", "\\.")} \\{([^}]*)\\}`).exec(css)!;
    return Object.fromEntries([...m[1]!.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((x) => [x[1]!, x[2]!]));
  };
  for (const t of [block(":root"), block(".dark")]) {
    expect(contrast(t.foreground!, t.background!)).toBeGreaterThanOrEqual(7);
    expect(contrast(t.foreground!, t.card!)).toBeGreaterThanOrEqual(7);
    expect(contrast(t["muted-foreground"]!, t.background!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["muted-foreground"]!, t.card!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["primary-foreground"]!, t.primary!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.primary!, t.background!)).toBeGreaterThanOrEqual(4.5); // links and accent text
  }
});

test("lock events become project-relative paths", () => {
  const info: SessionInfo = {
    agents: [{ id: "dev", provider: "custom", model: "fake", role: "Dev", systemPrompt: "" }],
    tasks: [],
    lastSeq: 0,
    running: false,
    root: "/p",
    lsp: [],
    mcp: [],
    contextLimits: {},
    settings: { autoCompact: true, thinkingMode: false },
    prefs: { lightMode: false, reduceMotion: false, showTurnDuration: false, openAgentsView: false, projectInstructions: true, notifyOnDone: true },
    auto: false,
  };
  let s = fromSession(info);
  s = applyEvents(s, [{ kind: "lock", holders: [{ path: "/p/src/a.ts", holder: "dev" }, { path: "<shell>", holder: "dev" }], seq: 1, time: 1 } as ServerEvent]);
  expect(s.locks).toEqual({ "src/a.ts": "dev" });
  s = applyEvents(s, [{ kind: "lock", holders: [], seq: 2, time: 2 } as ServerEvent]);
  expect(s.locks).toEqual({});
});
