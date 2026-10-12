import type { MessageKind, TaskStatus } from "./types";

// Agent identity, the TUI's rule (tui/internal/theme/theme.go:285-292): by roster position, never
// by name — a colour cycling through the theme's six agent colours (never red) and a glyph avatar.
// ★ is reserved for the lead.

export const AVATARS = ["◆", "▲", "●", "■", "✦", "◈", "❖", "⬢", "⬟", "✱", "✚", "◇"];

export function agentColor(index: number): string {
  return `var(--agent-${(index % 6) + 1})`;
}

export function agentAvatar(index: number): string {
  return AVATARS[index % AVATARS.length]!;
}

export type AgentStatus = "idle" | "working" | "done" | "failed";

export function statusColor(s: AgentStatus | TaskStatus | string): string {
  switch (s) {
    case "done":
      return "var(--success)";
    case "failed":
      return "var(--destructive)";
    case "working":
    case "in_progress":
      return "var(--info)";
    default:
      return "var(--muted-foreground)";
  }
}

export function messageColor(kind: MessageKind | string): string {
  switch (kind) {
    case "question":
      return "var(--warning)";
    case "answer":
      return "var(--success)";
    case "handoff":
    case "artifact":
      return "var(--info)";
    case "review":
      return "var(--pink)";
    case "note":
      return "var(--agent-6)";
    default:
      return "var(--primary)";
  }
}

export const TASK_GLYPH: Record<TaskStatus, string> = { done: "●", in_progress: "◐", pending: "○", failed: "✖" };

// color-mix tint, the GUI's Tint(c) (theme.go:328): the colour at `pct` over transparent.
export function tint(color: string, pct = 14): string {
  return `color-mix(in oklab, ${color} ${pct}%, transparent)`;
}
