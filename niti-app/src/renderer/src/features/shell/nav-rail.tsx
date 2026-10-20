import { motion } from "motion/react";
import { Boxes, Coins, LayoutDashboard, ListTodo, MessagesSquare, PanelLeftClose, PanelLeftOpen, Settings2, Waypoints, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/ui/kbd";
import { AgentAvatar } from "@/components/agent-avatar";
import { useUI, type Page } from "@/store/ui";
import { useApp } from "@/store/app";
import { useAgentsLite } from "@/hooks/use-agents-lite";
import { taskCounts } from "@/lib/reducer";
import type { AgentStatus } from "@/lib/identity";
import { cn } from "@/lib/utils";

const ITEMS: { page: Page; label: string; icon: LucideIcon; shortcut: string }[] = [
  { page: "session", label: "Session", icon: MessagesSquare, shortcut: "1" },
  { page: "tasks", label: "Tasks", icon: ListTodo, shortcut: "2" },
  { page: "tokens", label: "Tokens", icon: Coins, shortcut: "3" },
  { page: "graph", label: "Graph", icon: Waypoints, shortcut: "4" },
  { page: "dashboard", label: "Dashboard", icon: LayoutDashboard, shortcut: "5" },
  { page: "models", label: "Models", icon: Boxes, shortcut: "6" },
];

export function NavRail() {
  const page = useUI((s) => s.page);
  const go = useUI((s) => s.go);
  const collapsed = useUI((s) => s.sidebarCollapsed);
  const toggle = useUI((s) => s.toggleSidebar);
  const focusAgent = useUI((s) => s.focusAgent);
  const agents = useAgentsLite();
  const lead = useApp((s) => s.session.leadId);
  const tasks = useApp((s) => s.session.tasks);
  const approvals = useApp((s) => s.session.approvals.length);
  const running = taskCounts(tasks).running;

  // Models: how many downloads are running, so one started from a sheet stays in view.
  const downloading = useApp((s) => Object.values(s.session.local.downloads).filter((d) => d.state === "downloading" || d.state === "queued" || d.state === "verifying").length);
  const badge = (p: Page) => (p === "tasks" && running ? running : p === "session" && approvals ? approvals : p === "models" && downloading ? downloading : 0);

  return (
    <motion.nav
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: collapsed ? 60 : 208, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 40 }}
      className="flex shrink-0 flex-col overflow-hidden pb-2"
    >
      <div className="flex flex-col gap-0.5 px-2.5 pt-1">
        {ITEMS.map((it) => (
          <NavItem key={it.page} {...it} active={page === it.page} collapsed={collapsed} badge={badge(it.page)} onClick={() => go(it.page)} />
        ))}
      </div>

      <div className={cn("mt-5 px-2.5", collapsed && "px-0")}>
        {!collapsed && <div className="mb-1.5 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">Team</div>}
        <div className={cn("flex flex-col gap-0.5", collapsed && "items-center gap-1.5")}>
          {agents.map((a) => {
            const id = a.id;
            const item = (
              <Button
                key={id}
                variant="ghost"
                size="sm"
                className={cn("h-8 justify-start gap-2.5 px-2 font-normal", collapsed && "size-9 justify-center p-0")}
                onClick={() => {
                  go("session");
                  focusAgent(id);
                }}
              >
                <AgentAvatar slot={a.index} color={a.color} status={a.status as AgentStatus} showStatus lead={id === lead} size="xs" />
                {!collapsed && (
                  <>
                    <span className="truncate text-[13px]">{a.role}</span>
                    <span className="ml-auto truncate text-[10px] capitalize text-muted-foreground">{a.status === "idle" ? "" : a.status}</span>
                  </>
                )}
              </Button>
            );
            return collapsed ? (
              <Tooltip key={id}>
                <TooltipTrigger asChild>{item}</TooltipTrigger>
                <TooltipContent side="right">
                  {a.role} · {a.status}
                </TooltipContent>
              </Tooltip>
            ) : (
              item
            );
          })}
        </div>
      </div>

      <div className="mt-auto flex flex-col gap-0.5 px-2.5">
        <NavItem page="settings" label="Settings" icon={Settings2} shortcut="," active={page === "settings"} collapsed={collapsed} onClick={() => go("settings")} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={toggle} className={cn("h-8 justify-start gap-2.5 px-2.5 font-normal text-muted-foreground", collapsed && "justify-center px-0")}>
              {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
              {!collapsed && <span className="text-[13px]">Collapse</span>}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            Toggle sidebar <Kbd>⌘B</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>
    </motion.nav>
  );
}

function NavItem({
  label,
  icon: Icon,
  shortcut,
  active,
  collapsed,
  badge,
  onClick,
}: {
  page: Page;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  active: boolean;
  collapsed: boolean;
  badge?: number;
  onClick: () => void;
}) {
  const btn = (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      data-nav={label.toLowerCase()}
      className={cn(
        "relative h-8 justify-start gap-2.5 px-2.5 font-normal text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
        active && "text-foreground hover:bg-transparent",
        collapsed && "justify-center px-0",
      )}
    >
      {active && (
        <motion.span layoutId="nav-active" className="absolute inset-0 rounded-md border bg-background shadow-sm" transition={{ type: "spring", stiffness: 500, damping: 38 }}>
          {/* The accent edge: where you are, readable at a glance even with the rail collapsed. */}
          <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary" />
        </motion.span>
      )}
      <Icon className={cn("relative z-10", active && "text-primary")} />
      {!collapsed && <span className="relative z-10 text-[13px]">{label}</span>}
      {!!badge && (
        <span
          className={cn(
            "relative z-10 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground tabular",
            collapsed ? "absolute right-1 top-0.5 h-3.5 min-w-3.5 text-[9px]" : "ml-auto",
          )}
        >
          {badge}
        </span>
      )}
    </Button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent side="right">
        {label} {shortcut && <Kbd>⌘{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}
