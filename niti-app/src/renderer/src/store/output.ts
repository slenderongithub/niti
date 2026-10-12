import { create } from "zustand";

// The pager: multi-line command results, `!cmd` output, help — one sheet, like the TUI's pager.
interface OutputState {
  open: boolean;
  title: string;
  body: string;
  mono: boolean;
  show(title: string, body: string, mono?: boolean): void;
  close(): void;
}

export const useOutput = create<OutputState>((set) => ({
  open: false,
  title: "",
  body: "",
  mono: true,
  show: (title, body, mono = true) => set({ open: true, title, body, mono }),
  close: () => set({ open: false }),
}));
