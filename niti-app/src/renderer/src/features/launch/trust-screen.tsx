import { motion } from "motion/react";
import { ShieldAlert, ShieldCheck, FolderLock, Terminal, FileCode2, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Kbd } from "@/components/ui/kbd";
import { useApp } from "@/store/app";
import { shortPath } from "@/lib/format";
import { WindowChrome } from "./window-chrome";
import { useEffect } from "react";

// The trust prompt (tui/internal/trust/trust.go): niti will read files, run commands and start MCP
// servers in this folder, so the first visit — or a changed mcpServers block — asks first.
export function TrustScreen() {
  const trust = useApp((s) => s.trust);
  const root = useApp((s) => s.root);
  const info = useApp((s) => s.info);
  const grant = useApp((s) => s.grantTrust);
  const close = useApp((s) => s.closeProject);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "1" || e.key === "Enter") void grant(false);
      else if (e.key === "2") void grant(true);
      else if (e.key === "3" || e.key === "Escape") void close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [grant, close]);

  const changed = trust?.changed;
  return (
    <div className="flex h-full flex-col bg-background">
      <WindowChrome />
      <div className="flex flex-1 items-center justify-center px-6 pb-16">
        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-lg">
          <Card className="gap-5 shadow-xl shadow-black/5">
            <CardHeader>
              <div className={`mb-2 flex size-11 items-center justify-center rounded-xl ${changed ? "bg-warning/15 text-warning" : "bg-primary/12 text-primary"}`}>
                {changed ? <ShieldAlert className="size-5" /> : <ShieldCheck className="size-5" />}
              </div>
              <CardTitle className="text-lg">{changed ? "This folder's MCP servers changed" : "Do you trust this folder?"}</CardTitle>
              <CardDescription className="leading-relaxed">
                {changed
                  ? "Since you last trusted it, the mcpServers block in .niti/agents.yaml changed. Those servers run as programs on your machine."
                  : "niti hasn't run here before. Trusting it lets your agents work in this folder."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2.5 rounded-lg border bg-muted/50 px-3 py-2.5">
                <FolderLock className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-xs">{shortPath(root ?? "", info?.home)}</span>
              </div>
              <ul className="grid gap-2.5 text-sm text-muted-foreground">
                <li className="flex gap-2.5"><FileCode2 className="mt-0.5 size-4 shrink-0" /> Read and edit files in this folder (writes ask first unless you choose auto-approve)</li>
                <li className="flex gap-2.5"><Terminal className="mt-0.5 size-4 shrink-0" /> Run shell commands here, inside the OS sandbox where available</li>
                <li className="flex gap-2.5"><Plug className="mt-0.5 size-4 shrink-0" /> Start the MCP and language servers configured for this project</li>
              </ul>
            </CardContent>
            <CardFooter className="flex-col items-stretch gap-2 sm:flex-row sm:justify-end">
              <Button variant="ghost" onClick={() => void close()}>
                Cancel <Kbd>esc</Kbd>
              </Button>
              <Button variant="outline" onClick={() => void grant(false)}>
                Trust once <Kbd>1</Kbd>
              </Button>
              <Button onClick={() => void grant(true)}>
                Trust and remember <Kbd className="bg-primary-foreground/15 text-primary-foreground">2</Kbd>
              </Button>
            </CardFooter>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
