import { useEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, RangeSet, StateEffect, StateField } from "@codemirror/state";
import { EditorView, gutter, GutterMarker, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { ExternalLink, FileWarning, FolderSearch, Loader2, Lock, RefreshCw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/ui/kbd";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { editorStates, noticeDiskChange, useEditor } from "@/store/editor";
import { editorHighlight, editorTheme } from "./editor-theme";

// Lines agents changed this session, as a thin bar in its own gutter.
const setChanged = StateEffect.define<number[]>();
class ChangedMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-changed-marker";
    return el;
  }
}
const changedMarker = new ChangedMarker();
const changedField = StateField.define<number[]>({
  create: () => [],
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setChanged)) return e.value;
    return v;
  },
});
const changedGutter = gutter({
  class: "cm-changed-gutter",
  markers: (view) => {
    const lines = view.state.field(changedField);
    const doc = view.state.doc;
    const ranges = lines.filter((n) => n >= 1 && n <= doc.lines).map((n) => changedMarker.range(doc.line(n).from));
    return RangeSet.of(ranges, true);
  },
  initialSpacer: () => changedMarker,
});

export function CodeEditor({ path }: { path: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  const ro = useRef(new Compartment());
  const buf = useEditor((s) => s.bufs[path]);
  const load = useEditor((s) => s.load);
  const save = useEditor((s) => s.save);
  const refresh = useEditor((s) => s.refresh);
  const setDirty = useEditor((s) => s.setDirty);
  const dropDiskChange = useEditor((s) => s.dropDiskChange);
  const changed = useApp((s) => s.session.changedLines[path]);
  const lock = useApp((s) => s.session.locks[path]);
  const lockedBy = useApp((s) => (lock ? (s.session.agents[lock]?.cfg.role ?? lock) : null));
  const epoch = useApp((s) => s.session.fileEpoch);
  const touched = useApp((s) => s.session.touched[path]);
  const root = useApp((s) => s.root) ?? "";
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [langName, setLangName] = useState("Plain text");
  const saveRef = useRef<() => void>(() => {});

  useEffect(() => {
    void load(path);
  }, [path, load]);

  // A file the agents (or anything else) changed: reload or flag it.
  useEffect(() => {
    if (buf?.status === "ready") void noticeDiskChange(path);
  }, [epoch, touched]); // eslint-disable-line react-hooks/exhaustive-deps

  saveRef.current = () => {
    const v = view.current;
    if (v && !lock) void save(path, v.state.doc.toString());
  };

  // Build (or restore) the view for this file. Undo history survives tab switches via editorStates.
  const ready = buf?.status === "ready";
  useEffect(() => {
    if (!host.current || !ready) return;
    const b = useEditor.getState().bufs[path]!;
    let state = editorStates.get(path);
    if (!state) {
      state = EditorState.create({
        doc: b.saved,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab, { key: "Mod-s", preventDefault: true, run: () => (saveRef.current(), true) }]),
          editorTheme,
          editorHighlight,
          changedField,
          changedGutter,
          lang.current.of([]),
          ro.current.of(EditorState.readOnly.of(false)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setDirty(path, u.state.doc.toString() !== useEditor.getState().bufs[path]?.saved);
            if (u.selectionSet || u.docChanged) {
              const head = u.state.selection.main.head;
              const line = u.state.doc.lineAt(head);
              setCursor({ line: line.number, col: head - line.from + 1 });
            }
            editorStates.set(path, u.state);
          }),
        ],
      });
      editorStates.set(path, state);
    }
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    const desc = LanguageDescription.matchFilename(languages, path);
    setLangName(desc?.name ?? "Plain text");
    if (desc) void desc.load().then((support) => v.dom.isConnected && v.dispatch({ effects: lang.current.reconfigure(support) }));
    requestAnimationFrame(() => v.focus());
    return () => {
      editorStates.set(path, v.state);
      v.destroy();
      view.current = null;
    };
  }, [path, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // What's on disk changed (a reload you asked for, or an agent's edit to a file you hadn't touched):
  // swap the text in place, keeping the cursor where it was as far as the new text allows.
  useEffect(() => {
    const v = view.current;
    const b = useEditor.getState().bufs[path];
    if (!v || !b || b.dirty || v.state.doc.toString() === b.saved) return;
    const head = Math.min(v.state.selection.main.head, b.saved.length);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: b.saved }, selection: { anchor: head } });
    setDirty(path, false);
  }, [buf?.saved, path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    view.current?.dispatch({ effects: setChanged.of(changed ?? []) });
  }, [changed, buf?.saved, path]);

  useEffect(() => {
    view.current?.dispatch({ effects: ro.current.reconfigure(EditorState.readOnly.of(Boolean(lock))) });
  }, [lock, path, buf?.saved]);

  if (!buf || buf.status === "loading")
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  if (buf.status === "error") return <div className="h-full p-6"><EmptyState icon={FileWarning} title="Can't open this file here" description={buf.error} /></div>;

  const abs = `${root}/${path}`;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {buf.diskChanged && (
        <div className="flex h-10 shrink-0 items-center gap-3 border-b bg-warning/10 px-4 text-[12.5px] text-warning">
          <RefreshCw className="size-3.5" />
          <span className="flex-1">This file changed on disk while you were editing it.</span>
          <Button size="sm" variant="outline" className="h-7" onClick={() => void refresh(path)}>
            Reload theirs
          </Button>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => dropDiskChange(path)}>
            Keep mine
          </Button>
        </div>
      )}
      {lockedBy && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b bg-info/10 px-4 text-[12.5px] text-info">
          <Lock className="size-3.5" /> {lockedBy} is writing this file — read-only until it's done.
        </div>
      )}
      <div ref={host} className="min-h-0 flex-1 overflow-hidden" data-perf="editor" />
      <div className="flex h-8 shrink-0 items-center gap-3 border-t px-4 text-[11px] text-muted-foreground">
        <span className="truncate font-mono">{path}</span>
        <span className="ml-auto shrink-0 tabular">
          Ln {cursor.line}, Col {cursor.col}
        </span>
        <span className="shrink-0">{langName}</span>
        <span className={cn("flex shrink-0 items-center gap-1", buf.dirty ? "text-warning" : "text-success")}>
          {buf.dirty ? (
            <>
              <span className="size-1.5 rounded-full bg-warning" /> Unsaved <Kbd className="h-4 text-[10px]">⌘S</Kbd>
            </>
          ) : (
            "Saved"
          )}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" disabled={!buf.dirty || Boolean(lock)} onClick={() => saveRef.current()} aria-label="Save">
              <Save />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Save (⌘S)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={() => void window.niti.openPath(abs)} aria-label="Open in default app">
              <ExternalLink />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open in default app</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={() => void window.niti.reveal(abs)} aria-label="Reveal in Finder">
              <FolderSearch />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reveal in Finder</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

export function currentEditorText(path: string): string | undefined {
  return editorStates.get(path)?.doc.toString();
}
