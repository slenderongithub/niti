import { create } from "zustand";
import type { ThemeSource } from "../../../shared/bridge";

// Per-viewer UI state. Remembered locally (theme, sidebar, panel sizes); everything about the
// project itself lives in the core and arrives through the session store.

export type Page = "session" | "tasks" | "tokens" | "graph" | "dashboard" | "settings";
export const PAGES: Page[] = ["session", "tasks", "tokens", "graph", "dashboard", "settings"];

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`niti.${key}`);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(`niti.${key}`, JSON.stringify(value));
  } catch {
    /* storage unavailable: keep the in-memory value */
  }
}

interface UIState {
  theme: ThemeSource;
  resolvedDark: boolean;
  page: Page;
  sidebarCollapsed: boolean;
  focusMode: boolean;
  contextPane: boolean; // the session view's right-hand files/viewer pane
  focusedAgent: string | null; // null = all agents
  paletteOpen: boolean;
  paletteQuery: string;
  shortcutsOpen: boolean;
  modelPickerOpen: boolean;
  openFiles: string[]; // file tabs in the session's centre, in tab order
  activeFile: string | null; // the file tab on screen, or null for the agents view
  reduceMotion: boolean;
  setTheme(t: ThemeSource): void;
  setResolvedDark(d: boolean): void;
  go(p: Page): void;
  toggleSidebar(): void;
  toggleFocusMode(): void;
  toggleContextPane(open?: boolean): void;
  focusAgent(id: string | null): void;
  openPalette(query?: string): void;
  closePalette(): void;
  setShortcuts(open: boolean): void;
  setModelPicker(open: boolean): void;
  viewFile(path: string | null): void;
  closeFile(path: string): void;
  renameFile(from: string, to: string): void;
  setReduceMotion(v: boolean): void;
}

export const useUI = create<UIState>((set, get) => ({
  theme: load<ThemeSource>("theme", "system"),
  resolvedDark: true,
  page: "session",
  sidebarCollapsed: load("sidebarCollapsed", false),
  focusMode: false,
  contextPane: load("contextPane", true),
  focusedAgent: null,
  paletteOpen: false,
  paletteQuery: "",
  shortcutsOpen: false,
  modelPickerOpen: false,
  openFiles: [],
  activeFile: null,
  reduceMotion: false,
  setTheme(theme) {
    save("theme", theme);
    set({ theme });
    void window.niti.setTheme(theme).then((dark) => get().setResolvedDark(dark));
  },
  setResolvedDark(resolvedDark) {
    document.documentElement.classList.toggle("dark", resolvedDark);
    document.documentElement.style.colorScheme = resolvedDark ? "dark" : "light";
    set({ resolvedDark });
  },
  go: (page) => set({ page }),
  toggleSidebar() {
    const v = !get().sidebarCollapsed;
    save("sidebarCollapsed", v);
    set({ sidebarCollapsed: v });
  },
  toggleFocusMode: () => set((s) => ({ focusMode: !s.focusMode })),
  toggleContextPane(open) {
    const v = open ?? !get().contextPane;
    save("contextPane", v);
    set({ contextPane: v });
  },
  focusAgent: (focusedAgent) => set({ focusedAgent, activeFile: null }),
  openPalette: (paletteQuery = "") => set({ paletteOpen: true, paletteQuery }),
  closePalette: () => set({ paletteOpen: false, paletteQuery: "" }),
  setShortcuts: (shortcutsOpen) => set({ shortcutsOpen }),
  setModelPicker: (modelPickerOpen) => set({ modelPickerOpen }),
  // Opens (or focuses) a file as a tab in the session's centre — from the tree, a diff, the graph…
  viewFile(path) {
    if (!path) return set({ activeFile: null });
    const p = path.replace(/^\.\//, "");
    const { openFiles } = get();
    set({ openFiles: openFiles.includes(p) ? openFiles : [...openFiles, p], activeFile: p, page: "session" });
  },
  closeFile(path) {
    const { openFiles, activeFile } = get();
    const i = openFiles.indexOf(path);
    const next = openFiles.filter((f) => f !== path);
    set({ openFiles: next, activeFile: activeFile === path ? (next[Math.min(i, next.length - 1)] ?? null) : activeFile });
  },
  renameFile(from, to) {
    set((s) => ({ openFiles: s.openFiles.map((f) => (f === from ? to : f)), activeFile: s.activeFile === from ? to : s.activeFile }));
  },
  setReduceMotion(reduceMotion) {
    document.documentElement.classList.toggle("reduce-motion", reduceMotion);
    set({ reduceMotion });
  },
}));
