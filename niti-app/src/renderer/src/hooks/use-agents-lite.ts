import { useMemo } from "react";
import { useApp } from "@/store/app";

export type AgentLite = { id: string; index: number; role: string; status: string; color: string; model: string };

// The roster's identity and status as one primitive key, so a component re-renders when an agent's
// role or status changes — not on every streamed token.
export function useAgentsLite(): AgentLite[] {
  const key = useApp((s) =>
    s.session.order
      .map((id) => {
        const a = s.session.agents[id]!;
        return [id, a.index, a.cfg.role, a.status, a.color, a.cfg.model].join("\u0001");
      })
      .join("\u0002"),
  );
  return useMemo(
    () =>
      key
        ? key.split("\u0002").map((row) => {
            const [id, index, role, status, color, model] = row.split("\u0001") as [string, string, string, string, string, string];
            return { id, index: Number(index), role, status, color, model };
          })
        : [],
    [key],
  );
}
