import { useEffect, useState } from "react";
import { ArrowLeft, Check, KeyRound, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AgentAvatar } from "@/components/agent-avatar";
import { switchModel } from "@/lib/actions";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";

// Ctrl+L in the TUI (carousel.go): pick the agent (skipped for a solo team), then any model from a
// provider you have a key for — or type provider/model freely.
export function ModelPicker() {
  const open = useUI((s) => s.modelPickerOpen);
  const setOpen = useUI((s) => s.setModelPicker);
  const focused = useUI((s) => s.focusedAgent);
  const api = useApp((s) => s.api);
  const order = useApp((s) => s.session.order);
  const agents = useApp((s) => s.session.agents);
  const [agent, setAgent] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<{ provider: string; models: string[] }[] | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open) return;
    setQ("");
    setAgent(order.length === 1 ? order[0]! : focused && agents[focused] ? focused : null);
    if (!api) return;
    void (async () => {
      try {
        const creds = (await api.credentials()).credentials.map((c) => c.provider);
        const current = order.map((id) => agents[id]!.cfg.provider);
        const providers = [...new Set([...creds, ...current])];
        const lists = await Promise.all(providers.map(async (p) => ({ provider: p, models: (await api.models(p).catch(() => ({ models: [] as string[] }))).models })));
        setCatalog(lists);
      } catch {
        setCatalog([]);
      }
    })();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const a = agent ? agents[agent] : undefined;
  const typed = q.trim();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-[16%] w-[min(560px,92vw)] translate-y-0 gap-0 overflow-hidden p-0" showCloseButton={false}>
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            {a && order.length > 1 && (
              <Button variant="ghost" size="icon-xs" onClick={() => setAgent(null)} aria-label="Back">
                <ArrowLeft />
              </Button>
            )}
            {a ? (
              <>
                <AgentAvatar slot={a.index} color={a.color} size="xs" /> Model for {a.cfg.role}
              </>
            ) : (
              "Switch a model — which agent?"
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">{a ? `Now ${a.cfg.provider}/${a.cfg.model}. Takes effect on its next call.` : "Each agent can run a different provider and model."}</DialogDescription>
        </DialogHeader>
        {!a ? (
          <Command loop>
            <CommandList className="max-h-80">
              <CommandGroup>
                {order.map((id) => {
                  const x = agents[id]!;
                  return (
                    <CommandItem key={id} value={`${x.cfg.role} ${id}`} onSelect={() => setAgent(id)} className="py-2">
                      <AgentAvatar slot={x.index} color={x.color} size="xs" />
                      <span className="font-medium">{x.cfg.role}</span>
                      <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                        {x.cfg.provider}/{x.cfg.model}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        ) : (
          <Command loop>
            <CommandInput autoFocus value={q} onValueChange={setQ} placeholder="Filter, or type provider/model…" />
            <CommandList className="max-h-96">
              {catalog === null ? (
                <div className="flex justify-center py-8 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                </div>
              ) : (
                <>
                  <CommandEmpty>Press Enter to use it as typed.</CommandEmpty>
                  {typed.includes("/") && (
                    <CommandGroup heading="Custom">
                      <CommandItem
                        value={`__typed ${typed}`}
                        forceMount
                        onSelect={async () => {
                          if (await switchModel(a.id, typed)) setOpen(false);
                        }}
                      >
                        <Sparkles /> Use <span className="font-mono">{typed}</span>
                      </CommandItem>
                    </CommandGroup>
                  )}
                  {catalog.map((c) => (
                    <CommandGroup
                      key={c.provider}
                      heading={
                        <span className="flex items-center gap-1.5">
                          <KeyRound className="size-3" /> {c.provider}
                        </span>
                      }
                    >
                      {c.models.map((m) => {
                        const cur = a.cfg.provider === c.provider && a.cfg.model === m;
                        return (
                          <CommandItem
                            key={m}
                            value={`${c.provider}/${m}`}
                            onSelect={async () => {
                              if (cur || (await switchModel(a.id, `${c.provider}/${m}`))) setOpen(false);
                            }}
                          >
                            <span className="font-mono text-[12.5px]">{m}</span>
                            {cur && <Check className="ml-auto text-primary" />}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  ))}
                </>
              )}
            </CommandList>
          </Command>
        )}
      </DialogContent>
    </Dialog>
  );
}
