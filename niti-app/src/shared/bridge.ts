// The contract between the main process and the renderer: what `window.niti` exposes. Main owns
// everything privileged (processes, the filesystem outside the core, native UI); the renderer talks
// to niti-core directly over HTTP/SSE with the url + token this bridge hands it.

export interface ServerInfo {
  url: string;
  token: string;
}

export interface TrustStatus {
  trusted: boolean;
  root: string;
  changed: boolean; // trusted before, but the mcpServers block changed since
}

export interface RecentProject {
  root: string;
  name: string;
  lastOpened: number;
  team?: { role: string; model: string; lead?: boolean }[];
}

export interface AppInfo {
  version: string;
  platform: string;
  packaged: boolean;
  core: string; // how niti-core will be launched, for the About page
  smoke: boolean; // a harness run: auto-continue setup and report
  harness: "smoke" | "perf" | "audit" | null;
  home: string;
}

export interface CoreExit {
  code: number | null;
  logTail: string;
}

interface ShellResult {
  code: number;
  output: string;
}

// Menu items and shortcuts the main process forwards to the focused window.
export type MenuCommand =
  | "open-folder"
  | "palette"
  | "settings"
  | "page:session"
  | "page:tasks"
  | "page:tokens"
  | "page:graph"
  | "page:dashboard"
  | "page:settings"
  | "toggle-sidebar"
  | "focus-mode"
  | "shortcuts"
  | "close-project";

export type ThemeSource = "light" | "dark" | "system";

export interface NitiBridge {
  appInfo(): Promise<AppInfo>;
  // Projects
  pickFolder(): Promise<string | null>;
  recent(): Promise<RecentProject[]>;
  forgetRecent(root: string): Promise<void>;
  noteTeam(root: string, team: RecentProject["team"]): Promise<void>;
  // Trust + core lifecycle for this window's project
  trustCheck(root: string): Promise<TrustStatus>;
  trustGrant(root: string): Promise<void>;
  startCore(root: string): Promise<ServerInfo>;
  restartCore(): Promise<ServerInfo>;
  stopCore(): Promise<void>;
  coreLog(): Promise<string>;
  onCoreExit(cb: (e: CoreExit) => void): () => void;
  // OS
  runShell(cmd: string): Promise<ShellResult>;
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
  reveal(path: string): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  setBadge(count: number): Promise<void>;
  setTheme(source: ThemeSource): Promise<boolean>; // returns whether dark is in effect
  onSystemTheme(cb: (dark: boolean) => void): () => void;
  newWindow(root?: string): Promise<void>;
  onMenu(cb: (cmd: MenuCommand) => void): () => void;
  onOpenProject(cb: (root: string) => void): () => void;
  smokeReady(report: { ok: boolean; detail: string }): Promise<void>;
  perfInput(events: ({ type: "click"; x: number; y: number; gapMs?: number } | { type: "key"; key: string; modifiers?: string[]; gapMs?: number })[]): Promise<void>;
  perfCpu(ms: number): Promise<{ renderer: number; gpu: number }>;
  perfReport(report: { ok: boolean; text: string }): Promise<void>;
  auditResize(w: number, h: number): Promise<void>;
  pathForFile(file: File): string;
  readFile(rel: string): Promise<{ content: string; mtimeMs: number }>;
  writeFile(rel: string, content: string, expectedMtime?: number): Promise<{ ok: true; mtimeMs: number } | { ok: false; conflict: true; mtimeMs: number }>;
}
