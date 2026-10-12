import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useOutput } from "@/store/output";

// The TUI's pager as a sheet: command results, help, shell output.
export function OutputSheet() {
  const { open, title, body, mono, close } = useOutput();
  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()}>
      <SheetContent className="w-[min(720px,92vw)] gap-0 sm:max-w-none">
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="truncate font-mono text-sm">{title}</SheetTitle>
          <SheetDescription className="sr-only">Command output</SheetDescription>
          <div className="absolute right-12 top-3.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Copy"
              onClick={() => {
                void navigator.clipboard.writeText(body);
                toast.success("Copied");
              }}
            >
              <Copy />
            </Button>
          </div>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <pre className={`selectable whitespace-pre-wrap break-words p-5 text-[12.5px] leading-relaxed ${mono ? "font-mono" : "font-sans"}`}>{body}</pre>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
