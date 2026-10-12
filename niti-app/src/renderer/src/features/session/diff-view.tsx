import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { HunkLine } from "@/lib/types";
import { toRows, type Row } from "@/lib/diff";
export { parseUnified } from "@/lib/diff";
import { cn } from "@/lib/utils";

// A file change as numbered, tinted rows — the TUI's live diff (live.go:124-218): changed rows that
// pair up (a run of − followed by as many +) get their differing middle highlighted.

function RowText({ row }: { row: Row }) {
  if (!row.hi) return <>{row.text || " "}</>;
  const chars = [...row.text];
  return (
    <>
      {chars.slice(0, row.hi[0]).join("")}
      <mark className={cn("rounded-[3px] text-inherit", row.kind === "+" ? "bg-success/30" : "bg-destructive/30")}>{chars.slice(row.hi[0], row.hi[1]).join("")}</mark>
      {chars.slice(row.hi[1]).join("")}
    </>
  );
}

export function DiffRows({ hunks, fold = 12, more = 0, className }: { hunks: { lines: HunkLine[] }[]; fold?: number; more?: number; className?: string }) {
  const rows = useMemo(() => toRows(hunks), [hunks]);
  const [open, setOpen] = useState(false);
  const shown = open || rows.length <= fold + 2 ? rows : rows.slice(0, fold);
  const hidden = rows.length - shown.length + (open ? 0 : 0);
  return (
    <div className={cn("selectable overflow-x-auto font-mono text-[11.5px] leading-[1.6] scrollbar-thin", className)}>
      <table className="w-full border-collapse">
        <tbody>
          {shown.map((r, i) =>
            r.kind === "gap" ? (
              <tr key={i}>
                <td colSpan={3} className="select-none px-3 text-muted-foreground/50">
                  ⋮
                </td>
              </tr>
            ) : (
              <tr key={i} className={cn(r.kind === "+" && "bg-success/10", r.kind === "-" && "bg-destructive/10")}>
                <td className="w-10 select-none border-r border-border/50 pr-2 text-right align-top text-muted-foreground/60 tabular">{r.n ?? ""}</td>
                <td className={cn("w-5 select-none pl-1.5 align-top", r.kind === "+" ? "text-success" : r.kind === "-" ? "text-destructive" : "text-muted-foreground/40")}>{r.kind === " " ? "" : r.kind === "-" ? "−" : "+"}</td>
                <td className={cn("whitespace-pre pr-4 align-top", r.kind === " " ? "text-muted-foreground" : "text-foreground")}>
                  <RowText row={r} />
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      {(hidden > 0 || more > 0) && (
        <Button variant="ghost" size="xs" className="ml-9 mt-0.5 h-6 gap-1 font-sans text-[11px] font-normal text-muted-foreground" onClick={() => setOpen((o) => !o)} disabled={hidden === 0 && open}>
          <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
          {open ? (more > 0 ? `${more} more lines not shown` : "Show less") : `Show ${hidden + more} more lines`}
        </Button>
      )}
    </div>
  );
}

