import { memo } from "react";
import { AVATAR_BLINK, AVATAR_OPEN, avatarIndex, blinkOffset, BLINK_PERIOD } from "@/lib/avatars";
import { cn } from "@/lib/utils";

// An agent's avatar: its character for its roster slot. It blinks every few seconds (staggered
// per agent, a blink frame faded in for an instant) and bobs while working. Both stop under
// Reduce motion.
export const PixelAvatar = memo(function PixelAvatar({ slot, working, size = 20, className }: { slot: number; color?: string; working?: boolean; size?: number; className?: string }) {
  const i = avatarIndex(slot);
  const blink = AVATAR_BLINK[i];
  return (
    <span className={cn("avatar relative inline-block shrink-0", working && "avatar-working", className)} style={{ width: size, height: size }} aria-hidden>
      <img src={AVATAR_OPEN[i]} alt="" draggable={false} className="absolute inset-0 size-full select-none" />
      {blink && <img src={blink} alt="" draggable={false} className="avatar-blink absolute inset-0 size-full select-none" style={{ animationDelay: `-${(BLINK_PERIOD - blinkOffset(slot)) / 1000}s` }} />}
    </span>
  );
});
