import { useEffect, useRef } from "react";
import { useApp } from "@/store/app";

// Starts a harness run (NITI_APP_SMOKE / PERF / AUDIT) once the session is live — once per launch.
export function useHarness(kind: "smoke" | "perf" | "audit", run: () => Promise<void>) {
  const on = useApp((s) => s.info?.harness === kind);
  const phase = useApp((s) => s.phase);
  const ready = useApp((s) => s.session.ready);
  const ran = useRef(false);
  useEffect(() => {
    if (!on || phase !== "session" || !ready || ran.current) return;
    ran.current = true;
    void run();
  }, [on, phase, ready]); // eslint-disable-line react-hooks/exhaustive-deps -- runs once, by design
}
