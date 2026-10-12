import { RotateCw, FolderX } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useApp } from "@/store/app";

// The core went away mid-session (crash, killed). Say so, show why, offer the restart.
export function CoreExitDialog() {
  const exit = useApp((s) => s.coreExit);
  const restart = useApp((s) => s.restartCore);
  const close = useApp((s) => s.closeProject);
  return (
    <AlertDialog open={Boolean(exit)}>
      <AlertDialogContent className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>niti-core stopped</AlertDialogTitle>
          <AlertDialogDescription>
            The engine exited{exit?.code !== null && exit?.code !== undefined ? ` with code ${exit.code}` : ""}. Running agents stopped with it. The end of .niti/core.log:
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ScrollArea className="h-56 rounded-lg border bg-muted/40">
          <pre className="selectable p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">{exit?.logTail || "(empty)"}</pre>
        </ScrollArea>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => void close()}>
            <FolderX /> Close project
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => void restart()}>
            <RotateCw /> Restart niti-core
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
