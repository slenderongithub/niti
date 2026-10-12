// The six agent avatars (scripts/make-avatars.py makes them from the drawings): one per roster
// slot, an open frame and a blink frame. Avatar 4 laughs with its eyes shut, so it has no blink.
import a1 from "@/assets/avatars/niti1.png";
import a2 from "@/assets/avatars/niti2.png";
import a3 from "@/assets/avatars/niti3.png";
import a4 from "@/assets/avatars/niti4.png";
import a5 from "@/assets/avatars/niti5.png";
import a6 from "@/assets/avatars/niti6.png";
import b1 from "@/assets/avatars/niti1-blink.png";
import b2 from "@/assets/avatars/niti2-blink.png";
import b3 from "@/assets/avatars/niti3-blink.png";
import b5 from "@/assets/avatars/niti5-blink.png";
import b6 from "@/assets/avatars/niti6-blink.png";

export const AVATAR_OPEN = [a1, a2, a3, a4, a5, a6];
export const AVATAR_BLINK: (string | null)[] = [b1, b2, b3, null, b5, b6];

export const avatarIndex = (slot: number) => ((slot % 6) + 6) % 6;

// When each slot blinks: a 5.2s cycle, offset per slot so a team never blinks in unison.
export const BLINK_PERIOD = 5200;
export const BLINK_LENGTH = 160;
export const blinkOffset = (slot: number) => (avatarIndex(slot) * 1700) % BLINK_PERIOD;
export const isBlinking = (slot: number, now: number) => (now + blinkOffset(slot)) % BLINK_PERIOD < BLINK_LENGTH;
