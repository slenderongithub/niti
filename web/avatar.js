"use strict";
// Pixel-art agent mascot, shared by app.js's dashboard nodes and graph.js's Models-mode nodes so
// both canvases draw the same shape instead of two hand-rolled ones. One 12x12 body grid (square
// head, two ear nubs, four leg prongs) filled solid in the agent's slot color — no outline stroke
// — topped with one of six face variants so each color also reads as a distinct personality.
//
// Loaded as a plain classic <script>, same no-bundler convention as app.js/graph.js/theme.js —
// AVATAR_COLORS and drawPixelAvatar are deliberately real globals, not IIFE-hidden, since both
// app.js and graph.js call them directly.

// Reads the theme's CSS custom properties (set by theme.js, from tui/internal/theme/palettes.json —
// the same file the Go TUI embeds) so canvas fills match whatever theme the TUI has active, instead
// of a fixed palette baked in here. Lives in this file rather than theme.js because avatar.js is the
// one both app.js and graph.js already load first and call into directly.
const THEME_DEFAULTS = {
  ink: "#e7e9f2", muted: "#8b90a6", violet: "#a78bfa", green: "#4ade80",
  red: "#f87171", amber: "#fbbf24", blue: "#60a5fa", pink: "#f472b6",
};
function themeColors() {
  // No real DOM (unit tests, or any other non-browser load) — fall back rather than throw.
  if (typeof getComputedStyle !== "function") return THEME_DEFAULTS;
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    ink: v("--ink", THEME_DEFAULTS.ink), muted: v("--muted", THEME_DEFAULTS.muted),
    violet: v("--violet", THEME_DEFAULTS.violet), green: v("--green", THEME_DEFAULTS.green), red: v("--red", THEME_DEFAULTS.red),
    amber: v("--amber", THEME_DEFAULTS.amber), blue: v("--blue", THEME_DEFAULTS.blue), pink: v("--pink", THEME_DEFAULTS.pink),
  };
}
// For building rgba(r,g,b,alpha) strings from a theme hex color (canvas glow/highlight fills).
function hexToRgbTriplet(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [1, 2, 3].map((i) => parseInt(m[i], 16)).join(",") : "167,139,250";
}

let AVATAR_COLORS = ["#3b82f6", "#facc15", "#ef4444", "#a78bfa", "#4ade80", "#ec4899"]; // blue, yellow, red, purple, green, pink
// Slot order matches AVATAR_FACES' comments (blue/yellow/red/purple/green/pink) so each face design
// keeps reading against the theme color it was drawn for.
function refreshAvatarColors() {
  const t = themeColors();
  AVATAR_COLORS = [t.blue, t.amber, t.red, t.violet, t.green, t.pink];
}
refreshAvatarColors();
if (typeof document !== "undefined") document.addEventListener("niti-theme", refreshAvatarColors);

const AVATAR_INK = "#0d0f16";
const AVATAR_GRID = 12;

function stripe(left, mid, right) {
  return "0".repeat(left) + "1".repeat(mid) + "0".repeat(right);
}

const AVATAR_BODY = [
  stripe(2, 8, 2), // head
  stripe(2, 8, 2),
  stripe(2, 8, 2),
  stripe(0, 12, 0), // ear nubs (full width band)
  stripe(0, 12, 0),
  stripe(0, 12, 0),
  stripe(2, 8, 2), // neck
  stripe(2, 8, 2),
  "001010010100", // legs (4 prongs)
  "001010010100",
  "001010010100",
  "001010010100",
];

// One face per color slot, as [row, col] ink pixels drawn over the body fill.
const AVATAR_FACES = [
  [[4, 3], [4, 8], [6, 5], [6, 6]], // blue — neutral dot eyes, flat mouth
  [[3, 3], [3, 4], [4, 3], [4, 4], [3, 7], [3, 8], [4, 7], [4, 8], [6, 5], [6, 6]], // yellow — square eyes, flat mouth (was 2 rows tall and read as a blob next to the legs)
  [[3, 4], [4, 3], [3, 7], [4, 8], [6, 4], [6, 5], [6, 6], [6, 7]], // red — angry brows, flat wide mouth
  [[2, 3], [2, 4], [2, 7], [2, 8], [5, 4], [6, 5], [6, 6], [5, 7]], // purple — happy closed eyes, smile
  [[3, 3], [4, 4], [3, 8], [4, 7], [6, 5], [6, 6]], // green — angry inward brows, flat mouth
  [[3, 3], [3, 4], [4, 4], [3, 7], [3, 8], [4, 7], [6, 5], [6, 6]], // pink — heart eyes, small mouth
];

// Draws the mascot centered at (cx, cy), `size` wide/tall, for roster position `colorIndex`
// (wraps at 6 — a 7th+ agent reuses blue's shape with yellow's face rather than erroring).
//
// The cell size is snapped to a whole pixel: at these sprite sizes `size / 12` is rarely an integer
// (e.g. 40/12 = 3.33), and filling adjacent cells at fractional coordinates makes the browser's
// anti-aliasing round each row/column slightly differently — the same 12x12 grid ends up reading as
// a slightly different shape at every non-multiple-of-12 size, which is what made same-shape
// avatars look inconsistently squashed or stretched next to each other.
function drawPixelAvatar(ctx, cx, cy, size, colorIndex) {
  // A non-finite colorIndex (undefined/NaN — e.g. a caller drawing a node that isn't really an
  // agent) used to fall through the modulo below to NaN, index AVATAR_FACES out of bounds, and
  // throw — which silently killed the whole caller's animation loop rather than mis-drawing one
  // sprite. Default to slot 0 instead: one wrong-looking avatar beats a frozen canvas.
  const safe = Number.isFinite(colorIndex) ? colorIndex : 0;
  const n = ((safe % AVATAR_COLORS.length) + AVATAR_COLORS.length) % AVATAR_COLORS.length;
  const cell = Math.max(1, Math.round(size / AVATAR_GRID));
  const left = Math.round(cx - (cell * AVATAR_GRID) / 2);
  const top = Math.round(cy - (cell * AVATAR_GRID) / 2);
  const px = (r, c) => ctx.fillRect(left + c * cell, top + r * cell, cell, cell);

  ctx.fillStyle = AVATAR_COLORS[n];
  for (let r = 0; r < AVATAR_GRID; r++) {
    const row = AVATAR_BODY[r];
    for (let c = 0; c < AVATAR_GRID; c++) if (row[c] === "1") px(r, c);
  }
  ctx.fillStyle = AVATAR_INK;
  for (const [r, c] of AVATAR_FACES[n]) px(r, c);
}
