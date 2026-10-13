import { useEffect, useMemo, useState } from "react";
import {
  AppWindow,
  Bell,
  Coins,
  CornerDownLeft,
  FolderOpen,
  FolderTree,
  FolderX,
  Hammer,
  History,
  Keyboard,
  LayoutDashboard,
  LayoutGrid,
  ListChecks,
  ListTodo,
  Maximize2,
  MessagesSquare,
  Moon,
  PanelLeft,
  Repeat,
  RotateCw,
  Settings2,
  Slash,
  Square,
  Sun,
  Waypoints,
  Folder,
  HelpCircle,
} from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { interrupt, LOCAL_COMMANDS, runSlash, showHelp } from "@/lib/actions";
import { useApp } from "@/store/app";
import { load, useUI } from "@/store/ui";
import { historyKey } from "@/features/session/composer";
import { useApprovalUI } from "@/features/approvals/approval-center";
import { PixelAvatar } from "@/components/pixel-avatar";
import type { RecentProject } from "../../../../shared/bridge";

const NEEDS_ARGS = new Set(["branch", "debate", "model"]);

export function CommandPalette() {
  const open = useUI((s) => s.paletteOpen);
  const close = useUI((s) => s.closePalette);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="top-[18%] w-[min(640px,92vw)] max-w-none translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-none" showCloseButton={false}>
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">Search pages, actions, agents and commands</DialogDescription>
        {open && <PaletteBody />}
      </DialogContent>
    </Dialog>
  );
}

// Mounted only while open, so the whole-store subscription below costs nothing the rest of the time.
function PaletteBody() {
  const open = true;
  const initial = useUI((s) => s.paletteQuery);
  const close = useUI((s) => s.closePalette);
  const ui = useUI();
  const app = useApp();
  const showApprovals = useApprovalUI((s) => s.show);
  const [q, setQ] = useState("");
  const [recent, setRecent] = useState<RecentProject[]>([]);

  useEffect(() => {
    if (!open) return;
    setQ(initial);
    void window.niti.recent().then(setRecent);
  }, [open, initial]);

  const history = useMemo(() => {
    if (!open) return [];
    return load<string[]>(historyKey(app.root ?? ""), []).slice(-50).reverse();
  }, [open, app.root]);

  const historyMode = q.startsWith("history:");
  const run = (fn: () => void) => {
    close();
    setTimeout(fn, 0);
  };
  const prefill = (t: string) =>
    run(() => {
      ui.go("session");
      setTimeout(() => window.dispatchEvent(new CustomEvent("niti:prefill", { detail: t })), 50);
    });

  const s = app.session;
  const commands = [...LOCAL_COMMANDS, ...app.commands.filter((c) => !LOCAL_COMMANDS.some((l) => l.name === c.name))];

  return (
        <Command loop className="[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-item]]:py-2">
          <CommandInput value={q} onValueChange={setQ} placeholder={historyMode ? "Search your prompt history…" : "Search pages, actions, agents, commands…"} className="h-12 text-[14px]" />
          <CommandList className="max-h-[420px]">
            <CommandEmpty>Nothing matches.</CommandEmpty>
            {historyMode ? (
              <CommandGroup heading="History">
                {history.map((h, i) => (
                  <CommandItem key={i} value={`history: ${h}`} onSelect={() => prefill(h)}>
                    <History />
                    <span className="truncate">{h}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : (
              <>
                <CommandGroup heading="Go to">
                  {(
                    [
                      ["session", "Session", MessagesSquare, "⌘1"],
                      ["tasks", "Tasks", ListTodo, "⌘2"],
                      ["tokens", "Tokens", Coins, "⌘3"],
                      ["graph", "Graph", Waypoints, "⌘4"],
                      ["dashboard", "Dashboard", LayoutDashboard, "⌘5"],
                      ["settings", "Settings", Settings2, "⌘,"],
                    ] as const
                  ).map(([p, label, Icon, k]) => (
                    <CommandItem key={p} value={`go ${label}`} onSelect={() => run(() => ui.go(p))}>
                      <Icon /> {label}
                      <CommandShortcut>{k}</CommandShortcut>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading="Actions">
                  <CommandItem value="new prompt message team" onSelect={() => run(() => (ui.go("session"), window.dispatchEvent(new Event("niti:focus-composer"))))}>
                    <CornerDownLeft /> Message the team
                  </CommandItem>
                  {s.active && (
                    <CommandItem value="stop interrupt cancel run" onSelect={() => run(() => void interrupt())}>
                      <Square /> Stop the run <CommandShortcut>esc</CommandShortcut>
                    </CommandItem>
                  )}
                  {s.approvals.length > 0 && (
                    <CommandItem value="approvals waiting review" onSelect={() => run(showApprovals)}>
                      <Bell /> Review {s.approvals.length} waiting approval{s.approvals.length === 1 ? "" : "s"}
                    </CommandItem>
                  )}
                  <CommandItem value="mode build plan toggle" onSelect={() => run(() => app.setMode(app.mode === "plan" ? "build" : "plan"))}>
                    {app.mode === "plan" ? <Hammer /> : <ListChecks />} Switch to {app.mode === "plan" ? "Build" : "Plan"} mode <CommandShortcut>⇧⇥</CommandShortcut>
                  </CommandItem>
                  <CommandItem value="model switch change" onSelect={() => run(() => ui.setModelPicker(true))}>
                    <Repeat /> Switch an agent's model <CommandShortcut>⌘L</CommandShortcut>
                  </CommandItem>
                  <CommandItem value="theme light dark toggle appearance" onSelect={() => run(() => ui.setTheme(ui.resolvedDark ? "light" : "dark"))}>
                    {ui.resolvedDark ? <Sun /> : <Moon />} Switch to {ui.resolvedDark ? "light" : "dark"} theme
                  </CommandItem>
                  <CommandItem value="files show hide pane" onSelect={() => run(() => ui.toggleContextPane())}>
                    <FolderTree /> {ui.contextPane ? "Hide" : "Show"} files
                  </CommandItem>
                  <CommandItem value="sidebar toggle collapse" onSelect={() => run(ui.toggleSidebar)}>
                    <PanelLeft /> Toggle sidebar <CommandShortcut>⌘B</CommandShortcut>
                  </CommandItem>
                  <CommandItem value="focus mode zen" onSelect={() => run(ui.toggleFocusMode)}>
                    <Maximize2 /> Focus mode <CommandShortcut>⌘.</CommandShortcut>
                  </CommandItem>
                  <CommandItem value="history prompts search" onSelect={() => setQ("history: ")}>
                    <History /> Search prompt history <CommandShortcut>⌘R</CommandShortcut>
                  </CommandItem>
                  <CommandItem value="shortcuts keyboard keys" onSelect={() => run(() => ui.setShortcuts(true))}>
                    <Keyboard /> Keyboard shortcuts <CommandShortcut>⌘/</CommandShortcut>
                  </CommandItem>
                  <CommandItem value="help commands" onSelect={() => run(showHelp)}>
                    <HelpCircle /> Help
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading="Agents">
                  <CommandItem value="agent all overview" onSelect={() => run(() => (ui.go("session"), ui.focusAgent(null)))}>
                    <LayoutGrid /> All agents
                  </CommandItem>
                  {s.order.map((id, i) => {
                    const a = s.agents[id]!;
                    return (
                      <CommandItem key={id} value={`agent ${a.cfg.role} ${id} ${a.cfg.model}`} onSelect={() => run(() => (ui.go("session"), ui.focusAgent(id)))}>
                        <PixelAvatar slot={a.index} color={a.color} size={16} />
                        {a.cfg.role}
                        <span className="text-xs text-muted-foreground">{a.cfg.model}</span>
                        <CommandShortcut>⌥{i + 1}</CommandShortcut>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading="Commands">
                  {commands.map((c) => (
                    <CommandItem key={c.name} value={`/${c.name} ${c.description}`} onSelect={() => (NEEDS_ARGS.has(c.name) ? prefill(`/${c.name} `) : run(() => void runSlash(`/${c.name}`)))}>
                      <Slash />
                      <span className="font-mono text-[13px]">{c.name}</span>
                      <span className="truncate text-xs text-muted-foreground">{c.description}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading="Project">
                  <CommandItem value="open folder project" onSelect={() => run(() => void window.niti.pickFolder().then((p) => { if (p) void app.openProject(p); }))}>
                    <FolderOpen /> Open folder… <CommandShortcut>⌘O</CommandShortcut>
                  </CommandItem>
                  <CommandItem value="new window" onSelect={() => run(() => void window.niti.newWindow())}>
                    <AppWindow /> New window
                  </CommandItem>
                  {recent
                    .filter((r) => r.root !== app.root)
                    .slice(0, 5)
                    .map((r) => (
                      <CommandItem key={r.root} value={`recent project ${r.name} ${r.root}`} onSelect={() => run(() => void window.niti.newWindow(r.root))}>
                        <Folder /> {r.name}
                        <span className="truncate font-mono text-[11px] text-muted-foreground">{r.root}</span>
                      </CommandItem>
                    ))}
                  <CommandItem value="restart core engine" onSelect={() => run(() => void app.restartCore())}>
                    <RotateCw /> Restart niti-core
                  </CommandItem>
                  <CommandItem value="close project" onSelect={() => run(() => void app.closeProject())}>
                    <FolderX /> Close project
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
  );
}
