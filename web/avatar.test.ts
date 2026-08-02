import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

// avatar.js is a plain browser script (real globals, not an IIFE — see its own header comment)
// loaded the same stub-DOM way as app.test.ts/graph.test.ts, just with no DOM needed at all.
function load() {
  const src = readFileSync(new URL("./avatar.js", import.meta.url), "utf8");
  const exported = new Function(`${src}\nreturn { AVATAR_COLORS, AVATAR_INK, AVATAR_BODY, AVATAR_FACES, AVATAR_GRID, drawPixelAvatar };`)();
  return exported;
}

test("body grid is square (12x12) and every row is well-formed", () => {
  const { AVATAR_BODY, AVATAR_GRID } = load();
  expect(AVATAR_BODY).toHaveLength(AVATAR_GRID);
  for (const row of AVATAR_BODY) {
    expect(row).toHaveLength(AVATAR_GRID);
    expect(row).toMatch(/^[01]+$/);
  }
});

test("six colors, one distinct face per color, in the requested order", () => {
  const { AVATAR_COLORS, AVATAR_FACES } = load();
  expect(AVATAR_COLORS).toEqual(["#3b82f6", "#facc15", "#ef4444", "#a78bfa", "#4ade80", "#ec4899"]);
  expect(AVATAR_FACES).toHaveLength(6);
  const sigs = AVATAR_FACES.map((f: number[][]) => JSON.stringify(f));
  expect(new Set(sigs).size).toBe(6); // no two personalities drew the same face
});

// A recording 2D-context stub — enough to check what got drawn without a real canvas.
function stubCtx() {
  const calls: { fillStyle: string; rects: [number, number, number, number][] } = { fillStyle: "", rects: [] } as any;
  const log: { fillStyle: string; x: number; y: number; w: number; h: number }[] = [];
  const ctx = {
    set fillStyle(v: string) { (ctx as any)._fs = v; },
    get fillStyle() { return (ctx as any)._fs; },
    fillRect(x: number, y: number, w: number, h: number) { log.push({ fillStyle: (ctx as any)._fs, x, y, w, h }); },
  };
  return { ctx, log };
}

test("draws the full body in the slot color, then the face in ink, no stray colors", () => {
  const { AVATAR_COLORS, AVATAR_INK, AVATAR_BODY, AVATAR_FACES, drawPixelAvatar } = load();
  const { ctx, log } = stubCtx();
  drawPixelAvatar(ctx, 0, 0, 120, 0);

  const bodyPixelCount = AVATAR_BODY.join("").split("").filter((c: string) => c === "1").length;
  const bodyCalls = log.filter((c) => c.fillStyle === AVATAR_COLORS[0]);
  const faceCalls = log.filter((c) => c.fillStyle === AVATAR_INK);
  expect(bodyCalls).toHaveLength(bodyPixelCount);
  expect(faceCalls).toHaveLength(AVATAR_FACES[0].length);
  expect(log.every((c) => c.fillStyle === AVATAR_COLORS[0] || c.fillStyle === AVATAR_INK)).toBe(true);
});

test("colorIndex wraps for rosters larger than 6 and never goes negative", () => {
  const { AVATAR_COLORS, drawPixelAvatar } = load();
  const { ctx, log } = stubCtx();
  drawPixelAvatar(ctx, 0, 0, 24, 6); // 7th agent → wraps to slot 0 (blue)
  expect(log[0].fillStyle).toBe(AVATAR_COLORS[0]);
});

// Regression: graph.js briefly draws through drawPixelAvatar with a non-agent node's colorIndex
// (undefined) during the async gap right after switching to Models mode. undefined/NaN used to
// fall through the modulo untouched, index AVATAR_FACES out of bounds, and throw — which silently
// killed the caller's requestAnimationFrame loop and froze the canvas on a stale frame. It must
// never throw, for any input.
test("never throws, even for a non-finite or missing colorIndex", () => {
  const { drawPixelAvatar } = load();
  for (const bad of [undefined, NaN, null, "x", -Infinity, Infinity]) {
    const { ctx } = stubCtx();
    expect(() => drawPixelAvatar(ctx, 0, 0, 40, bad)).not.toThrow();
  }
});

// Regression: `size / 12` is rarely a whole number at these sprite sizes (e.g. 40/12 = 3.33), and
// filling adjacent cells at fractional coordinates lets the browser's anti-aliasing round each row
// or column slightly differently — the SAME body grid ends up reading as a slightly different
// shape depending on the exact non-integer size, which is what made otherwise-identical avatars
// look inconsistently squashed or stretched next to each other. Every rect drawn must be an
// integer-sized, integer-positioned square.
test("every drawn cell is an integer-sized, integer-positioned square, at any input size", () => {
  const { drawPixelAvatar } = load();
  for (const size of [24, 40, 41, 52, 53, 100]) {
    const { ctx, log } = stubCtx();
    drawPixelAvatar(ctx, 7, 11, size, 0);
    expect(log.length).toBeGreaterThan(0);
    for (const c of log) {
      expect(c.w).toBe(c.h); // square, not stretched
      expect(Number.isInteger(c.w)).toBe(true);
      expect(Number.isInteger(c.x)).toBe(true);
      expect(Number.isInteger(c.y)).toBe(true);
    }
    const widths = new Set(log.map((c) => c.w));
    expect(widths.size).toBe(1); // one uniform cell size across the whole sprite
  }
});
