import { toast } from "sonner";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { motion } from "motion/react";
import { Check, CheckCheck, MessageSquareWarning, Pencil, ShieldAlert, Terminal, X, FileCode2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Kbd } from "@/components/ui/kbd";
import { Badge } from "@/components/ui/badge";
import { AgentAvatar } from "@/components/agent-avatar";
import { PixelAvatar } from "@/components/pixel-avatar";
import { answerApproval, approveAll } from "@/lib/actions";
import { useApp } from "@/store/app";
import type { ApprovalRequest } from "@/lib/types";
import { DiffRows, parseUnified } from "@/features/session/diff-view";

// "Later" hides the dialog until a different request reaches the front of the queue.
export const useApprovalUI = create<{ hiddenFor: string | null; show(): void; hide(key: string): void }>((set) => ({
  hiddenFor: null,
  show: () => set({ hiddenFor: null }),
  hide: (key) => set({ hiddenFor: key }),
}));

function keyOf(r?: ApprovalRequest): string {
  return !r ? "" : r.id !== undefined ? String(r.id) : `${r.agentId}|${r.tool}|${JSON.stringify(r.input).slice(0, 400)}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
}

function describe(r: ApprovalRequest): { verb: string; target: string } {
  const i = r.input;
  if (r.tool === "shell" || r.tool === "bash") return { verb: "run", target: [str(i.command), ...(Array.isArray(i.args) ? (i.args as string[]) : [])].join(" ").trim() };
  if (r.tool === "write_file") return { verb: "write", target: str(i.path) };
  if (r.tool === "edit") return { verb: "edit", target: str(i.path) };
  return { verb: `use ${r.tool}`, target: str(i.path ?? i.query ?? "") };
}

// The queue's front, answered the way the TUI's approval screens do (diffview.go, interact.go):
// y allow · a always for this agent · n deny · e edit before allowing · t deny and tell it why.
export function ApprovalCenter() {
  const approvals = useApp((s) => s.session.approvals);
  const bulk = approvals.filter((r) => !r.dangerous).length; // what "Allow all" covers: never a dangerous one
  const agents = useApp((s) => s.session.agents);
  const lead = useApp((s) => s.session.leadId);
  const api = useApp((s) => s.api);
  const hiddenFor = useApprovalUI((s) => s.hiddenFor);
  const hide = useApprovalUI((s) => s.hide);
  const head = approvals[0];
  const key = keyOf(head);
  const open = Boolean(head) && hiddenFor !== key;

  const [mode, setMode] = useState<"view" | "edit" | "tell">("view");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const shownAt = useRef(0);
  useEffect(() => {
    shownAt.current = Date.now();
    setMode("view");
    setDraft("");
    setBusy(false);
  }, [key]);

  const editField = head?.tool === "write_file" ? "content" : head?.tool === "edit" ? "newString" : null;
  const hunks = useMemo(() => (typeof head?.input.diff === "string" ? parseUnified(head.input.diff) : []), [head]);
  const agent = head ? agents[head.agentId] : undefined;
  const d = head ? describe(head) : { verb: "", target: "" };
  const isShell = head?.tool === "shell" || head?.tool === "bash";

  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false); // or one failed call left every button here disabled for good
    }
  };
  const allow = () => act(() => answerApproval(true, undefined, undefined, head?.id));
  const always = () => act(() => answerApproval(true, "agent", undefined, head?.id));
  const deny = () => act(() => answerApproval(false, undefined, undefined, head?.id));
  const startEdit = () => {
    if (!editField || !head) return;
    setDraft(str(head.input[editField]));
    setMode("edit");
  };
  const saveEdit = () => act(() => answerApproval(true, undefined, { [editField!]: draft }, head?.id));
  const tell = () =>
    act(async () => {
      const id = head!.agentId;
      await answerApproval(false, undefined, undefined, head!.id);
      // Said, not swallowed: if the agent has already stopped, the explanation didn't reach it.
      if (draft.trim() && api) await api.messageAgent(id, draft.trim()).catch((e: Error) => toast.error(`denied, but ${id} didn't get your note: ${e.message}`));
    });

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (mode !== "view" || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      // The dialog opens on its own, often mid-sentence in the composer: a stray "n" or "y" typed
      // in the first moments must not answer a request nobody has read yet.
      if (Date.now() - shownAt.current < 600) return;
      const k = e.key.toLowerCase();
      if (k === "y") void allow();
      else if (k === "a") void always();
      else if (k === "n") void deny();
      else if (k === "e" && editField) startEdit();
      else if (k === "t") setMode("tell");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && hide(key)}>
      <DialogContent className="flex max-h-[86vh] w-[min(920px,94vw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none" showCloseButton={false}>
        {head && (
          <>
            <DialogHeader className="flex-row items-center gap-3 border-b px-5 py-3.5 text-left">
              {agent && <AgentAvatar slot={agent.index} color={agent.color} lead={head.agentId === lead} size="md" />}
              <div className="min-w-0 flex-1">
                <DialogTitle className="flex items-center gap-2 text-[15px]">
                  <span style={{ color: agent?.color }}>{agent?.cfg.role ?? head.agentId}</span>
                  <span className="font-normal text-muted-foreground">wants to {d.verb}</span>
                  {!isShell && <span className="truncate font-mono text-[13px]">{d.target}</span>}
                </DialogTitle>
                <DialogDescription className="mt-0.5 flex items-center gap-2 text-xs">
                  <Badge variant="outline" className="h-5 gap-1 font-mono text-[10.5px]">
                    {isShell ? <Terminal className="size-3" /> : <FileCode2 className="size-3" />}
                    {head.tool}
                  </Badge>
                  {approvals.length > 1 && <span>1 of {approvals.length} waiting</span>}
                </DialogDescription>
              </div>
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => hide(key)}>
                <Clock /> Later
              </Button>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
              {mode === "edit" ? (
                <div className="p-4">
                  <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <Pencil className="size-3.5" /> Edit {editField === "content" ? "the file's new content" : "the replacement text"} — your version is what gets written.
                  </div>
                  <Textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} className="min-h-[46vh] resize-none font-mono text-[12px] leading-relaxed" spellCheck={false} />
                </div>
              ) : isShell ? (
                <div className="p-5">
                  <div className="overflow-hidden rounded-xl border bg-muted/40">
                    <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
                      <Terminal className="size-3.5" /> command
                      {typeof head.input.cwd === "string" && <span className="ml-auto font-mono">in {head.input.cwd}</span>}
                    </div>
                    <pre className="selectable whitespace-pre-wrap break-all p-4 font-mono text-[13px] leading-relaxed text-warning">{d.target}</pre>
                  </div>
                  <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                    <ShieldAlert className="size-3.5" /> Runs in the project folder{navigator.userAgent.includes("Mac") ? ", inside the macOS sandbox" : ""}. Network and paths outside the project always ask.
                  </p>
                </div>
              ) : hunks.length ? (
                <div className="py-2">
                  <DiffRows hunks={hunks} fold={400} />
                </div>
              ) : (
                <pre className="selectable whitespace-pre-wrap p-5 font-mono text-[12px] text-muted-foreground">{JSON.stringify(head.input, null, 2)}</pre>
              )}

              {mode === "tell" && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} className="border-t bg-muted/30 p-4">
                  <div className="mb-2 flex items-center gap-2 text-xs font-medium">
                    <MessageSquareWarning className="size-3.5 text-warning" /> Deny, and tell {agent?.cfg.role ?? "the agent"} what to do instead
                  </div>
                  <Textarea
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Don't touch the lockfile — add the dependency with npm install instead."
                    className="min-h-20 resize-none bg-card"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void tell();
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        setMode("view");
                      }
                    }}
                  />
                </motion.div>
              )}

              {approvals.length > 1 && mode === "view" && (
                <div className="border-t px-5 py-3">
                  <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">Also waiting</div>
                  <div className="space-y-1">
                    {approvals.slice(1, 6).map((r, i) => {
                      const a = agents[r.agentId];
                      const x = describe(r);
                      return (
                        <div key={i} className="flex items-center gap-2 text-xs">
                          {a && <PixelAvatar slot={a.index} color={a.color} size={14} />}
                          <span className="text-muted-foreground">{a?.cfg.role ?? r.agentId}</span>
                          <span>{x.verb}</span>
                          <span className="truncate font-mono text-muted-foreground">{x.target}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <DialogFooter className="flex-row flex-wrap items-center gap-2 border-t bg-muted/20 px-5 py-3 sm:justify-between">
              {mode === "edit" ? (
                <>
                  <Button variant="ghost" onClick={() => setMode("view")}>
                    Cancel
                  </Button>
                  <Button onClick={() => void saveEdit()} disabled={busy}>
                    <Check /> Allow with my edit
                  </Button>
                </>
              ) : mode === "tell" ? (
                <>
                  <Button variant="ghost" onClick={() => setMode("view")}>
                    Back
                  </Button>
                  <Button variant="destructive" onClick={() => void tell()} disabled={busy}>
                    <X /> Deny and send
                  </Button>
                </>
              ) : (
                <>
                  <div className="flex gap-2">
                    <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => void deny()} disabled={busy}>
                      <X /> Deny <Kbd>N</Kbd>
                    </Button>
                    <Button variant="ghost" onClick={() => setMode("tell")} disabled={busy}>
                      <MessageSquareWarning /> Deny & tell <Kbd>T</Kbd>
                    </Button>
                    {editField && (
                      <Button variant="ghost" onClick={startEdit} disabled={busy}>
                        <Pencil /> Edit <Kbd>E</Kbd>
                      </Button>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {bulk > 1 && (
                      <Button variant="ghost" onClick={() => void act(approveAll)} disabled={busy}>
                        <CheckCheck /> Allow all {bulk}
                      </Button>
                    )}
                    <Button variant="outline" onClick={() => void always()} disabled={busy}>
                      Always for {agent?.cfg.role ?? "agent"} <Kbd>A</Kbd>
                    </Button>
                    <Button onClick={() => void allow()} disabled={busy} autoFocus>
                      <Check /> Allow <Kbd className="bg-primary-foreground/15 text-primary-foreground">Y</Kbd>
                    </Button>
                  </div>
                </>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
