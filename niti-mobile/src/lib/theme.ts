import { useColorScheme } from "react-native";
import { dark, light, type Theme } from "./colors";

export { resolveColor, type Theme } from "./colors";

export function useTheme(): Theme {
  return useColorScheme() === "light" ? light : dark;
}

export const mono = "JetBrainsMono_400Regular";
export const space = (n: number) => n * 4;
export const radius = 12;
