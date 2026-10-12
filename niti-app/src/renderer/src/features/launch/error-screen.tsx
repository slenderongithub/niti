import { useEffect, useState } from "react";
import { AlertTriangle, FolderOpen, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useApp } from "@/store/app";
import { WindowChrome } from "./window-chrome";

export function ErrorScreen() {
  const error = useApp((s) => s.error);
  const root = useApp((s) => s.root);
  const open = useApp((s) => s.openProject);
  const close = useApp((s) => s.closeProject);
  const [log, setLog] = useState("");
  useEffect(() => {
    void window.niti.coreLog().then(setLog);
  }, []);
  return (
    <div className="ambient flex h-full flex-col bg-background">
      <WindowChrome />
      <div className="flex flex-1 items-center justify-center px-6 pb-16">
        <Card className="w-full max-w-2xl">
          <CardHeader>
            <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-destructive/12 text-destructive">
              <AlertTriangle className="size-5" />
            </div>
            <CardTitle className="text-lg">niti couldn't start here</CardTitle>
            <CardDescription className="selectable whitespace-pre-wrap font-mono text-xs leading-relaxed">{error}</CardDescription>
          </CardHeader>
          {log && (
            <CardContent>
              <div className="mb-2 text-xs font-medium text-muted-foreground">.niti/core.log</div>
              <ScrollArea className="h-48 rounded-lg border bg-muted/40">
                <pre className="p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">{log}</pre>
              </ScrollArea>
            </CardContent>
          )}
          <CardFooter className="justify-end gap-2">
            <Button variant="ghost" onClick={() => void close()}>
              <FolderOpen /> Choose another folder
            </Button>
            {root && (
              <Button
                onClick={() => {
                  void close().then(() => open(root));
                }}
              >
                <RotateCw /> Try again
              </Button>
            )}
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
