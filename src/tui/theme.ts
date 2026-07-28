import chalk from "chalk";
import type { AgentConfig } from "../agent/agent.ts";

export interface Theme {
  primary: string;
  text: string;
  textMuted: string;
  border: string;
  borderActive: string;
  success: string;
  error: string;
  warning: string;
  info: string;
  accent: string;
}

export const theme: Theme = {
  primary: "#a78bfa",
  text: "white",
  textMuted: "gray",
  border: "gray",
  borderActive: "#a78bfa",
  success: "#22c55e",
  error: "#ef4444",
  warning: "#eab308",
  info: "#06b6d4",
  accent: "#d946ef",
};

// Ink colorizes through chalk under the hood, which already downsamples truecolor →
// 256 → 16 → off and honors NO_COLOR/FORCE_COLOR. Nothing to detect ourselves; this is
// exposed only for callers that need to branch on it (e.g. skipping decorative glyphs).
export const colorsEnabled = chalk.level > 0;

// Per-agent identity — one color + avatar per config slot, shared by every TUI view.
const AGENT_COLORS = ["cyan", "magenta", "green", "yellow", "blue", "red"] as const;
const AGENT_AVATARS = ["◆", "▲", "●", "■", "★", "✦"] as const;

function indexOf(configs: readonly AgentConfig[], id: string): number {
  const i = configs.findIndex((c) => c.id === id);
  return i < 0 ? 0 : i;
}

export function agentColor(configs: readonly AgentConfig[], id: string): string {
  return AGENT_COLORS[indexOf(configs, id) % AGENT_COLORS.length]!;
}

export function agentAvatar(configs: readonly AgentConfig[], id: string): string {
  return AGENT_AVATARS[indexOf(configs, id) % AGENT_AVATARS.length]!;
}

// "2.2k" / "1M" style compact counts — shared by the streaming indicator and the model picker.
export const compactNumber = (n: number) =>
  new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n).toLowerCase();
