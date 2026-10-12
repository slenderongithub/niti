import { AnimatePresence, motion } from "motion/react";
import { useApp } from "@/store/app";
import { messageColor } from "@/lib/identity";
import { truncate } from "@/lib/humanize";

// The last line of agent-to-agent traffic, ticking over above the composer (view.go:617-624).
export function CommFeed() {
  const last = useApp((s) => s.session.feed[s.session.feed.length - 1]);
  const active = useApp((s) => s.session.active);
  const agents = useApp((s) => s.session.agents);
  if (!last || !active) return null;
  const name = (id: string) => agents[id]?.cfg.role ?? id;
  return (
    <div className="h-6 overflow-hidden px-6">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div key={last.id} initial={{ y: 14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -14, opacity: 0 }} className="flex h-6 items-center gap-2 truncate text-[11.5px] text-muted-foreground">
          {last.kind === "message" ? (
            <>
              <span className="font-medium text-foreground/80">{name(last.message.from)}</span>
              <span className="font-mono" style={{ color: messageColor(last.message.kind) }}>
                ─{last.message.kind}→
              </span>
              <span className="font-medium text-foreground/80">{last.message.to === "*" ? "everyone" : name(last.message.to)}</span>
              <span className="truncate">{truncate(last.message.subject, 90)}</span>
            </>
          ) : (
            <span className="truncate">{last.text}</span>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
