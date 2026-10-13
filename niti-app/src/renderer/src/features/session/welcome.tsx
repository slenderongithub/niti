import { Fragment } from "react";
import { Bug, BookOpenText, FlaskConical, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/components/agent-avatar";
import { greeting } from "@/lib/format";
import { useApp, useRoster } from "@/store/app";

const STARTERS = [
  { icon: BookOpenText, text: "Explain how this codebase is structured and where to start reading" },
  { icon: Bug, text: "Find the most likely bug in this project and fix it" },
  { icon: FlaskConical, text: "Add tests for the parts of this project that have none" },
  { icon: Sparkles, text: "Suggest three improvements worth making, then make the first" },
];

// No goal yet: the team, linked by ⇄ as in the TUI.
export function Welcome() {
  const { order, agents, lead } = useRoster();
  const auto = useApp((s) => s.sessionInfo?.auto);
  const fill = (t: string) => window.dispatchEvent(new CustomEvent("niti:prefill", { detail: t }));
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-y-auto p-8">
      <div className="flex w-full max-w-2xl flex-col items-center text-center animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="mb-6 flex items-center gap-2.5">
          {order.map((id, i) => (
            <Fragment key={id}>
              {i > 0 && <span className="text-xs text-muted-foreground/60">⇄</span>}
              <AgentAvatar slot={agents[id]!.index} color={agents[id]!.color} lead={id === lead} size="lg" />
            </Fragment>
          ))}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{greeting()}.</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {order.length} agent{order.length === 1 ? "" : "s"} ready · {auto ? "auto-approve" : "manual approvals"} · tell the team what to do below
        </p>
        <div className="mt-8 grid w-full grid-cols-2 gap-3">
          {STARTERS.map((s) => (
            <Button key={s.text} variant="outline" className="group h-[72px] w-full items-start justify-start gap-3 whitespace-normal rounded-xl bg-card p-3.5 text-left font-normal" onClick={() => fill(s.text)}>
              <s.icon className="mt-0.5 text-muted-foreground transition-colors group-hover:text-primary" />
              <span className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug">{s.text}</span>
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
