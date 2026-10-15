import { useEffect, useState } from "react";
import { AccessibilityInfo, useColorScheme } from "react-native";
import { dark, light, type Theme } from "./colors";

export { alpha, resolveColor, type ColorToken, type Theme } from "./colors";

export function useTheme(): Theme {
  return useColorScheme() === "light" ? light : dark;
}

// The desktop app's type: Inter for words, JetBrains Mono for anything code-shaped (models, paths,
// commands, numbers in columns). React Native picks a weight by family, not fontWeight.
export const fonts = {
  sans: { regular: "Inter_400Regular", medium: "Inter_500Medium", semibold: "Inter_600SemiBold", bold: "Inter_700Bold" },
  mono: { regular: "JetBrainsMono_400Regular", medium: "JetBrainsMono_500Medium", semibold: "JetBrainsMono_600SemiBold", bold: "JetBrainsMono_600SemiBold" },
};
export type Weight = keyof typeof fonts.sans;

// The desktop's scale (11 · 12.5 · 13 · 14 · 15 px), each step two points up for a phone held at arm's length.
export const type = { label: 12, xs: 13, sm: 14, base: 15, lg: 17, xl: 20, display: 28 };

// Tailwind's 4pt grid, and the app's radius (--radius: 0.75rem): sm 8 · md 10 · lg 12 · xl 16.
export const space = (n: number) => n * 4;
export const radius = { sm: 8, md: 10, lg: 12, xl: 16, full: 999 };

// The minimum touch target (Apple HIG). Controls that look smaller extend to it with hitSlop.
export const TOUCH = 44;

// iOS's Reduce Motion, which the desktop app's `.reduce-motion` mirrors: spinners hold still,
// avatars stop blinking and bobbing.
export function useReduceMotion(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setOn);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setOn);
    return () => sub.remove();
  }, []);
  return on;
}
