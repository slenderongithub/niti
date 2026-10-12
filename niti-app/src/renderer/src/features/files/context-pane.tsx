import { FolderTree, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUI } from "@/store/ui";
import { FileTree } from "./file-tree";

// The session's right pane: the project tree. Files open as tabs in the centre.
export function ContextPane() {
  const toggle = useUI((s) => s.toggleContextPane);
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar/40">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <FolderTree className="size-4 text-muted-foreground" />
        <span className="text-[13px] font-medium">Files</span>
        <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={() => toggle(false)} aria-label="Hide files">
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <FileTree />
      </div>
    </div>
  );
}
