import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Bot,
  Check,
  Cpu,
  FileText,
  FolderOpen,
  GitBranch,
  GitMerge,
  History,
  Info,
  KeyRound,
  Loader2,
  Monitor,
  Moon,
  Palette,
  Plug,
  Plus,
  Repeat,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Trash2,
  Undo2,
  Users,
  Download,
  Eraser,
  Play,
  ScrollText,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { AgentAvatar } from "@/components/agent-avatar";
import { Wordmark } from "@/components/brand";
import { EmptyState } from "@/components/empty-state";
import { fmtAgo, shortPath } from "@/lib/format";
import { runSlash } from "@/lib/actions";
import type { Checkpoint, Credential, Providers, WorktreeStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useOutput } from "@/store/output";
import { useUI } from "@/store/ui";
import type { ThemeSource } from "../../../../shared/bridge";

type Section = "appearance" | "team" | "providers" | "behaviour" | "integrations" | "worktree" | "history" | "about";
const SECTIONS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "team", label: "Team", icon: Users },
  { id: "providers", label: "Providers & keys", icon: KeyRound },
  { id: "behaviour", label: "Agent behaviour", icon: SlidersHorizontal },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "worktree", label: "Worktree", icon: GitBranch },
  { id: "history", label: "History", icon: History },
  { id: "about", label: "About", icon: Info },
];

function fromHash(): Section {
  const h = location.hash.replace("#", "") as Section;
  return SECTIONS.some((s) => s.id === h) ? h : "appearance";
}

export default function SettingsPage() {
  const [section, setSection] = useState<Section>(fromHash);
  useEffect(() => {
    const h = () => setSection(fromHash());
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  const pick = (s: Section) => {
    history.replaceState(null, "", `#${s}`);
    setSection(s);
  };
  return (
    <div className="flex h-full min-h-0">
      <aside className="w-56 shrink-0 border-r bg-sidebar/40 px-3 py-6">
        <div className="mb-3 flex h-8 items-center px-2.5 text-xl font-semibold tracking-tight">Settings</div>
        <nav className="flex flex-col gap-0.5">
          {SECTIONS.map((s) => (
            <Button key={s.id} variant="ghost" size="sm" onClick={() => pick(s.id)} className={cn("relative h-8 justify-start gap-2.5 px-2.5 font-normal text-muted-foreground", section === s.id && "text-foreground hover:bg-transparent")}>
              {section === s.id && <motion.span layoutId="settings-nav" className="absolute inset-0 rounded-md border bg-background shadow-sm" />}
              <s.icon className={cn("relative z-10", section === s.id && "text-primary")} />
              <span className="relative z-10 text-[13px]">{s.label}</span>
            </Button>
          ))}
        </nav>
      </aside>
      <ScrollArea className="min-w-0 flex-1">
        <AnimatePresence mode="wait">
          <motion.div key={section} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16 }} data-audit="page" className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
            {section === "appearance" && <Appearance />}
            {section === "team" && <Team />}
            {section === "providers" && <ProvidersSection />}
            {section === "behaviour" && <Behaviour />}
            {section === "integrations" && <Integrations />}
            {section === "worktree" && <Worktree />}
            {section === "history" && <HistorySection />}
            {section === "about" && <About />}
          </motion.div>
        </AnimatePresence>
      </ScrollArea>
    </div>
  );
}

function Heading({ title, description }: { title: string; description?: string }) {
  return (
    <div data-audit="section" className="flex h-14 flex-col justify-center">
      <h2 className="truncate text-xl font-semibold leading-7 tracking-tight">{title}</h2>
      {description && <p className="truncate text-[13px] leading-5 text-muted-foreground">{description}</p>}
    </div>
  );
}

function Row({ title, description, children, icon: Icon }: { title: string; description?: ReactNode; children: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="flex min-h-16 items-center gap-4 py-3">
      {Icon && (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium">{title}</div>
        {description && <div className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// A boolean the core persists to agents.yaml (POST /settings) — optimistic, rolled back on failure.
function useSetting(key: string): [boolean, (v: boolean) => void] {
  const info = useApp((s) => s.sessionInfo);
  const api = useApp((s) => s.api);
  const setPrefs = useApp((s) => s.setPrefs);
  const value = Boolean((info?.prefs as unknown as Record<string, boolean> | undefined)?.[key] ?? (info?.settings as unknown as Record<string, boolean> | undefined)?.[key]);
  const set = useCallback(
    async (v: boolean) => {
      if (!api || !info) return;
      const apply = (val: boolean) => {
        if (key in (info.settings ?? {})) useApp.setState((s) => ({ sessionInfo: s.sessionInfo ? { ...s.sessionInfo, settings: { ...s.sessionInfo.settings, [key]: val } } : null }));
        else setPrefs({ [key]: val });
      };
      apply(v);
      try {
        await api.setSettings({ [key]: v });
      } catch (e) {
        apply(!v);
        toast.error((e as Error).message);
      }
    },
    [api, info, key, setPrefs],
  );
  return [value, (v) => void set(v)];
}

function Appearance() {
  const theme = useUI((s) => s.theme);
  const setTheme = useUI((s) => s.setTheme);
  const [reduce, setReduce] = useSetting("reduceMotion");
  const [dur, setDur] = useSetting("showTurnDuration");
  const [notify, setNotify] = useSetting("notifyOnDone");
  const options: { id: ThemeSource; label: string; icon: LucideIcon; bg: string; fg: string; card: string; accent: string }[] = [
    { id: "light", label: "Light", icon: Sun, bg: "#f3f3f3", fg: "#171717", card: "#ffffff", accent: "#5a46d8" },
    { id: "dark", label: "Dark", icon: Moon, bg: "#0a0a0a", fg: "#ededed", card: "#161616", accent: "#9d8cff" },
    { id: "system", label: "System", icon: Monitor, bg: "linear-gradient(135deg,#f3f3f3 50%,#0a0a0a 50%)", fg: "#8f8f8f", card: "transparent", accent: "#9d8cff" },
  ];
  return (
    <>
      <Heading title="Appearance" />
      <div className="grid grid-cols-3 gap-3">
        {options.map((o) => (
          <Button key={o.id} variant="outline" onClick={() => setTheme(o.id)} className={cn("h-auto flex-col items-stretch gap-2.5 rounded-xl p-2.5", theme === o.id && "border-primary shadow-[inset_0_0_0_1px_var(--primary)]")}>
            <div className="relative h-24 overflow-hidden rounded-lg border" style={{ background: o.bg }}>
              {o.id !== "system" && (
                <div className="absolute inset-2.5 flex gap-1.5">
                  <div className="w-1/4 space-y-1 rounded-md p-1.5" style={{ background: o.card }}>
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="h-1.5 rounded-full" style={{ background: i === 0 ? o.accent : o.fg, opacity: i === 0 ? 1 : 0.25 }} />
                    ))}
                  </div>
                  <div className="flex-1 space-y-1.5 rounded-md p-2" style={{ background: o.card }}>
                    <div className="h-1.5 w-2/3 rounded-full" style={{ background: o.fg, opacity: 0.5 }} />
                    <div className="h-1.5 w-1/2 rounded-full" style={{ background: o.fg, opacity: 0.25 }} />
                    <div className="mt-3 h-4 rounded" style={{ background: o.accent, opacity: 0.85 }} />
                  </div>
                </div>
              )}
            </div>
            <span className="flex items-center gap-2 text-[13px]">
              <o.icon className="size-3.5" /> {o.label}
              {theme === o.id && <Check className="ml-auto size-3.5 text-primary" />}
            </span>
          </Button>
        ))}
      </div>
      <Card className="gap-0 py-1 shadow-none">
        <CardContent className="divide-y">
          <Row title="Reduce motion" description="Still spinners, no transitions.">
            <Switch checked={reduce} onCheckedChange={setReduce} />
          </Row>
          <Row title="Show how long each step took" description="Durations on finished tool calls in transcripts.">
            <Switch checked={dur} onCheckedChange={setDur} />
          </Row>
          <Row title="Notify when a run finishes" description="When a run over 20s ends in the background.">
            <Switch checked={notify} onCheckedChange={setNotify} />
          </Row>
        </CardContent>
      </Card>
    </>
  );
}

function Team() {
  const order = useApp((s) => s.session.order);
  const agents = useApp((s) => s.session.agents);
  const lead = useApp((s) => s.session.leadId);
  const focusAgent = useUI((s) => s.focusAgent);
  const setModelPicker = useUI((s) => s.setModelPicker);
  return (
    <>
      <Heading title="Team" />
      <Card className="gap-0 py-0 shadow-none">
        <CardContent className="divide-y px-0">
          {order.map((id) => {
            const a = agents[id]!;
            return (
              <div key={id} className="flex items-start gap-3.5 px-5 py-4">
                <AgentAvatar slot={a.index} color={a.color} lead={id === lead} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-semibold">{a.cfg.role}</span>
                    {id === lead && (
                      <Badge variant="outline" className="h-5 border-warning/40 text-[10.5px] text-warning">
                        lead
                      </Badge>
                    )}
                    <span className="font-mono text-[11px] text-muted-foreground">{id}</span>
                  </div>
                  <div className="font-mono text-[12px] text-muted-foreground">
                    {a.cfg.provider}/{a.cfg.model}
                    {a.cfg.baseURL ? ` · ${a.cfg.baseURL}` : ""}
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{a.cfg.systemPrompt}</p>
                  {a.cfg.allowedTools && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {a.cfg.allowedTools.map((t) => (
                        <Badge key={t} variant="secondary" className="h-5 font-mono text-[10px]">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    focusAgent(id);
                    setModelPicker(true);
                  }}
                >
                  <Repeat /> Model
                </Button>
              </div>
            );
          })}
        </CardContent>
      </Card>
      <Card className="flex-row items-center gap-4 px-5 py-4 shadow-none">
        <span className="flex size-9 items-center justify-center rounded-lg bg-primary/12 text-primary">
          <Users className="size-4" />
        </span>
        <div className="flex-1">
          <div className="text-[13.5px] font-medium">Build a new team</div>
          <div className="text-xs text-muted-foreground">Pick providers, models and roles again.</div>
        </div>
        <Button onClick={() => useApp.setState({ phase: "setup" })}>Rebuild team</Button>
      </Card>
    </>
  );
}

function ProvidersSection() {
  const api = useApp((s) => s.api);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [creds, setCreds] = useState<Credential[]>([]);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  const load = useCallback(() => {
    if (!api) return;
    void Promise.all([api.providers(), api.credentials()]).then(([p, c]) => {
      setProviders(p.providers);
      setCreds(c.credentials);
    });
  }, [api]);
  useEffect(load, [load]);

  const credOf = (id: string) => creds.find((c) => c.provider === id);
  const all = useMemo(() => {
    if (!providers) return [];
    return (["byok", "local", "login"] as const).flatMap((cat) => providers[cat].map((p) => ({ ...p, cat })));
  }, [providers]);
  const list = all
    .filter((p) => !q || `${p.label} ${p.id}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(Boolean(credOf(b.id))) - Number(Boolean(credOf(a.id))));

  const remove = async (id: string) => {
    try {
      await api?.removeCredential(id);
      toast.success(`Removed the ${id} credential`);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <>
      <Heading title="Providers & keys" description="Stored in your OS keychain, never in the project." />
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter providers…" className="pl-9" />
      </div>
      <Card className="gap-0 py-0 shadow-none">
        <CardContent className="divide-y px-0">
          {!providers ? (
            <div className="flex justify-center py-10 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : (
            list.map((p) => {
              const c = credOf(p.id);
              return (
                <div key={p.id} className="flex items-center gap-3 px-5 py-3">
                  <span className={cn("flex size-8 items-center justify-center rounded-lg", c ? "bg-success/12 text-success" : "bg-muted text-muted-foreground")}>{c ? <Check className="size-4" /> : <KeyRound className="size-4" />}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-medium">{p.label}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">
                      {p.id} · {p.cat === "byok" ? "API key" : p.cat === "local" ? "local / compatible" : "sign-in"}
                      {c && ` · ${c.type === "local" ? "endpoint saved" : c.type === "oauth" ? "signed in" : "key saved"}`}
                    </div>
                  </div>
                  {c && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Remove ${p.label} credential`}>
                          <Trash2 />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remove the {p.label} credential?</AlertDialogTitle>
                          <AlertDialogDescription>Agents using {p.id} will fail until a new key is added. This affects every project and the terminal app.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction variant="destructive" onClick={() => void remove(p.id)}>
                            Remove
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                  <Button variant={c ? "outline" : "default"} size="sm" onClick={() => setEditing({ id: p.id, label: p.label })}>
                    {c ? "Replace" : (
                      <>
                        <Plus /> Add
                      </>
                    )}
                  </Button>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
      <KeyDialog target={editing} onClose={() => setEditing(null)} onSaved={load} />
    </>
  );
}

function KeyDialog({ target, onClose, onSaved }: { target: { id: string; label: string } | null; onClose: () => void; onSaved: () => void }) {
  const api = useApp((s) => s.api);
  const refresh = useApp((s) => s.refreshSession);
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setV(""), [target]);
  const save = async () => {
    if (!api || !target || !v.trim()) return;
    setBusy(true);
    try {
      const isURL = /^https?:\/\//i.test(v.trim());
      const r = await api.saveCredential(isURL ? { provider: target.id, type: "local", baseURL: v.trim() } : { provider: target.id, type: "api", key: v.trim() });
      toast.success(`${target.label} ${isURL ? "endpoint" : "key"} saved`, { description: r.agents.length ? `In use by ${r.agents.join(", ")} right away.` : undefined });
      onSaved();
      void refresh();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={Boolean(target)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{target?.label} key</DialogTitle>
          <DialogDescription>Paste an API key, or a base URL (http://…) for a local or OpenAI-compatible server.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Input autoFocus type="password" autoComplete="off" spellCheck={false} value={v} onChange={(e) => setV(e.target.value)} placeholder="sk-…" className="font-mono" />
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!v.trim() || busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Check />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Behaviour() {
  const info = useApp((s) => s.sessionInfo);
  const api = useApp((s) => s.api);
  const setAutoLocal = useApp((s) => s.setAutoLocal);
  const [compact, setCompact] = useSetting("autoCompact");
  const [thinking, setThinking] = useSetting("thinkingMode");
  const [instructions, setInstructions] = useSetting("projectInstructions");
  const auto = info?.auto ?? false;
  const setAuto = async (v: boolean) => {
    setAutoLocal(v);
    try {
      await api?.setAuto(v);
    } catch (e) {
      setAutoLocal(!v);
      toast.error((e as Error).message);
    }
  };
  return (
    <>
      <Heading title="Agent behaviour" />
      <Card className="gap-0 py-1 shadow-none">
        <CardContent className="divide-y">
          <Row icon={ShieldCheck} title="Auto-approve writes and shell" description="Risky commands and paths outside the project still ask.">
            <Switch checked={auto} onCheckedChange={(v) => void setAuto(v)} />
          </Row>
          <Row icon={RotateCcw} title="Auto-compact long contexts" description="Summarise older turns when context fills up.">
            <Switch checked={compact} onCheckedChange={setCompact} />
          </Row>
          <Row icon={Bot} title="Thinking mode" description="Reason before answering. Slower, more tokens.">
            <Switch checked={thinking} onCheckedChange={setThinking} />
          </Row>
          <Row icon={FileText} title="Use project instructions" description="Load AGENTS.md / CLAUDE.md into every agent.">
            <Switch checked={instructions} onCheckedChange={setInstructions} />
          </Row>
        </CardContent>
      </Card>
    </>
  );
}

function CommandOutput({ name, title, description, icon }: { name: string; title: string; description: string; icon: LucideIcon }) {
  const api = useApp((s) => s.api);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    void api
      ?.runCommand(name)
      .then((r) => setText(r.message || "(nothing)"))
      .catch((e) => setText((e as Error).message));
  }, [api, name]);
  const Icon = icon;
  return (
    <Card className="gap-3 shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className="size-4 text-muted-foreground" /> {title}
        </CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {text === null ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <pre className="selectable max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 font-mono text-[11.5px] leading-relaxed text-muted-foreground scrollbar-thin">{text}</pre>
        )}
      </CardContent>
    </Card>
  );
}

function Integrations() {
  const info = useApp((s) => s.sessionInfo);
  return (
    <>
      <Heading title="Integrations" />
      <Card className="gap-0 py-0 shadow-none">
        <CardHeader className="border-b py-4 [.border-b]:pb-4">
          <CardTitle className="text-sm">Connected servers</CardTitle>
        </CardHeader>
        <CardContent className="divide-y px-0">
          {!info || (info.mcp.length === 0 && info.lsp.length === 0) ? (
            <div className="px-5 py-6 text-xs text-muted-foreground">
              None configured. Add <code className="font-mono">mcpServers:</code> or <code className="font-mono">lsp:</code> to .niti/agents.yaml.
            </div>
          ) : (
            <>
              {info.mcp.map((m) => (
                <div key={m.name} className="flex items-center gap-3 px-5 py-3">
                  <Plug className="size-4 text-muted-foreground" />
                  <span className="text-[13px] font-medium">{m.name}</span>
                  <Badge variant="secondary" className="text-[10.5px]">
                    MCP
                  </Badge>
                  <span className="ml-auto text-xs text-muted-foreground">{m.tools} tools</span>
                </div>
              ))}
              {info.lsp.map((l) => (
                <div key={l.name} className="flex items-center gap-3 px-5 py-3">
                  <Cpu className="size-4 text-muted-foreground" />
                  <span className="text-[13px] font-medium">{l.name}</span>
                  <Badge variant="secondary" className="text-[10.5px]">
                    LSP
                  </Badge>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">{l.command}</span>
                  <span className={cn("ml-auto text-xs", l.running ? "text-success" : "text-muted-foreground")}>{l.running ? "running" : "idle"}</span>
                </div>
              ))}
            </>
          )}
        </CardContent>
      </Card>
      <CommandOutput name="skills" title="Skills" description="Reusable instructions loaded from .niti/skills." icon={ScrollText} />
      <CommandOutput name="permissions" title="Permissions" description="The tool rules agents run under." icon={ShieldCheck} />
    </>
  );
}

function Worktree() {
  const api = useApp((s) => s.api);
  const [w, setW] = useState<WorktreeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => void api?.worktree().then(setW).catch(() => setW({ active: false })), [api]);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true);
    try {
      const r = await fn();
      (r.ok ? toast.success : toast.error)(r.message || (r.ok ? "Done" : "Failed"));
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Heading title="Worktree" description="Each goal runs in its own git worktree until you merge it." />
      {w === null ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      ) : w.active === false ? (
        <Card className="flex-row items-center gap-4 px-5 py-5 shadow-none">
          <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <GitBranch className="size-5" />
          </span>
          <div className="text-sm text-muted-foreground">
            No worktree is active. Add <code className="rounded bg-muted px-1 font-mono text-[12px] text-foreground">worktree: true</code> to .niti/agents.yaml to isolate runs.
          </div>
        </Card>
      ) : (
        <Card className="gap-4 shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <GitBranch className="size-4 text-primary" /> {w.branch}
            </CardTitle>
            <CardDescription className="font-mono text-xs">{w.path}</CardDescription>
            <CardAction className="flex gap-2">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={busy}>
                    <Trash2 /> Discard
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Discard this worktree?</AlertDialogTitle>
                    <AlertDialogDescription>Every change the team made in {w.branch} is thrown away. Your own working tree isn't touched.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep it</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => void act(() => api!.discardWorktree())}>
                      Discard
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Button size="sm" disabled={busy} onClick={() => void act(() => api!.mergeWorktree())}>
                <GitMerge /> Merge into my tree
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <pre className="selectable max-h-72 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11.5px] leading-relaxed scrollbar-thin">{w.diffStat || "No changes yet."}</pre>
          </CardContent>
        </Card>
      )}
    </>
  );
}

function HistorySection() {
  const api = useApp((s) => s.api);
  const active = useApp((s) => s.session.active);
  const [cps, setCps] = useState<Checkpoint[] | null>(null);
  const [n, setN] = useState("1");
  const [branch, setBranch] = useState("");
  const epoch = useApp((s) => s.session.fileEpoch);
  useEffect(() => {
    void api
      ?.checkpoints(40)
      .then((r) => setCps(r.checkpoints))
      .catch(() => setCps([]));
  }, [api, epoch]);
  return (
    <>
      <Heading title="History" />
      <Card className="gap-3 shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Undo2 className="size-4 text-muted-foreground" /> Rewind
          </CardTitle>
          <CardDescription className="text-xs">Undo the last N agent writes. Not available during a run.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Input type="number" min={1} value={n} onChange={(e) => setN(e.target.value)} className="w-20" />
            <Button variant="outline" disabled={active || !Number(n)} onClick={() => void runSlash(`/rewind ${Number(n)}`)}>
              <Undo2 /> Rewind {Number(n) || ""} write{Number(n) === 1 ? "" : "s"}
            </Button>
          </div>
          {cps === null ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : cps.length === 0 ? (
            <EmptyState compact icon={Undo2} title="No checkpoints yet" description="Every agent write records one." className="h-auto min-h-32" />
          ) : (
            <div className="max-h-64 divide-y overflow-y-auto rounded-lg border scrollbar-thin">
              {cps.map((c, i) => (
                <div key={c.id} className="flex items-center gap-3 px-3 py-2 text-[12px]">
                  <span className="w-6 text-right text-muted-foreground tabular">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-mono">{c.path}</span>
                  <span className="shrink-0 text-muted-foreground">{fmtAgo(c.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <Card className="gap-3 shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <GitBranch className="size-4 text-muted-foreground" /> Snapshot to a branch
          </CardTitle>
          <CardDescription className="text-xs">Commit the working tree to a new branch without switching.</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="before-refactor" className="max-w-xs font-mono" />
          <Button variant="outline" disabled={!branch.trim()} onClick={() => void runSlash(`/branch ${branch.trim()}`).then(() => setBranch(""))}>
            <GitBranch /> Create branch
          </Button>
        </CardContent>
      </Card>
      <Card className="gap-0 py-1 shadow-none">
        <CardContent className="divide-y">
          <Row icon={History} title="Saved sessions" description="Every agent conversation is stored in .niti/niti.db.">
            <Button variant="outline" size="sm" onClick={() => void runSlash("/sessions")}>
              View
            </Button>
          </Row>
          <Row icon={Play} title="Resume" description="Run the last planned goal, or pick up an interrupted run.">
            <Button variant="outline" size="sm" disabled={active} onClick={() => void runSlash("/resume")}>
              Resume
            </Button>
          </Row>
          <Row icon={Download} title="Export transcript" description="Save as markdown in .niti/.">
            <Button variant="outline" size="sm" onClick={() => void runSlash("/export")}>
              Export
            </Button>
          </Row>
          <Row icon={Eraser} title="Clear session" description="Reset transcripts, tasks and usage. Files are untouched.">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" disabled={active}>
                  Clear
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear this session?</AlertDialogTitle>
                  <AlertDialogDescription>Transcripts, the task board and usage reset. Your files and saved sessions stay.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => void runSlash("/clear")}>
                    Clear
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </Row>
        </CardContent>
      </Card>
    </>
  );
}

function About() {
  const info = useApp((s) => s.info);
  const root = useApp((s) => s.root) ?? "";
  const restart = useApp((s) => s.restartCore);
  const show = useOutput((s) => s.show);
  return (
    <>
      <Heading title="About" />
      <Card className="flex-row items-center gap-5 px-6 py-6 shadow-none">
        <Wordmark size="lg" />
        <Separator orientation="vertical" className="h-10" />
        <div className="text-sm">
          <div>
            niti app <span className="font-mono">{info?.version}</span>
          </div>
          <div className="text-xs text-muted-foreground">Electron · React · niti-core</div>
        </div>
      </Card>
      <Card className="gap-0 py-1 shadow-none">
        <CardContent className="divide-y">
          <Row icon={Cpu} title="Engine" description={<span className="font-mono">{info?.core}</span>}>
            <Button variant="outline" size="sm" onClick={() => void restart()}>
              <RotateCcw /> Restart
            </Button>
          </Row>
          <Row icon={ScrollText} title="Engine log" description=".niti/core.log · previous run in core.log.1">
            <Button variant="outline" size="sm" onClick={() => void window.niti.coreLog().then((l) => show(".niti/core.log", l || "(empty)"))}>
              View
            </Button>
          </Row>
          <Row icon={FolderOpen} title="Project" description={<span className="font-mono">{shortPath(root, info?.home)}</span>}>
            <Button variant="outline" size="sm" onClick={() => void window.niti.reveal(`${root}/.niti`)}>
              Reveal .niti
            </Button>
          </Row>
          <Row icon={Info} title="Help" description="Commands, prefixes and shortcuts.">
            <Button variant="outline" size="sm" onClick={() => void runSlash("/help")}>
              Open
            </Button>
          </Row>
        </CardContent>
      </Card>
    </>
  );
}
