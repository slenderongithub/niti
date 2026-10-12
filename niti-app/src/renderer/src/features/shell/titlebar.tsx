import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bell, ChevronDown, Command as CommandIcon, Folder, FolderOpen, FolderX, AppWindow, Search, Hammer, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/ui/kbd";
import { Wordmark } from "@/components/brand";
import { BorderBeam } from "@/components/ui/border-beam";
import { Spinner } from "@/components/spinner";
import { ThemeToggle } from "@/components/theme-toggle";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { basename, shortPath } from "@/lib/format";
import { taskCounts } from "@/lib/reducer";
import { useApprovalUI } from "@/features/approvals/approval-center";
import type { RecentProject } from "../../../../shared/bridge";
import { cn } from "@/lib/utils";

export function Titlebar() {
  const root = useApp((s) => s.root) ?? "";
  const info = useApp((s) => s.info);
  const active = useApp((s) => s.session.active);
  const goal = useApp((s) => s.session.goal);
  const tasks = useApp((s) => s.session.tasks);
  const status = useApp((s) => s.session.status);
  const approvals = useApp((s) => s.session.approvals.length);
  const mode = useApp((s) => s.mode);
  const setMode = useApp((s) => s.setMode);
  const openProject = useApp((s) => s.openProject);
  const closeProject = useApp((s) => s.closeProject);
  const go = useUI((s) => s.go);
  const openPalette = useUI((s) => s.openPalette);
  const showApprovals = useApprovalUI((s) => s.show);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const c = taskCounts(tasks);

  useEffect(() => {
    void window.niti.recent().then(setRecent);
  }, [root]);

  return (
    <header className="drag flex h-11 shrink-0 items-center gap-2 pl-[84px] pr-2.5">
      <div className="no-drag flex items-center gap-1">
        <Wordmark size="sm" className="mr-2 hidden md:inline-flex" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 font-medium">
              <Folder className="size-3.5 text-muted-foreground" />
              <span className="max-w-48 truncate">{basename(root)}</span>
              <ChevronDown className="size-3 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuLabel className="truncate font-mono text-[11px] font-normal text-muted-foreground">{shortPath(root, info?.home)}</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => void window.niti.reveal(root)}>
              <Folder /> Reveal in Finder
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void window.niti.pickFolder().then((p) => { if (p) void openProject(p); })}>
              <FolderOpen /> Open folder… <DropdownMenuShortcut>⌘O</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void window.niti.newWindow()}>
              <AppWindow /> New window <DropdownMenuShortcut>⇧⌘N</DropdownMenuShortcut>
            </DropdownMenuItem>
            {recent.filter((r) => r.root !== root).length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs">Recent</DropdownMenuLabel>
                {recent
                  .filter((r) => r.root !== root)
                  .slice(0, 6)
                  .map((r) => (
                    <DropdownMenuItem key={r.root} onClick={() => void window.niti.newWindow(r.root)}>
                      <Folder className="text-muted-foreground" />
                      <span className="truncate">{r.name}</span>
                    </DropdownMenuItem>
                  ))}
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => void closeProject()}>
              <FolderX /> Close project <DropdownMenuShortcut>⇧⌘W</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* run status */}
      <div className="flex min-w-0 flex-1 justify-center">
        <AnimatePresence mode="wait" initial={false}>
          {active ? (
            <motion.div key="run" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} className="no-drag min-w-0">
              <Button variant="ghost" size="sm" className="relative h-7 max-w-[min(520px,45vw)] gap-2 rounded-full border bg-card px-3 text-xs shadow-panel" onClick={() => go("tasks")}>
                {/* The team is at work: a light travels the pill's rim for as long as the run lasts. */}
                <BorderBeam size={36} duration={5} />
                <Spinner className="text-info" />
                <span className="truncate font-normal">{goal || "Working"}</span>
                {c.total > 0 && (
                  <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground tabular">
                    <ListChecks className="size-3" /> {c.done}/{c.total}
                  </span>
                )}
              </Button>
            </motion.div>
          ) : status ? (
            <motion.span key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="truncate text-xs text-muted-foreground">
              {status}
            </motion.span>
          ) : null}
        </AnimatePresence>
      </div>

      <div className="no-drag flex items-center gap-1">
        <AnimatePresence>
          {approvals > 0 && (
            <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}>
              <Button size="sm" variant="outline" className="h-7 gap-1.5 border-warning/50 bg-warning/10 text-warning hover:bg-warning/15 hover:text-warning" onClick={showApprovals}>
                <Bell className="size-3.5" />
                {approvals} waiting
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn("h-7 gap-1.5 px-2 text-xs font-semibold", mode === "plan" ? "text-plan" : "text-primary")}
              onClick={() => setMode(mode === "plan" ? "build" : "plan")}
            >
              {mode === "plan" ? <ListChecks className="size-3.5" /> : <Hammer className="size-3.5" />}
              {mode === "plan" ? "Plan" : "Build"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {mode === "plan" ? "Plan mode: the lead plans without running" : "Build mode: plan and run"} <Kbd>⇧⇥</Kbd>
          </TooltipContent>
        </Tooltip>
        <Button data-perf="palette" variant="outline" size="sm" className="h-7 w-44 justify-start gap-2 bg-card/60 px-2.5 text-xs font-normal text-muted-foreground shadow-none" onClick={() => openPalette()}>
          <Search className="size-3.5" />
          Search or run…
          <Kbd className="ml-auto">
            <CommandIcon className="size-2.5" />K
          </Kbd>
        </Button>
        <ThemeToggle />
        {approvals > 0 && <Badge className="sr-only">{approvals} approvals</Badge>}
      </div>
    </header>
  );
}
