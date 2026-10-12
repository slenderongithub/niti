import { createRef, useMemo, useRef, type RefObject } from "react";
import { Workflow } from "lucide-react";
import { AnimatedBeam } from "@/components/ui/animated-beam";
import { AgentAvatar } from "@/components/agent-avatar";
import { SectionCard } from "@/components/layout";
import { useApp } from "@/store/app";

// Who talks to whom: the team in a row, a wire for every pair that has exchanged a message, and
// light travelling the wire from sender to receiver in their own colours. Wires keep flowing only
// while a run is live; afterwards each plays once and rests, so an idle dashboard costs nothing.
export function TeamLinks() {
  const order = useApp((s) => s.session.order);
  const agents = useApp((s) => s.session.agents);
  const lead = useApp((s) => s.session.leadId);
  const feed = useApp((s) => s.session.feed);
  const active = useApp((s) => s.session.active);
  const box = useRef<HTMLDivElement>(null);
  const refs = useRef(new Map<string, RefObject<HTMLSpanElement | null>>());
  const ref = (id: string) => refs.current.get(id) ?? refs.current.set(id, createRef<HTMLSpanElement>()).get(id)!;

  // Directed pairs, each counted once, between two agents on the team.
  const links = useMemo(() => {
    const seen = new Map<string, { from: string; to: string; count: number }>();
    for (const it of feed) {
      if (it.kind !== "message") continue;
      const { from, to } = it.message;
      if (!agents[from] || !agents[to] || from === to) continue;
      const k = `${from}\u0000${to}`;
      const l = seen.get(k) ?? { from, to, count: 0 };
      l.count++;
      seen.set(k, l);
    }
    return [...seen.values()];
  }, [feed, agents]);

  const pos = (id: string) => order.indexOf(id);

  return (
    <SectionCard title="Who's talking" icon={Workflow} description={links.length ? `${links.length} line${links.length === 1 ? "" : "s"} open between agents` : "No messages between agents yet"} flush>
      <div ref={box} className="relative flex h-[168px] items-center justify-around px-8">
        {links.map((l) => {
          const i = pos(l.from);
          const j = pos(l.to);
          // Arc over for one direction and under for the other, higher the further apart they sit,
          // so A→B and B→A never draw on top of each other.
          const bend = (i < j ? 1 : -1) * (24 + Math.abs(i - j) * 18);
          return (
            <AnimatedBeam
              key={`${l.from}-${l.to}`}
              containerRef={box}
              fromRef={ref(l.from)}
              toRef={ref(l.to)}
              curvature={bend}
              reverse={i > j}
              duration={3.2 + (Math.abs(i - j) % 3) * 0.6}
              repeat={active ? Infinity : 0}
              pathWidth={1.5}
              pathOpacity={0.18}
              gradientStartColor={agents[l.from]!.color}
              gradientStopColor={agents[l.to]!.color}
            />
          );
        })}
        {order.map((id) => {
          const a = agents[id]!;
          return (
            <div key={id} className="relative z-10 flex min-w-0 flex-col items-center gap-2">
              <span ref={ref(id)} className="flex size-14 items-center justify-center rounded-2xl border bg-card shadow-panel">
                <AgentAvatar slot={a.index} color={a.color} lead={id === lead} status={a.status} showStatus size="md" />
              </span>
              <span className="max-w-24 truncate text-xs font-medium" style={{ color: a.color }}>
                {a.cfg.role}
              </span>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}
