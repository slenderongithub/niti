import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, KeyRound, Loader2, Rocket, ShieldCheck, Sparkles, Users, Zap, RefreshCw, Crown, Cloud, Cpu, Hourglass, MessageSquare } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { LocalPicker } from "./local-picker";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Kbd } from "@/components/ui/kbd";
import { Wordmark } from "@/components/brand";
import { AgentAvatar } from "@/components/agent-avatar";
import { ThemeToggle } from "@/components/theme-toggle";
import { WindowChrome } from "@/features/launch/window-chrome";
import { agentColor } from "@/lib/identity";
import { PixelAvatar } from "@/components/pixel-avatar";
import { basename, fmtBytes } from "@/lib/format";
import { modelName } from "@/features/models/use-models";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import type { AgentConfig, InstalledModel, Providers, TeamFit } from "@/lib/types";
import { buildAgent, ROLE_SUGGESTIONS, teamHint, MAX_AGENTS } from "./team";

// Team setup on every open, like the TUI's picker (tui/internal/wizard/picker.go): keep the team in
// agents.yaml or build a new one teammate by teammate, pick the lead and the approval mode, save.

type Step =
  | { k: "loading" }
  | { k: "existing" }
  | { k: "size" }
  | { k: "provider"; i: number }
  | { k: "key"; i: number }
  | { k: "model"; i: number }
  | { k: "identity"; i: number }
  | { k: "lead" }
  | { k: "mode" }
  | { k: "review" };

interface Draft {
  provider: string;
  model: string;
  role: string;
  desc: string;
  baseURL?: string;
}

const CATEGORY_LABEL: Record<keyof Providers, string> = { byok: "API key", local: "Local & compatible", login: "Sign in" };

export function TeamSetup() {
  const api = useApp((s) => s.api)!;
  const info = useApp((s) => s.sessionInfo);
  // Harness runs keep the existing team on open, unless the audit has opened setup to walk it.
  const smoke = useApp((s) => Boolean(s.info?.harness) && s.harnessKeepsTeam);
  const finish = useApp((s) => s.finishSetup);
  const root = useApp((s) => s.root) ?? "";

  const existing = info?.agents ?? [];
  const [step, setStep] = useState<Step>({ k: "loading" });
  const [dir, setDir] = useState(1);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [creds, setCreds] = useState<Set<string>>(new Set());
  const [size, setSize] = useState(2);
  const [team, setTeam] = useState<Draft[]>([]);
  const [lead, setLead] = useState(0);
  const [auto, setAuto] = useState(Boolean(info?.auto));
  const [saving, setSaving] = useState(false);
  // Cloud or this Mac, for the teammate being picked — remembered from the last pick.
  const [where, setWhere] = useState<"cloud" | "local">("cloud");
  const history = useRef<Step[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.providers(), api.credentials()])
      .then(([p, c]) => {
        if (cancelled) return;
        setProviders(p.providers);
        setCreds(new Set(c.credentials.map((x) => x.provider)));
        if (smoke && existing.length) void finish(false);
        else setStep(existing.length ? { k: "existing" } : { k: "size" });
      })
      .catch((err) => toast.error(`Couldn't load providers: ${err.message}`));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const go = (next: Step) => {
    history.current.push(step);
    setDir(1);
    setStep(next);
  };
  const back = () => {
    const prev = history.current.pop();
    if (!prev) return;
    setDir(-1);
    // Stepping back past a teammate's provider removes that teammate (the TUI's rule).
    if (step.k === "provider" && prev.k !== "provider") setTeam((t) => t.slice(0, step.i));
    setStep(prev);
  };

  const cur = "i" in step ? team[step.i] : undefined;
  const patch = (i: number, p: Partial<Draft>) => setTeam((t) => t.map((d, j) => (j === i ? { ...d, ...p } : d)));

  const afterIdentity = (i: number) => {
    if (i + 1 < size) go({ k: "provider", i: i + 1 });
    else if (size > 1) go({ k: "lead" });
    else go({ k: "mode" });
  };

  const save = async () => {
    setSaving(true);
    try {
      const used = new Set<string>();
      const agents: AgentConfig[] = team.map((d, i) => buildAgent({ ...d, lead: i === (size > 1 ? lead : 0) }, used));
      await api.saveAgents(agents);
      await api.setAuto(auto).catch((err) => toast.warning(`Saved the team, but couldn't set the approval mode: ${err.message}`));
      await finish(true);
    } catch (err) {
      toast.error(`Couldn't save the team: ${(err as Error).message}`);
      setSaving(false);
    }
  };

  const stepIndex = (() => {
    switch (step.k) {
      case "existing":
      case "size":
        return 0;
      case "provider":
      case "key":
      case "model":
      case "identity":
        return 1;
      case "lead":
      case "mode":
        return 2;
      case "review":
        return 3;
      default:
        return 0;
    }
  })();

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background">
      <WindowChrome>
        <ThemeToggle />
      </WindowChrome>
      <div className="relative z-10 flex flex-1 items-center justify-center px-6 pb-10">
        <Card className="grid h-[min(680px,calc(100vh-110px))] w-full max-w-5xl grid-cols-[1fr_340px] gap-0 overflow-hidden p-0 shadow-2xl shadow-black/10">
          {/* main */}
          <div className="flex min-h-0 flex-col">
            <div className="flex items-center gap-3 border-b px-7 py-4">
              <Wordmark size="sm" />
              <span className="text-muted-foreground/50">/</span>
              <span className="truncate text-sm text-muted-foreground">{basename(root)}</span>
              <div className="ml-auto flex items-center gap-1.5">
                {["Team", "Teammates", "Rules", "Launch"].map((s, i) => (
                  <div key={s} className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium transition-colors",
                        i === stepIndex ? "bg-primary/12 text-primary" : i < stepIndex ? "text-foreground" : "text-muted-foreground/60",
                      )}
                    >
                      {i < stepIndex ? <Check className="size-3" /> : <span className="tabular">{i + 1}</span>}
                      {s}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="relative min-h-0 flex-1 overflow-hidden">
              <AnimatePresence mode="popLayout" custom={dir} initial={false}>
                <motion.div
                  key={JSON.stringify(step)}
                  custom={dir}
                  initial={{ opacity: 0, x: dir * 28 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: dir * -28 }}
                  transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
                  className="absolute inset-0 flex flex-col px-7 py-6"
                >
                  {step.k === "loading" && (
                    <div className="flex flex-1 items-center justify-center text-muted-foreground">
                      <Loader2 className="size-5 animate-spin" />
                    </div>
                  )}

                  {step.k === "existing" && (
                    <StepBody icon={<Users />} title="Your team" description="This folder already has a team in .niti/agents.yaml.">
                      <div className="grid gap-3">
                        <OptionCard
                          autoFocus
                          icon={<Zap />}
                          title={`Continue with this team (${existing.length} agent${existing.length === 1 ? "" : "s"})`}
                          description={existing.map((a) => `${a.role} · ${a.provider}/${a.model}`).join("   ")}
                          onClick={() => void finish(false)}
                          kbd="↵"
                        />
                        <OptionCard icon={<RefreshCw />} title="Pick a new team" description="Replaces the agents: block in agents.yaml. Everything else in the file is kept." onClick={() => go({ k: "size" })} />
                      </div>
                    </StepBody>
                  )}

                  {step.k === "size" && (
                    <StepBody icon={<Users />} title="How many teammates?" description="Each teammate is one model with its own role. The lead plans the work and hands out tasks.">
                      <div className="grid grid-cols-3 gap-3">
                        {Array.from({ length: MAX_AGENTS }, (_, k) => k + 1).map((n) => (
                          <Button
                            key={n}
                            variant="outline"
                            autoFocus={n === size}
                            onClick={() => {
                              setSize(n);
                              setTeam((t) => t.slice(0, n));
                              go({ k: "provider", i: 0 });
                            }}
                            className={cn("group h-auto flex-col items-start gap-3 rounded-xl p-4 text-left", n === size && "border-primary/50 bg-primary/6")}
                          >
                            <span className="flex gap-1">
                              {Array.from({ length: n }, (_, j) => (
                                <span key={j} className="transition-transform group-hover:-translate-y-0.5" style={{ transitionDelay: `${j * 25}ms` }}>
                                  <PixelAvatar slot={j} color={agentColor(j)} size={16} />
                                </span>
                              ))}
                            </span>
                            <span>
                              <span className="block text-sm font-semibold">
                                {n} teammate{n > 1 ? "s" : ""}
                              </span>
                              <span className="block text-xs font-normal whitespace-normal text-muted-foreground">{teamHint(n)}</span>
                            </span>
                          </Button>
                        ))}
                      </div>
                    </StepBody>
                  )}

                  {step.k === "provider" && providers && (
                    <StepBody
                      icon={where === "local" ? <Cpu /> : <Cloud />}
                      title={where === "local" ? "A model on this Mac" : "Provider"}
                      eyebrow={`Teammate ${step.i + 1} of ${size}`}
                      description={where === "local" ? "Runs privately on this Mac — no key, no cost, works offline. niti loads it when the team starts." : "Where this teammate's model runs. Providers with a saved key are ready to go."}
                    >
                      <ToggleGroup
                        type="single"
                        variant="outline"
                        value={where}
                        onValueChange={(v) => v && setWhere(v as "cloud" | "local")}
                        aria-label="Where this teammate runs"
                        className="mb-3 w-full"
                      >
                        <ToggleGroupItem value="cloud" className="flex-1 gap-2">
                          <Cloud /> Cloud
                        </ToggleGroupItem>
                        <ToggleGroupItem value="local" className="flex-1 gap-2">
                          <Cpu /> On this Mac
                        </ToggleGroupItem>
                      </ToggleGroup>
                      {where === "local" ? (
                        <LocalPicker
                          value={cur?.provider === "local" ? cur.model : undefined}
                          onPick={(id) => {
                            setTeam((t) => {
                              const next = [...t];
                              next[step.i] = { ...(next[step.i] ?? { role: "", desc: "" }), provider: "local", model: id, baseURL: undefined };
                              return next;
                            });
                            go({ k: "identity", i: step.i });
                          }}
                        />
                      ) : (
                        <ProviderPicker
                          providers={{ ...providers, local: providers.local.filter((p) => p.id !== "local") }}
                          creds={creds}
                          value={cur?.provider}
                          onPick={(id) => {
                            setTeam((t) => {
                              const next = [...t];
                              next[step.i] = { ...(next[step.i] ?? { model: "", role: "", desc: "" }), provider: id };
                              return next;
                            });
                            go(creds.has(id) ? { k: "model", i: step.i } : { k: "key", i: step.i });
                          }}
                        />
                      )}
                    </StepBody>
                  )}

                  {step.k === "key" && cur && (
                    <KeyStep
                      provider={cur.provider}
                      label={labelOf(providers, cur.provider)}
                      eyebrow={`Teammate ${step.i + 1} of ${size}`}
                      onSave={async (value) => {
                        const isURL = /^https?:\/\//i.test(value);
                        await api.saveCredential(isURL ? { provider: cur.provider, type: "local", baseURL: value } : { provider: cur.provider, type: "api", key: value });
                        setCreds((c) => new Set(c).add(cur.provider));
                        if (isURL) patch(step.i, { baseURL: value });
                        toast.success(`${labelOf(providers, cur.provider)} ${isURL ? "endpoint" : "key"} saved`);
                        go({ k: "model", i: step.i });
                      }}
                    />
                  )}

                  {step.k === "model" && cur && (
                    <StepBody icon={<Sparkles />} title={`Model · ${labelOf(providers, cur.provider)}`} eyebrow={`Teammate ${step.i + 1} of ${size}`} description="Pick from the catalog, or type any model id the provider serves.">
                      <ModelPicker
                        provider={cur.provider}
                        value={cur.model}
                        onPick={(m) => {
                          patch(step.i, { model: m });
                          go({ k: "identity", i: step.i });
                        }}
                      />
                    </StepBody>
                  )}

                  {step.k === "identity" && cur && (
                    <IdentityStep
                      index={step.i}
                      size={size}
                      draft={cur}
                      onDone={(role, desc) => {
                        patch(step.i, { role, desc });
                        afterIdentity(step.i);
                      }}
                    />
                  )}

                  {step.k === "lead" && (
                    <StepBody icon={<Crown />} title="Who leads?" description="The lead talks with you, plans the work into tasks, hands them out and integrates the results.">
                      <div className="grid gap-2.5">
                        {team.map((d, i) => (
                          <OptionCard
                            key={i}
                            autoFocus={i === lead}
                            selected={i === lead}
                            icon={<AgentAvatar slot={i} color={agentColor(i)} size="sm" />}
                            title={d.role || `Engineer ${i + 1}`}
                            description={`${labelOf(providers, d.provider)} · ${d.model}`}
                            onClick={() => {
                              setLead(i);
                              go({ k: "mode" });
                            }}
                          />
                        ))}
                      </div>
                    </StepBody>
                  )}

                  {step.k === "mode" && (
                    <StepBody icon={<ShieldCheck />} title="Approvals" description="How much should this team ask before acting? You can change it any time.">
                      <div className="grid gap-3">
                        <OptionCard
                          autoFocus={!auto}
                          selected={!auto}
                          icon={<ShieldCheck />}
                          title="Manual — ask before each write and shell command"
                          description="Quieter than it sounds: ls, git status, cat and friends never ask."
                          onClick={() => {
                            setAuto(false);
                            go({ k: "review" });
                          }}
                        />
                        <OptionCard
                          autoFocus={auto}
                          selected={auto}
                          icon={<Zap />}
                          title="Auto-approve — don't ask before writes or shell"
                          description="Risky commands (rm -rf, force-push) and anything outside the project still confirm."
                          onClick={() => {
                            setAuto(true);
                            go({ k: "review" });
                          }}
                        />
                      </div>
                    </StepBody>
                  )}

                  {step.k === "review" && (
                    <StepBody icon={<Rocket />} title="Ready to launch" description="Your team is saved to .niti/agents.yaml and niti restarts with it.">
                      <div className="grid gap-2">
                        {team.map((d, i) => (
                          <div key={i} className="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2.5">
                            <AgentAvatar slot={i} color={agentColor(i)} lead={i === (size > 1 ? lead : 0)} size="sm" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium">{d.role || `Engineer ${i + 1}`}</div>
                              <div className="truncate font-mono text-[11px] text-muted-foreground">
                                {d.provider}/{d.model}
                              </div>
                            </div>
                          </div>
                        ))}
                        <LocalTeamNote team={team} lead={size > 1 ? lead : 0} />
                        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                          {auto ? <Zap className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
                          {auto ? "Auto-approve" : "Manual approvals"}
                        </div>
                      </div>
                      <div className="mt-auto pt-6">
                        <Button size="lg" className="w-full" disabled={saving} onClick={() => void save()} autoFocus>
                          {saving ? <Loader2 className="animate-spin" /> : <Rocket />}
                          {saving ? "Saving…" : "Launch team"}
                        </Button>
                      </div>
                    </StepBody>
                  )}
                </motion.div>
              </AnimatePresence>
            </div>

            <div className="flex items-center justify-between border-t px-7 py-3">
              <Button variant="ghost" size="sm" onClick={back} disabled={!history.current.length || step.k === "loading"}>
                <ArrowLeft /> Back <Kbd>esc</Kbd>
              </Button>
              <span className="text-xs text-muted-foreground">Enter to choose · arrows to move</span>
            </div>
          </div>

          {/* preview */}
          <aside className="flex min-h-0 flex-col border-l bg-muted/40">
            <div className="px-6 pb-3 pt-5">
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Your team</div>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4 pt-1 scrollbar-thin">
              <AnimatePresence initial={false}>
                {(step.k === "existing" ? existing.map((a) => ({ provider: a.provider, model: a.model, role: a.role, desc: "" })) : Array.from({ length: Math.max(size, team.length) }, (_, i) => team[i])).map((d, i) => {
                  const active = "i" in step && step.i === i;
                  const isLead = step.k === "existing" ? existing[i]?.lead : size === 1 ? i === 0 : i === lead && (step.k === "mode" || step.k === "review" || step.k === "lead");
                  return (
                    <motion.div
                      key={i}
                      layout
                      initial={{ opacity: 0, scale: 0.96 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.96 }}
                      className={cn(
                        "flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5 transition-shadow",
                        !d && "border-dashed bg-transparent",
                        active && "border-primary shadow-[inset_0_0_0_1px_var(--primary)]",
                      )}
                    >
                      <AgentAvatar slot={i} color={d ? agentColor(i) : "var(--muted-foreground)"} lead={isLead} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className={cn("truncate text-sm font-medium", !d?.role && "text-muted-foreground")}>{d?.role || (d ? `Engineer ${i + 1}` : `Teammate ${i + 1}`)}</div>
                        <div className="truncate font-mono text-[11px] text-muted-foreground">{d ? `${d.provider}${d.model ? `/${d.model}` : ""}` : "not picked yet"}</div>
                      </div>
                      {d && creds.has(d.provider) && <KeyRound className="size-3.5 text-muted-foreground" />}
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
            <div className="border-t px-6 py-4 text-xs leading-relaxed text-muted-foreground">
              Teammates work in parallel on tasks the lead hands out, message each other, and review each other's work.
            </div>
          </aside>
        </Card>
      </div>
      <SetupKeys onBack={back} />
    </div>
  );
}

// Esc goes back a step from anywhere in setup — including from inside a filter list, which is
// where focus sits on most steps. A dialog or menu open on top gets its own Esc first.
function SetupKeys({ onBack }: { onBack: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector("[role=dialog],[role=alertdialog],[role=menu],[role=listbox][data-state=open]")) return;
      e.preventDefault();
      onBack();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onBack]);
  return null;
}

function labelOf(p: Providers | null, id: string): string {
  if (!p) return id;
  for (const k of ["byok", "local", "login"] as const) {
    const hit = p[k].find((x) => x.id === id);
    if (hit) return hit.label;
  }
  return id;
}

function StepBody({ icon, title, eyebrow, description, children }: { icon: ReactNode; title: string; eyebrow?: string; description: string; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-5 flex items-start gap-3.5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary [&_svg]:size-[18px]">{icon}</span>
        <div>
          {eyebrow && <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wider text-primary">{eyebrow}</div>}
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

function OptionCard({
  icon,
  title,
  description,
  onClick,
  selected,
  autoFocus,
  kbd,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  selected?: boolean;
  autoFocus?: boolean;
  kbd?: string;
}) {
  return (
    <Button
      variant="outline"
      autoFocus={autoFocus}
      onClick={onClick}
      className={cn(
        "group h-auto w-full justify-start gap-3.5 whitespace-normal rounded-xl p-4 text-left focus-visible:border-primary/60",
        selected && "border-primary/50 bg-primary/6",
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:text-primary group-focus-visible:text-primary [&_svg]:size-4">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs font-normal leading-relaxed text-muted-foreground">{description}</span>
      </span>
      {kbd ? <Kbd>{kbd}</Kbd> : <ArrowRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />}
    </Button>
  );
}

function ProviderPicker({ providers, creds, value, onPick }: { providers: Providers; creds: Set<string>; value?: string; onPick: (id: string) => void }) {
  const ready = useMemo(() => (["byok", "local", "login"] as const).flatMap((k) => providers[k].filter((p) => creds.has(p.id)).map((p) => ({ ...p, cat: k }))), [providers, creds]);
  return (
    <Command className="min-h-0 flex-1 rounded-xl border" defaultValue={value}>
      <CommandInput autoFocus placeholder="Filter providers…" />
      <CommandList className="max-h-none flex-1">
        <CommandEmpty>No provider matches.</CommandEmpty>
        {ready.length > 0 && (
          <CommandGroup heading="Ready — key saved">
            {ready.map((p) => (
              <CommandItem key={`r-${p.id}`} value={`${p.label} ${p.id} ready`} onSelect={() => onPick(p.id)}>
                <Check className="text-success" />
                <span className="font-medium">{p.label}</span>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">{p.id}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {(["byok", "local", "login"] as const).map((k) => {
          const rest = providers[k].filter((p) => !creds.has(p.id));
          if (!rest.length) return null;
          return (
            <CommandGroup key={k} heading={CATEGORY_LABEL[k]}>
              {rest.map((p) => (
                <CommandItem key={p.id} value={`${p.label} ${p.id}`} onSelect={() => onPick(p.id)}>
                  <span className="size-4" />
                  <span>{p.label}</span>
                  <span className="ml-auto font-mono text-[11px] text-muted-foreground">{p.id}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          );
        })}
      </CommandList>
    </Command>
  );
}

function ModelPicker({ provider, value, onPick }: { provider: string; value?: string; onPick: (m: string) => void }) {
  const api = useApp((s) => s.api)!;
  const [models, setModels] = useState<string[] | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    void api
      .models(provider)
      .then((r) => setModels(r.models))
      .catch(() => setModels([]));
  }, [api, provider]);
  const typed = q.trim();
  const exact = models?.some((m) => m === typed);
  return (
    <Command className="min-h-0 flex-1 rounded-xl border" defaultValue={value}>
      <CommandInput autoFocus placeholder="Filter, or type any model id…" value={q} onValueChange={setQ} />
      <CommandList className="max-h-none flex-1">
        {models === null ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : (
          <>
            <CommandEmpty>{typed ? "Press Enter to use it as typed." : "This provider lists no models — type one."}</CommandEmpty>
            {typed && !exact && (
              <CommandGroup heading="Custom">
                <CommandItem value={`__custom ${typed}`} onSelect={() => onPick(typed)} forceMount>
                  <Sparkles />
                  Use <span className="font-mono">{typed}</span>
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup heading={`${models.length} models`}>
              {models.map((m) => (
                <CommandItem key={m} value={m} onSelect={() => onPick(m)}>
                  <span className="font-mono text-[13px]">{m}</span>
                  {m === value && <Check className="ml-auto text-primary" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );
}

function KeyStep({ provider, label, eyebrow, onSave }: { provider: string; label: string; eyebrow: string; onSave: (v: string) => Promise<void> }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await onSave(value.trim());
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <StepBody icon={<KeyRound />} title={`${label} key`} eyebrow={eyebrow} description="Stored in your OS keychain and ~/.config/niti/auth.json — never in the project.">
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Label htmlFor="key">API key, or a base URL for a local / compatible server</Label>
        <Input id="key" type="password" autoFocus autoComplete="off" spellCheck={false} placeholder={provider === "ollama" ? "http://localhost:11434/v1" : "sk-…"} value={value} onChange={(e) => setValue(e.target.value)} className="h-11 font-mono" />
        <p className="text-xs text-muted-foreground">Anything starting with http:// or https:// is saved as an endpoint instead of a key.</p>
        <div className="mt-2">
          <Button type="submit" disabled={!value.trim() || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Check />} Save and continue
          </Button>
        </div>
      </form>
    </StepBody>
  );
}

function IdentityStep({ index, size, draft, onDone }: { index: number; size: number; draft: Draft; onDone: (role: string, desc: string) => void }) {
  const [role, setRole] = useState(draft.role);
  const [desc, setDesc] = useState(draft.desc);
  const fallback = `Engineer ${index + 1}`;
  return (
    <StepBody icon={<AgentAvatar slot={index} color={agentColor(index)} size="xs" />} title="Name this teammate" eyebrow={`Teammate ${index + 1} of ${size}`} description="The role is how you and the other agents refer to it; the description goes into its instructions verbatim.">
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          onDone(role.trim() || fallback, desc.trim());
        }}
      >
        <div className="grid gap-2">
          <Label htmlFor="role">Role</Label>
          <Input id="role" autoFocus value={role} placeholder={fallback} onChange={(e) => setRole(e.target.value)} className="h-10" />
          <div className="flex flex-wrap gap-1.5">
            {ROLE_SUGGESTIONS.map((r) => (
              <Badge key={r.role} asChild variant={role === r.role ? "default" : "outline"} className="cursor-pointer">
                <button
                  type="button"
                  onClick={() => {
                    setRole(r.role);
                    if (!desc) setDesc(r.desc);
                  }}
                >
                  {r.role}
                </button>
              </Badge>
            ))}
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="desc">What does {role.trim() || fallback} do?</Label>
          <Textarea
            id="desc"
            value={desc}
            placeholder="Owns the API layer and database migrations. Writes tests for everything it touches."
            onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onDone(role.trim() || fallback, desc.trim());
              }
            }}
            className="min-h-24 resize-none"
          />
        </div>
        <div>
          <Button type="submit">
            Continue <ArrowRight />
          </Button>
        </div>
      </form>
    </StepBody>
  );
}

// What a team on local models should know before it starts: models that don't fit in memory together
// take turns (the core loads one beside another only if both fit), a chat-only model gets answers and
// reviews but no work that changes files, and a lead whose model couldn't split work in its check
// hands the planning to a teammate.
function LocalTeamNote({ team, lead }: { team: Draft[]; lead: number }) {
  const api = useApp((s) => s.api);
  const [fit, setFit] = useState<TeamFit | null>(null);
  const [installed, setInstalled] = useState<InstalledModel[]>([]);
  const local = team.filter((d) => d.provider === "local").map((d) => d.model);
  const key = local.join("|");
  useEffect(() => {
    if (!api || !local.length) return;
    void api.teamFit(local).then(setFit).catch(() => setFit(null));
    void api.installedModels().then((r) => setInstalled(r.models)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);
  if (!local.length) return null;
  const probeOf = (id: string) => installed.find((m) => m.id === id)?.probe;
  const name = (d: Draft, i: number) => d.role || `Engineer ${i + 1}`;
  const chatOnly = team.map((d, i) => ({ d, i })).filter(({ d }) => d.provider === "local" && probeOf(d.model)?.verdict === "chat-only");
  const leadDraft = team[lead];
  const leadCantPlan = leadDraft?.provider === "local" && probeOf(leadDraft.model)?.planMode === "none";
  const distinct = [...new Set(local)];
  const lines: { icon: typeof Hourglass; text: string }[] = [];
  if (fit && !fit.together && distinct.length > 1)
    lines.push({ icon: Hourglass, text: `${distinct.map(modelName).join(" and ")} take turns: together they need ${fmtBytes(fit.need)}, and this Mac gives models ${fmtBytes(fit.budget)}. One runs while the other waits.` });
  for (const { d, i } of chatOnly) lines.push({ icon: MessageSquare, text: `${name(d, i)} runs ${modelName(d.model)}, which is chat only: it answers and reviews, but isn't given work that changes files.` });
  if (leadCantPlan) lines.push({ icon: Users, text: `${modelName(leadDraft!.model)} couldn't split work in niti's check, so a teammate makes the plan.` });
  const unchecked = distinct.filter((id) => installed.length && !probeOf(id));
  if (unchecked.length) lines.push({ icon: ShieldCheck, text: `niti checks ${unchecked.map(modelName).join(" and ")} once before the first task (about a minute each).` });
  if (!lines.length) return null;
  return (
    <div className="mt-1 space-y-1.5 rounded-lg border bg-muted/40 px-3 py-2.5 text-[12px] text-muted-foreground">
      {lines.map((l) => (
        <div key={l.text} className="flex gap-2">
          <l.icon className="mt-[1px] size-3.5 shrink-0" aria-hidden />
          <span>{l.text}</span>
        </div>
      ))}
    </div>
  );
}
