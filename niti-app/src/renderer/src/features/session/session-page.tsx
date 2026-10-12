import { FolderTree } from "lucide-react";
import { useDefaultLayout } from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextPane } from "@/features/files/context-pane";
import { useUI } from "@/store/ui";
import { AgentsRail } from "./agents-rail";
import { Composer } from "./composer";
import { CommFeed } from "./comm-feed";
import { SummaryCard } from "./summary-card";
import { TranscriptArea } from "./transcript-area";

export function SessionPage() {
  const contextPane = useUI((s) => s.contextPane);
  const toggleContext = useUI((s) => s.toggleContextPane);
  const focusMode = useUI((s) => s.focusMode);
  const showRail = !focusMode;
  const showContext = contextPane && !focusMode;
  const ids = [showRail && "rail", "main", showContext && "context"].filter(Boolean) as string[];
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: `session-${ids.join("-")}`, panelIds: ids, storage: localStorage });

  return (
    <ResizablePanelGroup key={ids.join("-")} orientation="horizontal" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
      {showRail && (
        <>
          <ResizablePanel id="rail" defaultSize="20" minSize={232} maxSize="32">
            <div className="h-full bg-sidebar/40">
              <AgentsRail />
            </div>
          </ResizablePanel>
          <ResizableHandle />
        </>
      )}
      <ResizablePanel id="main" minSize={420}>
        <div className="relative flex h-full min-h-0 flex-col">
          <div className="absolute right-2 top-1.5 z-10 flex gap-0.5">
            {!showContext && !focusMode && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-xs" onClick={() => toggleContext(true)} aria-label="Show files">
                    <FolderTree />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Show files</TooltipContent>
              </Tooltip>
            )}
          </div>
          <div className="min-h-0 flex-1">
            <TranscriptArea />
          </div>
          <SummaryCard />
          <CommFeed />
          <Composer />
        </div>
      </ResizablePanel>
      {showContext && (
        <>
          <ResizableHandle />
          <ResizablePanel id="context" defaultSize="24" minSize={240} maxSize="45">
            <ContextPane />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
