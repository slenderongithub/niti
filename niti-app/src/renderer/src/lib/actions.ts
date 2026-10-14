import { toast } from "sonner";
import { useApp } from "@/store/app";
import { useOutput } from "@/store/output";
import { useUI, type Page } from "@/store/ui";
import { ApiError } from "./api";
import { steerTarget, workingAgents } from "./reducer";
import { goalLive } from "./types";

// Everything the composer, the palette and the menus can ask the core to do, in one place.

function api() {
  const a = useApp.getState().api;
  if (!a) throw new Error("niti-core isn't connected");
  return a;
}

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Slash commands the app answers itself (the TUI's local set, session.go:725-829) — the rest go to
// the core's registry. Each returns true when it handled the command.
const LOCAL: Record<string, (args: string) => void | Promise<void>> = {
  quit: () => void useApp.getState().closeProject(),
  exit: () => void useApp.getState().closeProject(),
  q: () => void useApp.getState().closeProject(),
  theme: (a) => {
    const t = a.trim().toLowerCase();
    if (t === "light" || t === "dark" || t === "system") useUI.getState().setTheme(t);
    else useUI.getState().setTheme(useUI.getState().resolvedDark ? "light" : "dark");
  },
  settings: () => useUI.getState().go("settings"),
  config: () => useUI.getState().go("settings"),
  status: () => useUI.getState().go("settings"),
  usage: () => useUI.getState().go("tokens"),
  stats: () => useUI.getState().go("tokens"),
  tokens: () => useUI.getState().go("tokens"),
  tasks: () => useUI.getState().go("tasks"),
  graph: () => useUI.getState().go("graph"),
  dashboard: () => useUI.getState().go("dashboard"),
  api: () => {
    useUI.getState().go("settings");
    location.hash = "providers";
  },
  agents: () => {
    useUI.getState().go("settings");
    location.hash = "team";
  },
  help: () => showHelp(),
  transcript: (a) => {
    const id = a.trim();
    const s = useApp.getState().session;
    useUI.getState().go("session");
    useUI.getState().focusAgent(id && s.agents[id] ? id : null);
  },
};

export const LOCAL_COMMANDS: { name: string; description: string }[] = [
  { name: "tasks", description: "open the task board" },
  { name: "tokens", description: "token usage and cost" },
  { name: "graph", description: "the project's dependency graph" },
  { name: "dashboard", description: "mission control for the whole team" },
  { name: "settings", description: "settings, team and providers" },
  { name: "model", description: "switch an agent's model" },
  { name: "api", description: "add or change a provider key" },
  { name: "theme", description: "light, dark or system" },
  { name: "transcript", description: "focus one agent's transcript" },
  { name: "help", description: "commands and shortcuts" },
  { name: "quit", description: "close this project" },
];

export function showHelp() {
  const cmds = useApp.getState().commands;
  const lines = [
    "Commands",
    "",
    ...LOCAL_COMMANDS.map((c) => `  /${c.name.padEnd(14)} ${c.description}`),
    ...cmds.filter((c) => !LOCAL[c.name] && c.name !== "model").map((c) => `  /${c.name.padEnd(14)} ${c.description}`),
    "",
    "Prefixes",
    "",
    "  /command       run a command",
    "  @path          mention a file",
    "  !cmd           run a shell command in the project",
    "",
    "Press ⌘/ for keyboard shortcuts.",
  ];
  useOutput.getState().show("Help", lines.join("\n"));
}

// Returns false when nothing ran (an unknown command), so the composer keeps the text.
export async function runSlash(text: string): Promise<boolean> {
  const body = text.trim().slice(1);
  const sp = body.search(/\s/);
  const name = (sp < 0 ? body : body.slice(0, sp)).toLowerCase();
  const args = sp < 0 ? "" : body.slice(sp + 1).trim();
  if (name === "model" && !args) {
    useUI.getState().setModelPicker(true);
    return true;
  }
  const local = LOCAL[name];
  if (local) {
    await local(args);
    return true;
  }
  const known = useApp.getState().commands;
  if (known.length && !known.some((c) => c.name === name)) {
    toast.error(`Unknown command /${name}`, { description: "Type / to see what's available." });
    return false;
  }
  try {
    const r = await api().runCommand(name, args);
    if (r.view) {
      const page = ({ usage: "tokens", stats: "tokens", tasks: "tasks", graph: "graph" } as Record<string, Page>)[r.view];
      if (page) useUI.getState().go(page);
    }
    const msg = (r.message ?? r.error ?? "").trimEnd();
    if (!msg) {
      if (!r.view) toast.success(`/${name} done`);
    } else if (!msg.includes("\n") && msg.length < 140) {
      (r.ok ? toast.success : toast.error)(msg);
    } else {
      useOutput.getState().show(`/${name}${args ? ` ${args}` : ""}`, msg);
    }
    if (["model", "auto", "manual", "clear", "resume"].includes(name)) void useApp.getState().refreshSession();
    return true;
  } catch (e) {
    toast.error(`/${name} failed`, { description: err(e) });
    return false;
  }
}

async function runShell(cmd: string): Promise<void> {
  const t = toast.loading(`$ ${cmd}`);
  try {
    const r = await window.niti.runShell(cmd);
    toast.dismiss(t);
    useOutput.getState().show(`$ ${cmd}${r.code ? `  (exit ${r.code})` : ""}`, r.output || "(no output)");
  } catch (e) {
    toast.error(err(e), { id: t });
  }
}

export type Target = "team" | "auto" | "broadcast" | string; // string = an agent id

// The composer's send: a new goal goes to the team (the lead plans across everyone); during a run
// text steers one agent, or every working agent at once with Broadcast.
export const isSlashCommand = (t: string) => /^\/[^\s/]*(\s|$)/.test(t);

// `interrupt`: for one agent, abandon what it is doing now and carry on from this message, instead
// of waiting for its next step (the TUI's x in the Agents panel).
export async function send(text: string, target: Target, interrupt = false): Promise<boolean> {
  const t = text.trim();
  if (!t) return false;
  // A command name never contains "/": "/Users/me/app.ts is broken" is a prompt, not a command.
  if (isSlashCommand(t)) return runSlash(t);
  if (t.startsWith("!")) {
    await runShell(t.slice(1).trim());
    return true;
  }
  const { session, mode } = useApp.getState();
  try {
    // While a goal is live, text is a note to it: sent now to whoever is working and carried into
    // its next round. Between rounds no run is active, and a plain prompt would be refused. Picking
    // one agent mid-round still steers just that agent.
    const oneAgent = target !== "team" && target !== "auto" && target !== "broadcast";
    if (goalLive(session.goalStatus) && !(oneAgent && session.active)) {
      const r = await api().runCommand("goal", `note ${t}`);
      if (!r.ok) throw new Error(r.message);
      toast.success("Note for the goal", { description: r.message });
      return true;
    }
    if (session.active && interrupt && target !== "team" && target !== "broadcast") {
      const id = target === "auto" ? steerTarget(session, useUI.getState().focusedAgent ?? undefined) : target;
      if (!id) throw new Error("no agent is working right now");
      await api().interruptAgent(id, t);
      toast.success(`Interrupted ${session.agents[id]?.cfg.role ?? id}`, { description: "It stops what it's doing and carries on from your message." });
      return true;
    }
    if (session.active && target !== "team") {
      const ids = target === "broadcast" ? workingAgents(session) : [target === "auto" ? steerTarget(session, useUI.getState().focusedAgent ?? undefined) : target];
      const live = ids.filter((x): x is string => Boolean(x));
      if (!live.length) throw new Error("no agent is working right now");
      const results = await Promise.allSettled(live.map((id) => api().messageAgent(id, t)));
      const ok = live.filter((_, i) => results[i]!.status === "fulfilled");
      if (!ok.length) throw new Error((results[0] as PromiseRejectedResult).reason?.message ?? "not delivered");
      const names = ok.map((id) => session.agents[id]?.cfg.role ?? id).join(", ");
      toast.success(`→ ${names}`, { description: "They'll read it at their next step." });
      return true;
    }
    if (session.active) throw new Error("a run is in progress — steer an agent, or stop the run first");
    await api().prompt(t, mode);
    if (mode === "plan") useApp.setState((s) => ({ session: { ...s.session, plannedGoal: t } }));
    return true;
  } catch (e) {
    toast.error(err(e));
    return false;
  }
}

export async function interrupt() {
  try {
    await api().cancel();
    toast("Stopping after the current step…");
  } catch (e) {
    toast.error(err(e));
  }
}

// `id` names the request on screen, so an answer can't land on a different one that reached the
// front in the meantime. A 409 means another client (the TUI, the web dashboard) answered it first.
export async function answerApproval(ok: boolean, scope?: "agent" | "path", edited?: Record<string, unknown>, id?: number) {
  try {
    await api().approve(ok, scope, edited, id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) toast("That request was already settled");
    else toast.error(err(e));
  }
}

// Approve all approves exactly the requests on screen — never ones that arrived after the click, and
// never a dangerous one (rm -rf, network, outside the project, a credential), which the core asks
// about precisely so that it is decided on its own.
export async function approveAll() {
  for (const r of useApp.getState().session.approvals.filter((a) => !a.dangerous)) await answerApproval(true, undefined, undefined, r.id);
}

export async function switchModel(agentId: string, providerModel: string) {
  const i = providerModel.indexOf("/");
  const provider = i > 0 ? providerModel.slice(0, i) : "";
  const model = i > 0 ? providerModel.slice(i + 1) : providerModel;
  try {
    await api().switchModel(agentId, provider, model);
    toast.success(`${useApp.getState().session.agents[agentId]?.cfg.role ?? agentId} → ${providerModel}`);
    await useApp.getState().refreshSession();
    return true;
  } catch (e) {
    toast.error(err(e));
    return false;
  }
}
