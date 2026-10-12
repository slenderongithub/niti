import { useEffect } from "react";
import { MotionConfig, motion } from "motion/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { useEditor } from "@/store/editor";
import { LaunchScreen } from "@/features/launch/launch-screen";
import { TrustScreen } from "@/features/launch/trust-screen";
import { StartingScreen } from "@/features/launch/starting-screen";
import { ErrorScreen } from "@/features/launch/error-screen";
import { TeamSetup } from "@/features/setup/team-setup";
import { AppShell } from "@/features/shell/app-shell";
import { useGlobalShortcuts } from "@/hooks/use-global-shortcuts";
import { useSmoke } from "@/hooks/use-smoke";
import { usePerf } from "@/hooks/use-perf";
import { useAudit } from "@/hooks/use-audit";
import { ErrorBoundary } from "@/components/error-boundary";
import { ConfirmHost } from "@/components/confirm-host";

export function App() {
  const phase = useApp((s) => s.phase);
  const reduce = useUI((s) => s.reduceMotion);

  useEffect(() => {
    const ui = useUI.getState();
    void window.niti.setTheme(ui.theme).then((dark) => ui.setResolvedDark(dark));
    const off = window.niti.onSystemTheme((dark) => {
      if (useUI.getState().theme === "system") useUI.getState().setResolvedDark(dark);
    });
    void useApp.getState().init();
    // Closing the window with unsaved edits or a goal still running asks first (main shows the dialog).
    window.onbeforeunload = (e) => {
      if (!useEditor.getState().anyDirty().length && !useApp.getState().session.active) return;
      e.preventDefault();
      e.returnValue = "";
    };
    return off;
  }, []);
  useGlobalShortcuts();
  useSmoke();
  usePerf();
  useAudit();

  const screen =
    phase === "launch" ? <LaunchScreen /> :
    phase === "trust" ? <TrustScreen /> :
    phase === "starting" || phase === "restarting" ? <StartingScreen restarting={phase === "restarting"} /> :
    phase === "setup" ? <TeamSetup /> :
    phase === "error" ? <ErrorScreen /> :
    <AppShell />;
  const key = phase === "restarting" ? "starting" : phase;

  return (
    <MotionConfig reducedMotion={reduce ? "always" : "user"} transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}>
      <TooltipProvider delayDuration={350}>
        {/* Enter-only: the next screen starts the frame you asked for it, never waiting on an exit. */}
        <motion.div key={key} className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.14, ease: "easeOut" }}>
          <ErrorBoundary name={key}>{screen}</ErrorBoundary>
        </motion.div>
        <ConfirmHost />
        <Toaster position="bottom-right" richColors={false} closeButton />
      </TooltipProvider>
    </MotionConfig>
  );
}
