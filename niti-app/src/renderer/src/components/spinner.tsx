import { useSyncExternalStore } from "react";
import { useUI } from "@/store/ui";
import { cn } from "@/lib/utils";

// The TUI's braille spinner (toolfeed.go:102-118). One shared 100ms ticker for every spinner on
// screen — not a timer each — and it stops when none are mounted.
const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
let frame = 0;
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(fn: () => void) {
  subs.add(fn);
  timer ??= setInterval(() => {
    frame = (frame + 1) % FRAMES.length;
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
const noop = () => () => {};

export function Spinner({ className }: { className?: string }) {
  const still = useUI((s) => s.reduceMotion);
  const f = useSyncExternalStore(still ? noop : subscribe, () => (still ? 0 : frame));
  return (
    <span aria-hidden className={cn("inline-block w-[1ch] font-mono text-primary", className)}>
      {FRAMES[f]}
    </span>
  );
}
