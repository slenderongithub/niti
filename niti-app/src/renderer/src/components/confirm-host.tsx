import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/store/confirm";

export function ConfirmHost() {
  const a = useConfirm((s) => s.ask);
  const answer = useConfirm((s) => s.answer);
  return (
    <AlertDialog open={Boolean(a)} onOpenChange={(o) => !o && answer("cancel")}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{a?.title}</AlertDialogTitle>
          {a?.description && <AlertDialogDescription>{a.description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => answer("cancel")}>{a?.cancel ?? "Cancel"}</AlertDialogCancel>
          {a?.alt && (
            <Button variant="outline" onClick={() => answer("alt")}>
              {a.alt}
            </Button>
          )}
          <AlertDialogAction variant={a?.destructive ? "destructive" : "default"} onClick={() => answer("confirm")}>
            {a?.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
