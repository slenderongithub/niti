import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Wordmark } from "@/components/brand";
import { Spinner } from "@/components/spinner";
import { useApp } from "@/store/app";
import { basename } from "@/lib/format";
import { AnimatedShinyText } from "@/components/ui/animated-shiny-text";
import { WindowChrome } from "./window-chrome";

export function StartingScreen({ restarting }: { restarting?: boolean }) {
  const root = useApp((s) => s.root);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 2500);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="ambient flex h-full flex-col bg-background">
      <WindowChrome />
      <div className="flex flex-1 flex-col items-center justify-center gap-7 pb-20">
        <Wordmark size="lg" />
        <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <Spinner />
          <AnimatedShinyText shimmerWidth={120}>{restarting ? "Restarting with your new team" : `Starting niti in ${basename(root ?? "")}`}…</AnimatedShinyText>
        </div>
        <AnimatePresence>
          {slow && (
            <motion.p initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="max-w-sm text-center text-xs text-muted-foreground/80">
              Connecting MCP servers and indexing the project. The first launch in a folder takes longest.
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
