import { test, expect } from "bun:test";
import { theme, colorsEnabled, agentColor, agentAvatar } from "./theme.ts";
import type { AgentConfig } from "../agent/agent.ts";

test("theme exposes the full semantic palette", () => {
  const keys: (keyof typeof theme)[] = [
    "primary",
    "text",
    "textMuted",
    "border",
    "borderActive",
    "success",
    "error",
    "warning",
    "info",
    "accent",
  ];
  for (const key of keys) {
    expect(typeof theme[key]).toBe("string");
    expect(theme[key].length).toBeGreaterThan(0);
  }
  expect(typeof colorsEnabled).toBe("boolean");
});

test("agentColor/agentAvatar are stable per id and wrap around the palette", () => {
  const configs = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({ id }) as AgentConfig);
  expect(agentColor(configs, "a")).toBe(agentColor(configs, "g")); // 7th agent wraps to 1st color
  expect(agentAvatar(configs, "b")).not.toBe(agentAvatar(configs, "c"));
  expect(agentColor(configs, "missing")).toBe(agentColor(configs, "a")); // unknown id falls back to index 0
});
