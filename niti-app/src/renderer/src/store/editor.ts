import { create } from "zustand";
import type { EditorState } from "@codemirror/state";
import { toast } from "sonner";
import { ask } from "./confirm";
import { useUI } from "./ui";

// Open files: what's on disk (content + mtime, for conflict checks) and whether you've changed it.
// The CodeMirror state per file lives outside React, so switching tabs keeps undo history.

export interface Buffer {
  status: "loading" | "ready" | "error";
  error?: string;
  saved: string; // last content known to be on disk
  mtimeMs: number;
  dirty: boolean;
  diskChanged: boolean; // changed on disk while you had unsaved edits
  diskMtime?: number; // that change's mtime: "Keep mine" adopts it, so the next save doesn't re-ask
}

export const editorStates = new Map<string, EditorState>();

interface EditorStore {
  bufs: Record<string, Buffer>;
  load(path: string): Promise<void>;
  setDirty(path: string, dirty: boolean): void;
  save(path: string, content: string, force?: boolean): Promise<boolean>;
  refresh(path: string): Promise<void>;
  dropDiskChange(path: string): void;
  forget(path: string): void;
  reset(): void;
  anyDirty(): string[];
}

function patch(path: string, p: Partial<Buffer>) {
  useEditor.setState((s) => ({ bufs: { ...s.bufs, [path]: { ...(s.bufs[path] ?? { status: "loading", saved: "", mtimeMs: 0, dirty: false, diskChanged: false }), ...p } } }));
}

export const useEditor = create<EditorStore>((set, get) => ({
  bufs: {},
  async load(path) {
    if (get().bufs[path]?.status === "ready") return;
    patch(path, { status: "loading" });
    try {
      const r = await window.niti.readFile(path);
      editorStates.delete(path);
      patch(path, { status: "ready", saved: r.content, mtimeMs: r.mtimeMs, dirty: false, diskChanged: false, error: undefined });
    } catch (e) {
      patch(path, { status: "error", error: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") });
    }
  },
  setDirty(path, dirty) {
    if (get().bufs[path]?.dirty !== dirty) patch(path, { dirty });
  },
  async save(path, content, force) {
    const b = get().bufs[path];
    try {
      const r = await window.niti.writeFile(path, content, force ? undefined : b?.mtimeMs);
      if (!r.ok) {
        const a = await ask({ title: `${path.split("/").pop()} changed on disk`, description: "An agent or another program changed this file after you opened it. Overwrite their change with yours, or reload theirs and lose your edits?", confirm: "Overwrite", alt: "Reload theirs", destructive: true });
        if (a === "confirm") return get().save(path, content, true);
        if (a === "alt") await get().refresh(path);
        return false;
      }
      patch(path, { saved: content, mtimeMs: r.mtimeMs, dirty: false, diskChanged: false });
      return true;
    } catch (e) {
      toast.error(`Couldn't save ${path}`, { description: (e as Error).message });
      return false;
    }
  },
  // Re-read from disk, replacing the buffer (the editor picks up `saved` when it changes).
  async refresh(path) {
    try {
      const r = await window.niti.readFile(path);
      patch(path, { status: "ready", saved: r.content, mtimeMs: r.mtimeMs, dirty: false, diskChanged: false });
    } catch (e) {
      patch(path, { status: "error", error: (e as Error).message });
    }
  },
  dropDiskChange(path) {
    const b = get().bufs[path];
    patch(path, { diskChanged: false, mtimeMs: b?.diskMtime ?? b?.mtimeMs ?? 0 });
  },
  forget(path) {
    editorStates.delete(path);
    set((s) => {
      const bufs = { ...s.bufs };
      delete bufs[path];
      return { bufs };
    });
  },
  // Buffers are keyed by project-relative path: a new project must not inherit them, or saving
  // one would write the old project's text over the new project's file of the same name.
  reset() {
    editorStates.clear();
    set({ bufs: {} });
  },
  anyDirty: () => Object.entries(get().bufs).filter(([, b]) => b.dirty).map(([p]) => p),
}));

// A file an agent (or anything else) changed: reload it if you haven't touched it; flag it if you have.
export async function noticeDiskChange(path: string) {
  const b = useEditor.getState().bufs[path];
  if (!b || b.status !== "ready") return;
  try {
    const r = await window.niti.readFile(path);
    if (Math.abs(r.mtimeMs - b.mtimeMs) <= 1 && r.content === b.saved) return;
    if (!b.dirty) patch(path, { saved: r.content, mtimeMs: r.mtimeMs });
    else patch(path, { diskChanged: true, diskMtime: r.mtimeMs });
  } catch {
    /* deleted or unreadable: leave the buffer as it is */
  }
}

// Closing a tab with unsaved edits asks first. Returns whether it closed.
export async function closeFileTab(path: string, current?: () => string): Promise<boolean> {
  const b = useEditor.getState().bufs[path];
  if (b?.dirty) {
    const a = await ask({ title: `Save changes to ${path.split("/").pop()}?`, description: "Your changes will be lost if you don't save them.", confirm: "Save", alt: "Don't save" });
    if (a === "cancel") return false;
    if (a === "confirm") {
      const text = current?.() ?? editorStates.get(path)?.doc.toString();
      if (text === undefined || !(await useEditor.getState().save(path, text))) return false;
    }
  }
  useUI.getState().closeFile(path);
  useEditor.getState().forget(path);
  return true;
}
