import { useEffect, useState, type DragEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Folder, FolderOpen, FolderPlus, MoreHorizontal, Trash2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardAction } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { Wordmark } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { agentColor, tint } from "@/lib/identity";
import { PixelAvatar } from "@/components/pixel-avatar";
import { fmtAgo, shortPath } from "@/lib/format";
import { useApp } from "@/store/app";
import { WindowChrome } from "./window-chrome";
import type { RecentProject } from "../../../../shared/bridge";

export function LaunchScreen() {
  const info = useApp((s) => s.info);
  const openProject = useApp((s) => s.openProject);
  const [recent, setRecent] = useState<RecentProject[] | null>(null);
  const [dragging, setDragging] = useState(false);

  const load = () => void window.niti.recent().then(setRecent);
  useEffect(load, []);

  const pick = async () => {
    const p = await window.niti.pickFolder();
    if (p) void openProject(p);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) void openProject(window.niti.pathForFile(f));
  };

  return (
    <div
      className="ambient relative flex h-full flex-col overflow-hidden bg-background"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <WindowChrome>
        <ThemeToggle />
      </WindowChrome>

      <div className="relative z-10 mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-y-auto px-8 pb-10 pt-[8vh] scrollbar-thin">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
          <Wordmark size="xl" />
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={pick} className="gap-2.5 pr-3">
              <FolderOpen />
              Open a folder
              <Kbd className="ml-1 bg-primary-foreground/15 text-primary-foreground">⌘O</Kbd>
            </Button>
            <span className="text-sm text-muted-foreground">or drop one here</span>
          </div>
        </motion.div>

        <motion.div className="mt-14" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
          <Card className="gap-0 py-0 shadow-float">
            <CardHeader className="min-h-14 items-center border-b py-3 [.border-b]:pb-3">
              <CardTitle className="text-sm">Recent projects</CardTitle>
              <CardAction>
                <Button variant="ghost" size="sm" onClick={pick}>
                  <FolderPlus /> Open…
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="p-1.5">
              {recent === null ? (
                <div className="h-24" />
              ) : recent.length === 0 ? (
                <Empty className="py-10">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Search />
                    </EmptyMedia>
                    <EmptyTitle>No projects yet</EmptyTitle>
                    <EmptyDescription>Open a folder and niti will help you pick a team for it.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <ul className="flex flex-col">
                  <AnimatePresence initial={false}>
                    {recent.map((r, i) => (
                      <motion.li
                        key={r.root}
                        layout
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0, transition: { delay: 0.03 * i } }}
                        exit={{ opacity: 0, height: 0 }}
                        className="group relative"
                      >
                        <Button variant="ghost" className="h-auto w-full justify-start gap-3.5 rounded-lg py-2.5 pl-3 pr-11 text-left" onClick={() => void openProject(r.root)}>
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-primary/12 group-hover:text-primary">
                            <Folder className="size-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{r.name}</span>
                            <span className="block truncate font-mono text-[11px] font-normal text-muted-foreground">{shortPath(r.root, info?.home)}</span>
                          </span>
                          {r.team && r.team.length > 0 && (
                            <span className="hidden items-center -space-x-1 sm:flex" title={r.team.map((t) => `${t.role} · ${t.model}`).join("\n")}>
                              {r.team.slice(0, 6).map((_, j) => (
                                <span key={j} className="flex size-6 items-center justify-center rounded-md ring-2 ring-card" style={{ background: `color-mix(in oklab, ${tint(agentColor(j), 22)}, var(--card))` }}>
                                  <PixelAvatar slot={j} color={agentColor(j)} size={15} />
                                </span>
                              ))}
                            </span>
                          )}
                          <span className="w-16 shrink-0 text-right text-xs font-normal text-muted-foreground tabular">{fmtAgo(r.lastOpened)}</span>
                        </Button>
                        <div className="absolute right-2.5 top-1/2 -translate-y-1/2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon-xs" aria-label="More">
                                <MoreHorizontal />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => void window.niti.newWindow(r.root)}>Open in new window</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void window.niti.reveal(r.root)}>Reveal in Finder</DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem variant="destructive" onClick={() => void window.niti.forgetRecent(r.root).then(load)}>
                                <Trash2 /> Remove from recents
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              )}
            </CardContent>
          </Card>
        </motion.div>
        <div className="mt-auto pt-10 text-center text-[11px] text-muted-foreground/70">
          niti {info?.version} · <span className="font-mono">{info?.core}</span>
        </div>
      </div>

      <AnimatePresence>
        {dragging && (
          <motion.div
            className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-background/90"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
          >
            <div className="flex flex-col items-center gap-3 text-primary">
              <FolderOpen className="size-10" />
              <span className="text-sm font-medium">Drop to open this folder</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
