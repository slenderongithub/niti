import { cn } from "@/lib/utils";

// The TUI's wordmark — " niti" in the accent, monospace — with the README wordmark's underline bar.
export function Wordmark({ className, size = "md" }: { className?: string; size?: "sm" | "md" | "lg" | "xl" }) {
  const text = { sm: "text-sm", md: "text-base", lg: "text-2xl", xl: "text-6xl" }[size];
  const bar = { sm: "h-[2px] mt-0.5", md: "h-[2px] mt-0.5", lg: "h-[3px] mt-1", xl: "h-1.5 mt-2" }[size];
  return (
    <span className={cn("inline-flex flex-col font-mono font-semibold tracking-tight text-foreground", text, className)}>
      <span>
        niti<span className="text-primary">.</span>
      </span>
      <span className={cn("w-[62%] rounded-full bg-primary", bar)} />
    </span>
  );
}
