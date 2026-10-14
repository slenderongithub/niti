// niti's colours, the same tokens as the desktop app (niti-app/src/renderer/src/styles/globals.css):
// the TUI's obsidian neutrals with niti's violet. Screens use these names, never raw colours.
export const dark = {
  background: "#111111",
  card: "#161616",
  raised: "#1c1c1c",
  foreground: "#ededed",
  muted: "#8f8f8f",
  border: "#262626",
  primary: "#9d8cff",
  primaryForeground: "#0d0b1f",
  destructive: "#e5787a",
  success: "#7ec699",
  warning: "#e2bd7b",
  info: "#6fbfd4",
  agents: ["#5b9dff", "#c084fc", "#fb923c", "#8b8cff", "#fb7185", "#2dd4bf"],
};

export const light: typeof dark = {
  background: "#fafafa",
  card: "#ffffff",
  raised: "#f1f1f1",
  foreground: "#171717",
  muted: "#5f5f5f",
  border: "#e3e3e3",
  primary: "#5a46d8",
  primaryForeground: "#ffffff",
  destructive: "#b03a3a",
  success: "#2b7a4b",
  warning: "#8a6212",
  info: "#1f6f82",
  agents: ["#1d5fd8", "#8a3fd8", "#c2410c", "#4f46e5", "#be123c", "#0f766e"],
};

export type Theme = typeof dark;

// The shared reducer names colours as CSS variables (identity.ts: var(--agent-N), var(--success)…);
// this turns one into the colour itself.
export function resolveColor(t: Theme, c: string): string {
  const m = /^var\(--([a-z-]+?)(?:-(\d+))?\)$/.exec(c);
  if (!m) return c;
  if (m[1] === "agent") return t.agents[(Number(m[2]) - 1 + t.agents.length) % t.agents.length]!;
  const key = m[1]!.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase()) as keyof Theme;
  const v = t[key];
  return typeof v === "string" ? v : t.muted;
}
