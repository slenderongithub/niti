import { create } from "zustand";
import { toast } from "sonner";
import type { AppInfo, CoreExit, TrustStatus } from "../../../shared/bridge";
import { Api } from "@/lib/api";
import { openStream, type Stream } from "@/lib/sse";
import { applyEvents, emptyState, fromSession, type SessionState } from "@/lib/reducer";
import type { CommandInfo, Prefs, ServerEvent, SessionInfo } from "@/lib/types";
import { ask } from "./confirm";
import { useEditor } from "./editor";
import { useUI } from "./ui";

// One window's journey: launch → trust → starting → team setup → session. The renderer drives it;
// main only runs the processes. `session` is the reducer's output, replaced on every event batch.

export type Phase = "launch" | "trust" | "starting" | "setup" | "restarting" | "session" | "error";

interface AppState {
  info: AppInfo | null;
  phase: Phase;
  root: string | null;
  trust: TrustStatus | null;
  error: string | null;
  api: Api | null;
  sessionInfo: SessionInfo | null;
  session: SessionState;
  commands: CommandInfo[];
  coreExit: CoreExit | null;
  mode: "build" | "plan";
  harnessKeepsTeam: boolean;
  init(): Promise<void>;
  openProject(root: string): Promise<void>;
  grantTrust(remember: boolean): Promise<void>;
  finishSetup(changed: boolean): Promise<void>;
  closeProject(): Promise<void>;
  restartCore(): Promise<void>;
  refreshSession(): Promise<void>;
  setMode(m: "build" | "plan"): void;
  setPrefs(patch: Partial<Prefs>): void;
  setAutoLocal(auto: boolean): void;
}

let stream: Stream | null = null;
let unsubExit: (() => void) | null = null;

function closeStream() {
  stream?.close();
  stream = null;
}

export const useApp = create<AppState>((set, get) => {
  const fail = (err: unknown) => set({ phase: "error", error: err instanceof Error ? err.message : String(err) });

  async function boot(): Promise<void> {
    const root = get().root!;
    set({ phase: "starting", error: null, coreExit: null });
    const hs = await window.niti.startCore(root);
    const api = new Api(hs.url, hs.token);
    const info = await api.session();
    set({ api, sessionInfo: info, session: fromSession(info) });
    void api.commands().then((r) => set({ commands: r.commands })).catch(() => {});
    set({ phase: "setup" });
  }

  function connect(api: Api, info: SessionInfo) {
    closeStream();
    set({ session: fromSession(info), sessionInfo: info, phase: "session" });
    applyServerPrefs(info);
    // Replay from 0: a core that was already running (a restart, a reconnect) still holds the run
    // in its ring buffer, and the transcript rebuilds from it.
    stream = openStream({
      url: (from) => api.eventsUrl(from),
      from: 0,
      onEvents: (events: ServerEvent[]) => {
        set((s) => ({ session: applyEvents(s.session, events) }));
      },
    });
    void window.niti.noteTeam(info.root, info.agents.map((a) => ({ role: a.role, model: `${a.provider}/${a.model}`, lead: a.lead })));
  }

  return {
    info: null,
    phase: "launch",
    root: null,
    trust: null,
    error: null,
    api: null,
    sessionInfo: null,
    session: emptyState(),
    commands: [],
    coreExit: null,
    mode: "build",
    harnessKeepsTeam: true,

    async init() {
      const info = await window.niti.appInfo();
      set({ info });
      unsubExit?.();
      unsubExit = window.niti.onCoreExit((e) => {
        closeStream();
        set({ coreExit: e });
      });
      const root = new URLSearchParams(location.search).get("root");
      if (root) void get().openProject(root);
    },

    async openProject(root) {
      if (get().root && get().phase !== "launch" && get().phase !== "error") {
        // This window already has a project: open the new one beside it.
        await window.niti.newWindow(root);
        return;
      }
      set({ root, error: null, trust: null, phase: "starting" });
      try {
        const trust = await window.niti.trustCheck(root);
        if (trust.trusted) await boot();
        else if (get().info?.smoke) {
          set({ trust });
          await get().grantTrust(false);
        } else set({ trust, phase: "trust" });
      } catch (err) {
        fail(err);
      }
    },

    async grantTrust(remember) {
      try {
        if (remember) await window.niti.trustGrant(get().root!);
        await boot();
      } catch (err) {
        fail(err);
      }
    },

    async finishSetup(changed) {
      try {
        let api = get().api!;
        if (changed) {
          // agents.yaml is read only at boot: a new team means a new core.
          set({ phase: "restarting" });
          closeStream();
          const hs = await window.niti.restartCore();
          api = new Api(hs.url, hs.token);
          set({ api });
          void api.commands().then((r) => set({ commands: r.commands })).catch(() => {});
        }
        const info = await api.session();
        connect(api, info);
      } catch (err) {
        fail(err);
      }
    },

    async closeProject() {
      const dirty = useEditor.getState().anyDirty().length;
      const running = get().session.active;
      if (dirty || running) {
        const lose = [running && "stop the running goal", dirty && `discard ${dirty} unsaved file${dirty === 1 ? "" : "s"}`].filter(Boolean).join(" and ");
        if ((await ask({ title: "Close this project?", description: `This will ${lose}.`, confirm: "Close project", destructive: true })) !== "confirm") return;
      }
      closeStream();
      await window.niti.stopCore();
      useUI.getState().go("session");
      useUI.getState().focusAgent(null);
      useUI.setState({ openFiles: [], activeFile: null });
      useEditor.getState().reset();
      set({ phase: "launch", root: null, api: null, sessionInfo: null, session: emptyState(), trust: null, error: null, coreExit: null, commands: [], mode: "build" });
    },

    async restartCore() {
      try {
        closeStream();
        set({ coreExit: null, phase: "restarting" });
        const hs = await window.niti.restartCore().catch(() => window.niti.startCore(get().root!));
        const api = new Api(hs.url, hs.token);
        set({ api });
        void api.commands().then((r) => set({ commands: r.commands })).catch(() => {});
        connect(api, await api.session());
      } catch (err) {
        fail(err);
      }
    },

    async refreshSession() {
      const api = get().api;
      if (!api) return;
      try {
        const info = await api.session();
        set((s) => ({ sessionInfo: info, session: fromSession(info, s.session) }));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },

    setMode: (mode) => set({ mode }),
    setPrefs(patch) {
      const info = get().sessionInfo;
      if (info) set({ sessionInfo: { ...info, prefs: { ...info.prefs, ...patch } } });
      if (patch.reduceMotion !== undefined) useUI.getState().setReduceMotion(patch.reduceMotion);
    },
    setAutoLocal(auto) {
      const info = get().sessionInfo;
      if (info) set({ sessionInfo: { ...info, auto } });
    },
  };
});

function applyServerPrefs(info: SessionInfo) {
  useUI.getState().setReduceMotion(Boolean(info.prefs?.reduceMotion));
}
