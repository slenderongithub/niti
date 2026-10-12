import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

// avatar.js is a plain browser script (real globals, not an IIFE — see its own header comment)
// loaded the same stub-DOM way as app.test.ts/graph.test.ts, just with no DOM needed at all.
function load() {
  const src = readFileSync(new URL("./avatar.js", import.meta.url), "utf8");
  return new Function(`${src}\nreturn { AVATAR_COLORS, drawAvatar };`)();
}

// A recording 2D-context stub — enough to check what got drawn without a real canvas.
function stubCtx() {
  const log: { fill: string; arc: number[] }[] = [];
  let fs = "";
  let arc: number[] = [];
  const ctx = {
    set fillStyle(v: string) { fs = v; },
    beginPath() {},
    arc(...a: number[]) { arc = a; },
    fill() { log.push({ fill: fs, arc }); },
  };
  return { ctx, log };
}

test("six slot colors, in the drawings' order", () => {
  const { AVATAR_COLORS } = load();
  // No real DOM here, so themeColors() falls back to THEME_DEFAULTS.
  expect(AVATAR_COLORS).toEqual(["#6fb3b8", "#d9b26f", "#d47a7a", "#7aa2d6", "#8fbf8a", "#d49ab5"]);
});

test("before the images load, a disc in the slot color; colorIndex wraps past 6", () => {
  const { AVATAR_COLORS, drawAvatar } = load();
  const { ctx, log } = stubCtx();
  drawAvatar(ctx, 10, 20, 40, 6); // 7th agent → slot 0
  expect(log).toEqual([{ fill: AVATAR_COLORS[0], arc: [10, 20, 20, 0, Math.PI * 2] }]);
});

// Regression: graph.js briefly draws with a non-agent node's colorIndex (undefined) right after
// switching to Models mode. That used to throw and silently kill the caller's animation loop.
test("never throws, even for a non-finite or missing colorIndex", () => {
  const { drawAvatar } = load();
  for (const bad of [undefined, NaN, null, "x", -Infinity, Infinity]) {
    const { ctx } = stubCtx();
    expect(() => drawAvatar(ctx, 0, 0, 40, bad)).not.toThrow();
  }
});

test("draws the avatar image once it has loaded", () => {
  const made: { src: string }[] = [];
  class FakeImage {
    src = "";
    complete = true;
    naturalWidth = 128;
    constructor() {
      made.push(this);
    }
  }
  (globalThis as unknown as { Image: unknown }).Image = FakeImage;
  try {
    const { drawAvatar } = load();
    const calls: unknown[][] = [];
    const ctx = { drawImage: (...a: unknown[]) => calls.push(a) };
    drawAvatar(ctx, 50, 50, 40, 2);
    expect(calls).toHaveLength(1);
    expect((calls[0]![0] as { src: string }).src).toMatch(/^\/avatars\/niti3(-blink)?\.png$/);
    expect(calls[0]!.slice(1)).toEqual([30, 30, 40, 40]);
    expect(made.some((m) => m.src === "/avatars/niti4-blink.png")).toBe(false); // avatar 4 never blinks
  } finally {
    delete (globalThis as unknown as { Image?: unknown }).Image;
  }
});
