import { test, expect } from "bun:test";
import { dark, resolveColor } from "./colors";

test("the reducer's CSS variables become the theme's colours", () => {
  expect(resolveColor(dark, "var(--agent-1)")).toBe(dark.agents[0]!);
  expect(resolveColor(dark, "var(--agent-6)")).toBe(dark.agents[5]!);
  expect(resolveColor(dark, "var(--success)")).toBe(dark.success);
  expect(resolveColor(dark, "var(--muted-foreground)")).toBe(dark.muted); // no such token here: muted
  expect(resolveColor(dark, "#123456")).toBe("#123456");
});
