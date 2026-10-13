"use strict";
// Agent avatars, shared by app.js's dashboard nodes and graph.js's Models-mode nodes so both
// canvases draw the same art: the six PNG drawings, with a plain disc in the slot color until
// they've loaded.
//
// Loaded as a plain classic <script>, same no-bundler convention as app.js/graph.js/theme.js —
// AVATAR_COLORS and drawAvatar are deliberately real globals, not IIFE-hidden, since both
// app.js and graph.js call them directly.

// Reads the theme's CSS custom properties (set by theme.js, from tui/internal/theme/palettes.json —
// the same file the Go TUI embeds) so canvas fills match whatever theme the TUI has active, instead
// of a fixed palette baked in here. Lives in this file rather than theme.js because avatar.js is the
// one both app.js and graph.js already load first and call into directly.
const THEME_DEFAULTS = { // the "graphite" palette — only used where there is no DOM to read vars from
  ink: "#d8dbe2", muted: "#8a909c", violet: "#7aa2d6", green: "#8fbf8a",
  red: "#d47a7a", amber: "#d9b26f", blue: "#6fb3b8", pink: "#d49ab5",
  bg: "#16181d", line: "#2e333d",
};
// HTML-escapes text before it goes into innerHTML. Every dynamic insertion in app.js and graph.js
// goes through it, and agent ids and task text come from the model. Quotes too, not just angle
// brackets: values are interpolated into attributes (class="…", style="…"), where an unescaped quote
// closes the attribute and adds its own — and the page URL carries the bearer token, so a missed
// escape is a token leak. Here, in the one script both pages load first, so there is one copy.
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function themeColors() {
  // No real DOM (unit tests, or any other non-browser load) — fall back rather than throw.
  if (typeof getComputedStyle !== "function") return THEME_DEFAULTS;
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    ink: v("--ink", THEME_DEFAULTS.ink), muted: v("--muted", THEME_DEFAULTS.muted),
    violet: v("--violet", THEME_DEFAULTS.violet), green: v("--green", THEME_DEFAULTS.green), red: v("--red", THEME_DEFAULTS.red),
    amber: v("--amber", THEME_DEFAULTS.amber), blue: v("--blue", THEME_DEFAULTS.blue), pink: v("--pink", THEME_DEFAULTS.pink),
    bg: v("--bg", THEME_DEFAULTS.bg), line: v("--line", THEME_DEFAULTS.line),
  };
}
// For building rgba(r,g,b,alpha) strings from a theme hex color (canvas glow/highlight fills).
function hexToRgbTriplet(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [1, 2, 3].map((i) => parseInt(m[i], 16)).join(",") : "167,139,250";
}

let AVATAR_COLORS = ["#3b82f6", "#facc15", "#ef4444", "#a78bfa", "#4ade80", "#ec4899"]; // blue, yellow, red, purple, green, pink
// Slot order matches the six drawings (blue/yellow/red/purple/green/pink) so each
// drawing's fallback disc matches its color.
function refreshAvatarColors() {
  const t = themeColors();
  AVATAR_COLORS = [t.blue, t.amber, t.red, t.violet, t.green, t.pink];
}
refreshAvatarColors();
if (typeof document !== "undefined") document.addEventListener("niti-theme", refreshAvatarColors);

// The six avatar drawings (web/avatars/, made by scripts/avatars/make-avatars.py — the same art the
// desktop app shows): an open frame per slot and a blink frame shown for an instant every 5.2s,
// offset per slot so a team never blinks in unison. Avatar 4 laughs with its eyes shut: no blink.
// Loaded lazily; until they've decoded (or where there's no Image at all, as in the unit tests)
// a plain disc in the slot color stands in.
const AVATAR_HAS_BLINK = [true, true, true, false, true, true];
const AVATAR_BLINK_PERIOD = 5200;
const AVATAR_BLINK_LENGTH = 160;
let avatarImages = null;
function avatarImage(slot, now) {
  if (typeof Image !== "function") return null;
  if (!avatarImages) {
    avatarImages = [];
    for (let i = 0; i < 6; i++) {
      const open = new Image();
      open.src = `/avatars/niti${i + 1}.png`;
      let blink = null;
      if (AVATAR_HAS_BLINK[i]) {
        blink = new Image();
        blink.src = `/avatars/niti${i + 1}-blink.png`;
      }
      avatarImages.push({ open, blink });
    }
  }
  const a = avatarImages[slot];
  const blinking = (now + ((slot * 1700) % AVATAR_BLINK_PERIOD)) % AVATAR_BLINK_PERIOD < AVATAR_BLINK_LENGTH;
  const img = blinking && a.blink && a.blink.complete && a.blink.naturalWidth ? a.blink : a.open;
  return img.complete && img.naturalWidth ? img : null;
}

// Draws the avatar centered at (cx, cy), `size` wide/tall, for roster position `colorIndex`
// (wraps at 6).
function drawAvatar(ctx, cx, cy, size, colorIndex) {
  // A non-finite colorIndex (undefined/NaN — e.g. a caller drawing a node that isn't really an
  // agent) used to fall through the modulo below to NaN, index the avatars out of bounds, and
  // throw — which silently killed the whole caller's animation loop rather than mis-drawing one
  // sprite. Default to slot 0 instead: one wrong-looking avatar beats a frozen canvas.
  const safe = Number.isFinite(colorIndex) ? colorIndex : 0;
  const n = ((safe % AVATAR_COLORS.length) + AVATAR_COLORS.length) % AVATAR_COLORS.length;
  // The real avatar when it has loaded; a disc in the slot color otherwise.
  const img = avatarImage(n, typeof performance !== "undefined" ? performance.now() : 0);
  if (img) {
    ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    return;
  }
  ctx.fillStyle = AVATAR_COLORS[n];
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.fill();
}
