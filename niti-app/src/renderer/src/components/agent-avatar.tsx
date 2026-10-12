import { memo } from "react";
import { AVATARS } from "@/lib/identity";
import { cn } from "@/lib/utils";
import type { AgentStatus } from "@/lib/identity";
import { PixelAvatar } from "./pixel-avatar";

const SIZES = {
  xs: { box: "size-5", px: 20 },
  sm: { box: "size-7", px: 28 },
  md: { box: "size-9", px: 36 },
  lg: { box: "size-12", px: 48 },
} as const;

// An agent's identity mark: its avatar character, on nothing — the drawing is the mark. The lead
// wears the ★; a status dot sits on the corner when `showStatus`.
export const AgentAvatar = memo(function AgentAvatar({
  slot: slotProp,
  avatar,
  color,
  lead,
  status,
  showStatus,
  size = "md",
  className,
}: {
  slot?: number;
  avatar?: string; // the roster glyph; its position in AVATARS is the mascot slot
  color: string;
  lead?: boolean;
  status?: AgentStatus;
  showStatus?: boolean;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const s = SIZES[size];
  const slot = slotProp ?? Math.max(0, AVATARS.indexOf(avatar ?? ""));
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <span className={cn("inline-flex items-center justify-center", s.box)}>
        <PixelAvatar slot={slot} color={color} working={status === "working"} size={s.px} />
      </span>
      {lead && (
        <span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-background text-[9px] leading-none text-warning ring-1 ring-border" title="lead">
          ★
        </span>
      )}
      {showStatus && status && status !== "idle" && (
        <span
          className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-background"
          style={{ background: status === "working" ? "var(--info)" : status === "failed" ? "var(--destructive)" : "var(--success)" }}
        />
      )}
    </span>
  );
});
