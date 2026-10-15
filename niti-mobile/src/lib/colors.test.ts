import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { alpha, dark, light, resolveColor, type Theme } from "./colors";

test("the reducer's CSS variables become the theme's colours", () => {
  expect(resolveColor(dark, "var(--agent-1)")).toBe(dark.agents[0]!);
  expect(resolveColor(dark, "var(--agent-6)")).toBe(dark.agents[5]!);
  expect(resolveColor(dark, "var(--success)")).toBe(dark.success);
  expect(resolveColor(dark, "var(--muted-foreground)")).toBe(dark.mutedForeground);
  expect(resolveColor(dark, "var(--no-such-token)")).toBe(dark.mutedForeground);
  expect(resolveColor(dark, "#123456")).toBe("#123456");
  expect(alpha("#9d8cff", 0.12)).toBe("rgba(157, 140, 255, 0.12)");
});

// The phone wears the desktop app's palette: every token here has the value globals.css gives it.
test("the colours are the desktop app's, light and dark", () => {
  const css = readFileSync(join(import.meta.dir, "../../../niti-app/src/renderer/src/styles/globals.css"), "utf8");
  const block = (sel: string) => {
    const body = css.slice(css.indexOf(`${sel} {`), css.indexOf("}", css.indexOf(`${sel} {`)));
    return new Map([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1]!, m[2]!]));
  };
  for (const [theme, vars] of [
    [dark, block(".dark")],
    [light, block(":root")],
  ] as [Theme, Map<string, string>][]) {
    for (const [k, v] of Object.entries(theme)) {
      if (typeof v !== "string") continue;
      const name = k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      expect([k, vars.get(name)]).toEqual([k, v]);
    }
    theme.agents.forEach((c, i) => expect(vars.get(`agent-${i + 1}`)).toBe(c));
  }
});
