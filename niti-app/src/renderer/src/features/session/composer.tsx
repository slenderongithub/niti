import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowUp, AtSign, Check, ChevronDown, Hammer, ListChecks, Megaphone, Slash, Square, Terminal, Users, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/ui/kbd";
import { PixelAvatar } from "@/components/pixel-avatar";
import { interrupt, isSlashCommand, LOCAL_COMMANDS, send, type Target } from "@/lib/actions";
import { steerTarget, workingAgents } from "@/lib/reducer";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { useAgentsLite } from "@/hooks/use-agents-lite";

// The command line to the whole team. Split in two so typing re-renders only the input: the
// toolbar (mode, target, stop) subscribes to the run; the input owns the text, menus and history.

type Menu = { kind: "slash"; query: string } | { kind: "mention"; query: string; start: number } | null;

const HISTORY_MAX = 200;
const historyKey = (root: string) => `niti.history.${root}`;
function loadHistory(root: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(historyKey(root)) ?? "[]") as string[];
  } catch {
    return [];
  }
}

// prefix > substring > subsequence — the TUI's menu ranking (internal/ui/list.go:58-103).
function rank(name: string, q: string): number {
  if (!q) return 1;
  const n = name.toLowerCase();
  const s = q.toLowerCase();
  if (n.startsWith(s)) return 3;
  if (n.includes(s)) return 2;
  let i = 0;
  for (const ch of n) if (ch === s[i]) i++;
  return i === s.length ? 1 : 0;
}

export function Composer() {
  const mode = useApp((s) => s.mode);
  const setMode = useApp((s) => s.setMode);
  const active = useApp((s) => s.session.active);
  const lead = useApp((s) => s.session.leadId);
  const suggestion = useApp((s) => (!s.session.active && s.session.summary?.next?.[0]) || "");
  const focused = useUI((s) => s.focusedAgent);
  const working = useApp(useShallow((s) => workingAgents(s.session)));
  const autoTo = useApp((s) => steerTarget(s.session, focused ?? undefined));
  const agents = useAgentsLite();
  const byId = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])), [agents]);
  const [target, setTarget] = useState<Target>("auto");

  // Target follows focus: focusing a working agent while a run is on steers to it by default.
  useEffect(() => setTarget(focused && byId[focused] ? focused : "auto"), [focused]); // eslint-disable-line react-hooks/exhaustive-deps

  const targetLabel = !active ? "Team" : target === "auto" ? `Auto · ${byId[autoTo ?? ""]?.role ?? "lead"}` : target === "broadcast" ? `Everyone working (${working.length})` : (byId[target]?.role ?? target);
  const placeholder = active
    ? target === "broadcast"
      ? "Message everyone working…"
      : `Message ${targetLabel.replace(/^Auto · /, "")}…`
    : suggestion
      ? `${suggestion}   (tab to use)`
      : mode === "plan"
        ? "What should the team plan?"
        : "What should the team build?";

  const toolbar = (
    <>
      <ToggleGroup type="single" size="sm" value={mode} onValueChange={(v) => v && setMode(v as "build" | "plan")} className="h-7 rounded-lg bg-muted p-0.5">
        <ToggleGroupItem value="build" className="h-6 gap-1 rounded-md px-2 text-[11.5px] data-[state=on]:bg-card data-[state=on]:text-primary data-[state=on]:shadow-panel">
          <Hammer className="size-3" /> Build
        </ToggleGroupItem>
        <ToggleGroupItem value="plan" className="h-6 gap-1 rounded-md px-2 text-[11.5px] data-[state=on]:bg-card data-[state=on]:text-plan data-[state=on]:shadow-panel">
          <ListChecks className="size-3" /> Plan
        </ToggleGroupItem>
      </ToggleGroup>
      {active ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-[11.5px] font-normal text-muted-foreground">
              {target === "broadcast" ? <Megaphone className="size-3" /> : <Wand2 className="size-3" />}
              To: <span className="font-medium text-foreground">{targetLabel}</span>
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel className="text-xs">Send mid-run messages to</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => setTarget("auto")}>
              <Wand2 /> Auto <span className="ml-auto text-xs text-muted-foreground">{byId[autoTo ?? ""]?.role}</span>
              {target === "auto" && <Check className="text-primary" />}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTarget("broadcast")} disabled={!working.length}>
              <Megaphone /> Everyone working <span className="ml-auto text-xs text-muted-foreground">{working.length}</span>
              {target === "broadcast" && <Check className="text-primary" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {agents.map((a) => (
              <DropdownMenuItem key={a.id} onClick={() => setTarget(a.id)} disabled={a.status !== "working"}>
                <PixelAvatar slot={a.index} color={a.color} size={14} />
                {a.role}
                <span className="ml-auto text-[11px] capitalize text-muted-foreground">{a.status}</span>
                {target === a.id && <Check className="text-primary" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex h-7 min-w-0 items-center gap-1.5 px-2 text-[11.5px] text-muted-foreground">
              <Users className="size-3 shrink-0" /> To: <span className="font-medium text-foreground">the team</span>
              {lead && byId[lead] && <span className="truncate">· {byId[lead]!.role} leads</span>}
            </span>
          </TooltipTrigger>
          <TooltipContent>Every prompt goes to the whole team: the lead plans it into tasks for each agent.</TooltipContent>
        </Tooltip>
      )}
    </>
  );

  return (
    <ComposerInput
      placeholder={placeholder}
      suggestion={suggestion}
      active={active}
      target={active ? target : "team"}
      toolbar={toolbar}
      stop={
        active ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="outline" className="rounded-full" onClick={() => void interrupt()} aria-label="Stop">
                <Square className="size-3 fill-current" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Stop after the current step <Kbd>esc</Kbd>
            </TooltipContent>
          </Tooltip>
        ) : null
      }
    />
  );
}

const ComposerInput = memo(function ComposerInput({ placeholder, suggestion, active, target, toolbar, stop }: { placeholder: string; suggestion: string; active: boolean; target: Target; toolbar: ReactNode; stop: ReactNode }) {
  const root = useApp((s) => s.root) ?? "";
  const api = useApp((s) => s.api);
  const commands = useApp((s) => s.commands);
  const fileEpoch = useApp((s) => s.session.fileEpoch);
  const plannedGoal = useApp((s) => s.session.plannedGoal);
  const mode = useApp((s) => s.mode);
  const [text, setText] = useState("");
  const [menu, setMenu] = useState<Menu>(null);
  const [sel, setSel] = useState("");
  const [files, setFiles] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const hist = useRef<{ list: string[]; i: number; draft: string }>({ list: loadHistory(root), i: -1, draft: "" });
  const ta = useRef<HTMLTextAreaElement>(null);
  const lastEsc = useRef(0);

  useEffect(() => setFiles(null), [fileEpoch]);
  useEffect(() => {
    if (menu?.kind === "mention" && files === null && api) void api.files().then((r) => setFiles(r.files)).catch(() => setFiles([]));
  }, [menu, files, api]);

  useEffect(() => {
    const focusIt = () => ta.current?.focus();
    const prefill = (e: Event) => {
      setText(String((e as CustomEvent).detail ?? ""));
      requestAnimationFrame(() => ta.current?.focus());
    };
    window.addEventListener("niti:focus-composer", focusIt);
    window.addEventListener("niti:prefill", prefill);
    return () => {
      window.removeEventListener("niti:focus-composer", focusIt);
      window.removeEventListener("niti:prefill", prefill);
    };
  }, []);

  const slashItems = useMemo(() => {
    if (menu?.kind !== "slash") return [];
    const all = [...LOCAL_COMMANDS, ...commands.filter((c) => !LOCAL_COMMANDS.some((l) => l.name === c.name))];
    return all
      .map((c) => ({ c, r: rank(c.name, menu.query) }))
      .filter((x) => x.r > 0)
      .sort((a, b) => b.r - a.r)
      .slice(0, 50)
      .map((x) => x.c);
  }, [menu, commands]);
  const mentionItems = useMemo(() => {
    if (menu?.kind !== "mention" || !files) return [];
    const q = menu.query.toLowerCase();
    return files
      .map((f) => ({ f, r: rank(f, q) + (f.split("/").pop()!.toLowerCase().startsWith(q) ? 2 : 0) }))
      .filter((x) => x.r > 0)
      .sort((a, b) => b.r - a.r || a.f.length - b.f.length)
      .slice(0, 40)
      .map((x) => x.f);
  }, [menu, files]);
  const menuValues = useMemo(() => (menu?.kind === "slash" ? slashItems.map((c) => `/${c.name}`) : mentionItems), [menu?.kind, slashItems, mentionItems]);
  useEffect(() => setSel(menuValues[0] ?? ""), [menuValues]);

  const updateMenu = (value: string, caret: number) => {
    if (/^\/[^\s/]*$/.test(value)) return setMenu({ kind: "slash", query: value.slice(1) });
    const before = value.slice(0, caret);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    if (m) setMenu({ kind: "mention", query: m[2]!, start: before.length - m[2]!.length - 1 });
    else if (menu) setMenu(null);
  };

  const pick = (value: string) => {
    if (!menu) return;
    if (menu.kind === "slash") setText(`${value} `);
    else {
      const caret = ta.current?.selectionStart ?? text.length;
      setText(`${text.slice(0, menu.start)}@${value} ${text.slice(caret)}`);
      const pos = menu.start + value.length + 2;
      requestAnimationFrame(() => ta.current?.setSelectionRange(pos, pos));
    }
    setMenu(null);
    ta.current?.focus();
  };

  const submit = async (raw = text) => {
    const t = raw.trim();
    if (!t || busy) return;
    const list = hist.current.list.filter((h) => h !== t);
    list.push(t);
    hist.current = { list: list.slice(-HISTORY_MAX), i: -1, draft: "" };
    try {
      localStorage.setItem(historyKey(root), JSON.stringify(hist.current.list));
    } catch {
      /* history is a convenience */
    }
    setBusy(true);
    const ok = await send(t, target);
    setBusy(false);
    // In Plan mode the goal stays put: switch to Build and send it again to run exactly that plan.
    if (ok && !(mode === "plan" && !isSlashCommand(t) && !t.startsWith("!") && !active)) setText("");
    setMenu(null);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu && menuValues.length) {
      const i = Math.max(0, menuValues.indexOf(sel));
      if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey) || (e.ctrlKey && e.key === "n")) {
        e.preventDefault();
        if (e.key === "Tab") pick(sel || menuValues[0]!);
        else setSel(menuValues[(i + 1) % menuValues.length]!);
        return;
      }
      if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
        e.preventDefault();
        setSel(menuValues[(i - 1 + menuValues.length) % menuValues.length]!);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const v = sel || menuValues[0]!;
        if (menu.kind === "slash") {
          setMenu(null);
          void submit(text.trim() === v ? text : v); // run the command straight from the menu, like the TUI
        } else pick(v);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      useApp.getState().setMode(mode === "plan" ? "build" : "plan");
      return;
    }
    if (e.key === "Tab" && !text && suggestion) {
      e.preventDefault();
      setText(suggestion);
      return;
    }
    if (e.key === "Escape") {
      if (menu) {
        e.preventDefault();
        setMenu(null);
      } else if (active) {
        // Esc is a reflex for closing things; stopping the whole run takes a second press.
        e.preventDefault();
        if (Date.now() - lastEsc.current < 1500) {
          lastEsc.current = 0;
          void interrupt();
        } else {
          lastEsc.current = Date.now();
          toast("Press Esc again to stop the run", { duration: 1500 });
        }
      } else if (text) {
        e.preventDefault();
        setText("");
      }
      return;
    }
    const h = hist.current;
    const caretAtStart = (ta.current?.selectionStart ?? 0) === 0;
    if (e.key === "ArrowUp" && h.list.length && (text === "" || h.i >= 0) && caretAtStart) {
      e.preventDefault();
      if (h.i < 0) h.draft = text;
      h.i = h.i < 0 ? h.list.length - 1 : Math.max(0, h.i - 1);
      setText(h.list[h.i]!);
      return;
    }
    if (e.key === "ArrowDown" && h.i >= 0) {
      e.preventDefault();
      h.i++;
      if (h.i >= h.list.length) {
        h.i = -1;
        setText(h.draft);
      } else setText(h.list[h.i]!);
    }
  };

  const isPlannedRun = mode === "build" && plannedGoal && text.trim() === plannedGoal;

  return (
    <div className="relative px-4 pb-4 pt-2">
      {menu && menuValues.length > 0 && (
        <div className="absolute inset-x-4 bottom-full z-20 mb-1 animate-in fade-in slide-in-from-bottom-1 duration-100">
          <div className="glass overflow-hidden rounded-xl border">
          <Command value={sel} onValueChange={setSel} shouldFilter={false} className="bg-transparent">
            <CommandList className="max-h-72">
              <CommandGroup heading={menu.kind === "slash" ? "Commands" : files === null ? "Loading files…" : "Files"}>
                {menu.kind === "slash"
                  ? slashItems.map((c) => (
                      <CommandItem key={c.name} value={`/${c.name}`} onSelect={pick} onMouseDown={(e) => e.preventDefault()}>
                        <Slash className="text-muted-foreground" />
                        <span className="font-mono text-[13px]">{c.name}</span>
                        <span className="ml-3 truncate text-xs text-muted-foreground">{c.description}</span>
                      </CommandItem>
                    ))
                  : mentionItems.map((f) => (
                      <CommandItem key={f} value={f} onSelect={pick} onMouseDown={(e) => e.preventDefault()}>
                        <AtSign className="text-muted-foreground" />
                        <span className="truncate font-mono text-[12.5px]">
                          <span className="text-muted-foreground">{f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : ""}</span>
                          {f.split("/").pop()}
                        </span>
                      </CommandItem>
                    ))}
              </CommandGroup>
            </CommandList>
          </Command>
          </div>
        </div>
      )}

      <div className={cn("rounded-2xl border bg-card shadow-float transition-[box-shadow,border-color] focus-within:shadow-overlay", mode === "plan" ? "focus-within:border-plan/60" : "focus-within:border-primary/50", active && "border-primary/25")}>
        <Textarea
          ref={ta}
          data-perf="composer"
          autoFocus
          value={text}
          rows={1}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            hist.current.i = -1;
            updateMenu(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKey}
          onBlur={() => setTimeout(() => setMenu(null), 120)}
          className="max-h-60 min-h-[52px] resize-none border-0 bg-transparent px-4 pb-1 pt-3.5 text-[14px] leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent [field-sizing:content]"
        />
        <div className="flex h-11 items-center gap-1.5 px-2.5">
          {toolbar}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {text.startsWith("!") && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Terminal className="size-3" /> shell
              </span>
            )}
            {isPlannedRun && <span className="text-[11px] text-plan">runs the plan above</span>}
            <span className="hidden text-[11px] text-muted-foreground xl:inline">
              <Kbd>⏎</Kbd> send <Kbd>⇧⏎</Kbd> newline
            </span>
            {stop}
            <Button size="icon-sm" className={cn("rounded-full", mode === "plan" && "bg-plan text-background hover:bg-plan/90")} disabled={!text.trim() || busy} onClick={() => void submit()} aria-label="Send">
              <ArrowUp />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
});
