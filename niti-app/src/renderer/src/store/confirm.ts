import { create } from "zustand";

// One app-wide confirm dialog, awaited like a function: `if (await ask({...})) …`.
interface Ask {
  title: string;
  description?: string;
  confirm: string;
  alt?: string; // a third choice, e.g. "Don't save"
  cancel?: string;
  destructive?: boolean;
}
type Answer = "confirm" | "alt" | "cancel";

interface ConfirmState {
  ask: Ask | null;
  resolve: ((a: Answer) => void) | null;
  open(ask: Ask): Promise<Answer>;
  answer(a: Answer): void;
}

export const useConfirm = create<ConfirmState>((set, get) => ({
  ask: null,
  resolve: null,
  open: (ask) =>
    new Promise<Answer>((resolve) => {
      get().resolve?.("cancel");
      set({ ask, resolve });
    }),
  answer(a) {
    get().resolve?.(a);
    set({ ask: null, resolve: null });
  },
}));

export const ask = (a: Ask) => useConfirm.getState().open(a);
