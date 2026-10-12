import { animate, useMotionValue, useTransform, motion } from "motion/react";
import { useEffect } from "react";
import { useUI } from "@/store/ui";
import { fmtTokens } from "@/lib/format";

// A count that rolls to its new value instead of jumping — token totals, costs, task counts.
export function AnimatedNumber({ value, format = fmtTokens, className }: { value: number; format?: (n: number) => string; className?: string }) {
  const still = useUI((s) => s.reduceMotion);
  const mv = useMotionValue(value);
  const text = useTransform(mv, (v) => format(v));
  useEffect(() => {
    if (still) {
      mv.set(value);
      return;
    }
    const c = animate(mv, value, { duration: 0.6, ease: [0.22, 1, 0.36, 1] });
    return () => c.stop();
  }, [value, still, mv]);
  return <motion.span className={className}>{text}</motion.span>;
}
