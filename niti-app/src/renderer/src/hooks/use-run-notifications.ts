import { useEffect, useRef } from "react";
import { useApp } from "@/store/app";
import { fmtDur } from "@/lib/humanize";

// A long run finishing while you're elsewhere earns a system notification (notifyOnDone, the TUI's
// rule: 20s or longer); pending approvals show on the dock badge.
export function useRunNotifications() {
  const summary = useApp((s) => s.session.summary);
  const approvals = useApp((s) => s.session.approvals);
  const notify = useApp((s) => s.sessionInfo?.prefs?.notifyOnDone ?? true);
  const seen = useRef(summary);
  const lastHead = useRef<string>("");

  useEffect(() => {
    if (!summary || summary === seen.current) return;
    seen.current = summary;
    if (!notify || summary.durationMs < 20_000) return;
    const title = summary.cancelled ? "Run cancelled" : summary.ok ? "Done" : "Finished with failures";
    void window.niti.notify(`niti · ${title}`, `${summary.goal.slice(0, 80)} — ${fmtDur(summary.durationMs)}`);
  }, [summary, notify]);

  useEffect(() => {
    void window.niti.setBadge(approvals.length);
    const head = approvals[0] ? `${approvals[0].agentId}:${approvals[0].tool}:${JSON.stringify(approvals[0].input).slice(0, 200)}` : "";
    if (head && head !== lastHead.current) {
      const a = approvals[0]!;
      void window.niti.notify("niti · approval needed", `${a.agentId} wants to run ${a.tool}`);
    }
    lastHead.current = head;
  }, [approvals]);
}
