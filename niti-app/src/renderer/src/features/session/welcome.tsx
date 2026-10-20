import { Fragment } from "react";
import { motion } from "motion/react";
import { Bug, BookOpenText, Cpu, FlaskConical, Sparkles } from "lucide-react";
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
  const onMac = order.filter((id) => agents[id]!.cfg.provider === "local").length;
  const fill = (t: string) => window.dispatchEvent(new CustomEvent("niti:prefill", { detail: t }));
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-y-auto p-8">
      {/* Light behind the team: the accent, very low, fading into the page — depth without a new colour. */}
      <span aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(40%_32%_at_50%_34%,color-mix(in_oklab,var(--primary)_13%,transparent),transparent_75%)]" />
      <span aria-hidden className="dot-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(50%_45%_at_50%_38%,black,transparent)]" />
      <div className="relative flex w-full max-w-2xl flex-col items-center text-center animate-in fade-in slide-in-from-bottom-2 duration-300">
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
        {onMac > 0 && (
          <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border bg-card/70 px-2.5 py-0.5 text-[11.5px] text-muted-foreground">
            <Cpu className="size-3 text-primary" aria-hidden />
            {onMac === order.length ? "Runs entirely on this Mac — private and offline" : `${onMac} of ${order.length} run on this Mac`}
          </p>
        )}
        <div className="mt-8 grid w-full grid-cols-2 gap-3">
          {STARTERS.map((s, i) => (
            <motion.div key={s.text} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, delay: 0.08 + i * 0.04, ease: [0.22, 1, 0.36, 1] }}>
              <Button
                variant="outline"
                className="group h-[72px] w-full items-start justify-start gap-3 whitespace-normal rounded-xl bg-card p-3.5 text-left font-normal transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-primary/35 hover:shadow-[0_8px_24px_-14px_color-mix(in_oklab,var(--primary)_40%,transparent)]"
                onClick={() => fill(s.text)}
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-primary/12 group-hover:text-primary">
                  <s.icon className="size-3.5" />
                </span>
                <span className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug">{s.text}</span>
              </Button>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
