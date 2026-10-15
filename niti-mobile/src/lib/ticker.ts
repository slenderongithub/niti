import { useSyncExternalStore } from "react";
import { useReduceMotion } from "./theme";

// One shared 100ms clock for everything that moves (spinners, avatars), as the desktop app has
// (components/spinner.tsx): not a timer each, and none at all when nothing on screen is moving.
let tick = 0;
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(fn: () => void) {
  subs.add(fn);
  timer ??= setInterval(() => {
    tick++;
    for (const s of subs) s();
  }, 100);
  return () => {
    subs.delete(fn);
    if (!subs.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
const still = () => () => {};

// The current tick (100ms each), or 0 forever under Reduce Motion or when `on` is false.
export function useTick(on = true): number {
  const reduce = useReduceMotion();
  const live = on && !reduce;
  return useSyncExternalStore(live ? subscribe : still, () => (live ? tick : 0));
}
