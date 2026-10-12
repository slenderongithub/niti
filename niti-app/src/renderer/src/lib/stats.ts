import type { Stats } from "./types";

// Activity streaks for the all-time view: consecutive active days, today not yet counting against you.

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function streaks(perDay: Stats["perDay"], today = new Date()): { current: number; longest: number; activeDays: number } {
  const active = new Set(perDay.filter((d) => d.tokens > 0 || d.msgs > 0).map((d) => d.date));
  let longest = 0;
  let run = 0;
  const sorted = [...active].sort();
  let prev: Date | null = null;
  for (const k of sorted) {
    const d = new Date(`${k}T00:00:00`);
    run = prev && Math.round((d.getTime() - prev.getTime()) / 86_400_000) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  let current = 0;
  const cur = new Date(today);
  if (!active.has(dayKey(cur))) cur.setDate(cur.getDate() - 1); // today not started yet doesn't break it
  while (active.has(dayKey(cur))) {
    current++;
    cur.setDate(cur.getDate() - 1);
  }
  return { current, longest, activeDays: active.size };
}

