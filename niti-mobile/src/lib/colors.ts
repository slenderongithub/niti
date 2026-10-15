// niti's colours: the desktop app's tokens (niti-app/src/renderer/src/styles/globals.css), the
// TUI's obsidian neutrals with niti's violet, under the same names in camelCase. colors.test.ts
// reads that file and fails if the two drift. Screens use these names, never raw colours.
export const dark = {
  background: "#111111",
  foreground: "#ededed",
  card: "#161616",
  popover: "#1a1a1a",
  primary: "#9d8cff",
  primaryForeground: "#0d0b1f",
  secondary: "#1c1c1c",
  muted: "#1c1c1c",
  mutedForeground: "#8f8f8f",
  accent: "#212121",
  destructive: "#e5787a",
  destructiveForeground: "#111111",
  border: "#262626",
  input: "#2e2e2e",
  sidebar: "#0a0a0a",
  success: "#7ec699",
  warning: "#e2bd7b",
  info: "#6fbfd4",
  plan: "#e2bd7b",
  pink: "#dc9cba",
  agents: ["#5b9dff", "#c084fc", "#fb923c", "#8b8cff", "#fb7185", "#2dd4bf"],
  dark: true,
};

export const light: typeof dark = {
  background: "#fafafa",
  foreground: "#171717",
  card: "#ffffff",
  popover: "#ffffff",
  primary: "#5a46d8",
  primaryForeground: "#ffffff",
  secondary: "#f1f1f1",
  muted: "#f1f1f1",
  mutedForeground: "#5f5f5f",
  accent: "#ececec",
  destructive: "#b03a3a",
  destructiveForeground: "#ffffff",
  border: "#e3e3e3",
  input: "#d9d9d9",
  sidebar: "#f3f3f3",
  success: "#2b7a4b",
  warning: "#8a6212",
  info: "#1f6f82",
  plan: "#8a6212",
  pink: "#a3406e",
  agents: ["#1d5fd8", "#8a3fd8", "#c2410c", "#4f46e5", "#be123c", "#0f766e"],
  dark: false,
};

export type Theme = typeof dark;
export type ColorToken = { [K in keyof Theme]: Theme[K] extends string ? K : never }[keyof Theme];

// The shared reducer names colours as CSS variables (identity.ts: var(--agent-N), var(--success)…);
// this turns one into the colour itself.
export function resolveColor(t: Theme, c: string): string {
  const m = /^var\(--([a-z-]+?)(?:-(\d+))?\)$/.exec(c);
  if (!m) return c;
  if (m[1] === "agent") return t.agents[(Number(m[2]) - 1 + t.agents.length) % t.agents.length]!;
  const key = m[1]!.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase()) as keyof Theme;
  const v = t[key];
  return typeof v === "string" ? v : t.mutedForeground;
}

// Tailwind's `bg-primary/12`: a token at an opacity.
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
