import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ErrorBoundary } from "@/components/error-boundary";
import { useUI, type Page } from "@/store/ui";
import { useApp } from "@/store/app";
import { Titlebar } from "./titlebar";
import { NavRail } from "./nav-rail";
import { StatusBar } from "./status-bar";
import { SessionPage } from "@/features/session/session-page";
import { CommandPalette } from "@/features/palette/command-palette";
import { ApprovalCenter } from "@/features/approvals/approval-center";
import { ModelPicker } from "@/features/palette/model-picker";
import { ShortcutsDialog } from "@/features/palette/shortcuts-dialog";
import { OutputSheet } from "./output-sheet";
import { CoreExitDialog } from "./core-exit-dialog";
import { useRunNotifications } from "@/hooks/use-run-notifications";

import TasksPage from "@/features/tasks/tasks-page";
import TokensPage from "@/features/tokens/tokens-page";
import GraphPage from "@/features/graph/graph-page";
import DashboardPage from "@/features/dashboard/dashboard-page";
import SettingsPage from "@/features/settings/settings-page";

const PAGE_TITLE: Record<Page, string> = { session: "Session", tasks: "Tasks", tokens: "Tokens", graph: "Graph", dashboard: "Dashboard", settings: "Settings" };

export function AppShell() {
  const page = useUI((s) => s.page);
  const focusMode = useUI((s) => s.focusMode);
  const root = useApp((s) => s.root);
  useRunNotifications();

  useEffect(() => {
    document.title = `${PAGE_TITLE[page]} · ${root?.split("/").pop() ?? "niti"}`;
  }, [page, root]);

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <Titlebar />
      <div className="flex min-h-0 flex-1">
        <AnimatePresence initial={false}>{!focusMode && <NavRail />}</AnimatePresence>
        <main className="relative min-w-0 flex-1 overflow-hidden rounded-tl-xl border-l border-t bg-background shadow-[0_0_0_1px_var(--border)]">
          {/* Enter-only and short: the page you clicked is on screen the next frame. */}
          <motion.div key={page} data-page={page} className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.12, ease: "easeOut" }}>
            <ErrorBoundary name={page}>
              {page === "session" && <SessionPage />}
              {page === "tasks" && <TasksPage />}
              {page === "tokens" && <TokensPage />}
              {page === "graph" && <GraphPage />}
              {page === "dashboard" && <DashboardPage />}
              {page === "settings" && <SettingsPage />}
            </ErrorBoundary>
          </motion.div>
        </main>
      </div>
      <StatusBar />
      <CommandPalette />
      <ApprovalCenter />
      <ModelPicker />
      <ShortcutsDialog />
      <OutputSheet />
      <CoreExitDialog />
    </div>
  );
}
