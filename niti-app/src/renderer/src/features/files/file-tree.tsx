import { useEffect, useMemo, useState } from "react";
import { ChevronRight, File, FileDiff, Folder, FolderOpen, Loader2, Search, SearchX } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";

interface Node {
  name: string;
  path: string;
  dir: boolean;
  children: Node[];
}

function build(files: string[]): Node {
  const root: Node = { name: "", path: "", dir: true, children: [] };
  for (const f of files) {
    const parts = f.split("/");
    let cur = root;
    parts.forEach((p, i) => {
      const isDir = i < parts.length - 1;
      let next = cur.children.find((c) => c.name === p && c.dir === isDir);
      if (!next) {
        next = { name: p, path: parts.slice(0, i + 1).join("/"), dir: isDir, children: [] };
        cur.children.push(next);
      }
      cur = next;
    });
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

const MARK: Record<string, { label: string; cls: string }> = {
  M: { label: "M", cls: "text-warning" },
  A: { label: "A", cls: "text-success" },
  R: { label: "·", cls: "text-muted-foreground" },
};

// The project tree with what the agents touched (files.go:160-217): M edited, A created, · read.
export function FileTree() {
  const api = useApp((s) => s.api);
  const touched = useApp((s) => s.session.touched);
  const epoch = useApp((s) => s.session.fileEpoch);
  const open = useUI((s) => s.activeFile);
  const view = useUI((s) => s.viewFile);
  const [files, setFiles] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [q, setQ] = useState("");
  const [onlyTouched, setOnlyTouched] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const t = setTimeout(() => {
      void api
        .files()
        .then((r) => {
          if (cancelled) return;
          setFiles(r.files);
          setTruncated(r.truncated);
        })
        .catch(() => !cancelled && setFiles([]));
    }, files ? 400 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [api, epoch]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    let list = files ?? [];
    if (onlyTouched) list = list.filter((f) => touched[f] === "M" || touched[f] === "A");
    if (q.trim()) {
      const s = q.toLowerCase();
      list = list.filter((f) => f.toLowerCase().includes(s));
    }
    return list;
  }, [files, onlyTouched, touched, q]);
  const tree = useMemo(() => build(visible), [visible]);
  const autoOpen = Boolean(q.trim()) || onlyTouched;
  const changedCount = Object.values(touched).filter((v) => v !== "R").length;

  const dirMark = (n: Node): string | undefined => {
    const pre = n.path + "/";
    let m: string | undefined;
    for (const [p, k] of Object.entries(touched)) {
      if (!p.startsWith(pre)) continue;
      if (k === "M" || k === "A") return "M";
      m = "R";
    }
    return m;
  };

  const render = (n: Node, depth: number): React.ReactNode =>
    n.children.map((c) => {
      if (c.dir) {
        const isOpen = autoOpen || expanded.has(c.path);
        const mark = dirMark(c);
        return (
          <div key={c.path}>
            <Button
              variant="ghost"
              size="xs"
              className="h-6 w-full justify-start gap-1 rounded-sm px-1 font-normal"
              style={{ paddingLeft: 4 + depth * 12 }}
              onClick={() =>
                setExpanded((s) => {
                  const next = new Set(s);
                  if (next.has(c.path)) next.delete(c.path);
                  else next.add(c.path);
                  return next;
                })
              }
            >
              <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
              {isOpen ? <FolderOpen className="size-3.5 shrink-0 text-primary/80" /> : <Folder className="size-3.5 shrink-0 text-primary/80" />}
              <span className="truncate text-[12px]">{c.name}</span>
              {mark === "M" && <span className="ml-auto size-1.5 rounded-full bg-warning" />}
            </Button>
            {isOpen && render(c, depth + 1)}
          </div>
        );
      }
      const mark = touched[c.path];
      return (
        <Button
          key={c.path}
          variant="ghost"
          size="xs"
          className={cn("h-6 w-full justify-start gap-1.5 rounded-sm px-1 font-normal", open === c.path && "bg-primary/10 text-primary hover:bg-primary/15")}
          style={{ paddingLeft: 20 + depth * 12 }}
          onClick={() => view(c.path)}
        >
          <File className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={cn("truncate text-[12px]", mark === "M" && "text-warning", mark === "A" && "text-success")}>{c.name}</span>
          {mark && <span className={cn("ml-auto font-mono text-[10px] font-semibold", MARK[mark]!.cls)}>{MARK[mark]!.label}</span>}
        </Button>
      );
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b p-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter files…" className="h-8 pl-8 text-xs" />
        </div>
        <div className="flex items-center justify-between px-0.5">
          <Label htmlFor="only-touched" className="text-[11px] font-normal text-muted-foreground">
            Changed only {changedCount > 0 && <span className="text-warning">({changedCount})</span>}
          </Label>
          <Switch id="only-touched" size="sm" checked={onlyTouched} onCheckedChange={setOnlyTouched} />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-1.5">
          {files === null ? (
            <div className="flex justify-center py-8 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : visible.length === 0 ? (
            <EmptyState compact icon={onlyTouched ? FileDiff : SearchX} title={onlyTouched ? "No files changed yet" : "No files match"} className="m-1 h-auto min-h-40" />
          ) : (
            render(tree, 0)
          )}
          {truncated && <div className="px-2 py-2 text-[11px] text-muted-foreground">Showing the first {files?.length} files.</div>}
        </div>
      </ScrollArea>
    </div>
  );
}
