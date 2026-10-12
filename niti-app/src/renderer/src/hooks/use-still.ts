import { useReducedMotion } from "motion/react";
import { useUI } from "@/store/ui";

// True when motion should stop: the app's Reduce motion setting or the system's.
export function useStill(): boolean {
  const app = useUI((s) => s.reduceMotion);
  return useReducedMotion() || app;
}
