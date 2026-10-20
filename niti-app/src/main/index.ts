import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, shell, type MenuItemConstructorOptions, type WebContents } from "electron";
import { exec } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { MenuCommand, RecentProject, ThemeSource } from "../shared/bridge";
import { Core, coreLabel, trustCheck, trustGrant } from "./core";
import { userEnv } from "./env";
import { readProjectFile, writeProjectFile } from "./fsjail";

// One window = one project = one niti-core. The renderer drives the flow (pick → trust → core →
// team → session); this process owns the child processes, native UI and small persisted state.

// Harness modes. Smoke: open a project, exercise it, report, exit. Perf: the same, shown, with real
// input injected and renderer CPU sampled. Audit: the same, checking layout geometry.
const PERF = process.env.NITI_APP_PERF;
const AUDIT = process.env.NITI_APP_AUDIT;
const SMOKE = process.env.NITI_APP_SMOKE || PERF || AUDIT;
const isMac = process.platform === "darwin";

type PerfInput = { type: "click"; x: number; y: number; gapMs?: number } | { type: "key"; key: string; modifiers?: string[]; gapMs?: number };

interface WindowCtx {
  win: BrowserWindow;
  core?: Core;
}
const windows = new Map<number, WindowCtx>(); // keyed by webContents id
const stopping = new Set<Promise<void>>(); // cores of closed windows, still shutting down

// --- tiny persisted state in userData -------------------------------------------------------
function stateFile(name: string) {
  return join(app.getPath("userData"), name);
}
function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(stateFile(name), "utf8")) as T;
  } catch {
    return fallback;
  }
}
function writeJson(name: string, value: unknown) {
  try {
    writeFileSync(stateFile(name), JSON.stringify(value, null, 2));
  } catch {
    /* userData unwritable: lose the convenience, keep working */
  }
}

function recents(): RecentProject[] {
  return readJson<RecentProject[]>("recent.json", []).filter((r) => existsSync(r.root));
}
function noteRecent(root: string, patch: Partial<RecentProject> = {}) {
  const list = readJson<RecentProject[]>("recent.json", []);
  const prev = list.find((r) => r.root === root);
  const next: RecentProject = { root, name: basename(root), lastOpened: Date.now(), ...prev, ...patch };
  if (!patch.team) next.lastOpened = Date.now();
  writeJson("recent.json", [next, ...list.filter((r) => r.root !== root)].slice(0, 12));
  if (!patch.team) app.addRecentDocument(root);
}

// --- windows -------------------------------------------------------------------------------
function themeBg(): string {
  const dark = nativeTheme.shouldUseDarkColors;
  return dark ? "#0a0a0a" : "#f3f3f3";
}

function createWindow(root?: string): BrowserWindow {
  const bounds = readJson<{ width?: number; height?: number; x?: number; y?: number }>("window.json", {});
  const offset = BrowserWindow.getAllWindows().length * 28;
  const win = new BrowserWindow({
    width: bounds.width ?? 1440,
    height: bounds.height ?? 920,
    x: bounds.x !== undefined ? bounds.x + offset : undefined,
    y: bounds.y !== undefined ? bounds.y + offset : undefined,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: "niti",
    backgroundColor: themeBg(),
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 16, y: 16 },
    titleBarOverlay: isMac ? undefined : { color: "#00000000", symbolColor: "#8a909c", height: 44 },
    icon: join(__dirname, "../../build/icon.png"),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      // A harness window must render like a frontmost one, or rAF throttling skews every number.
      backgroundThrottling: !(PERF || AUDIT),
    },
  });
  const ctx: WindowCtx = { win };
  const id = win.webContents.id;
  windows.set(id, ctx);

  win.once("ready-to-show", () => {
    if (!SMOKE) win.show();
    else if (PERF || AUDIT) {
      win.show();
      app.focus({ steal: true });
      win.focus();
    }
  });
  const saveBounds = () => {
    if (!win.isMinimized() && !win.isFullScreen()) writeJson("window.json", win.getNormalBounds());
  };
  win.on("resize", saveBounds);
  win.on("move", saveBounds);
  // The renderer blocks unload while a file has unsaved edits; ask before throwing them away.
  win.webContents.on("will-prevent-unload", (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["Discard changes", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "Close this window?",
      detail: "Unsaved edits will be lost and any running goal will be stopped.",
    });
    if (choice === 0) e.preventDefault();
  });
  win.on("closed", () => {
    if (ctx.core) {
      const p = ctx.core.stop();
      stopping.add(p);
      void p.finally(() => stopping.delete(p));
    }
    windows.delete(id);
    updateBadge();
  });
  // Links in agent output open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file:") && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? "\0")) {
      e.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });
  if (SMOKE) watchSmoke(win.webContents);

  const query = root ? { root } : undefined;
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    if (root) url.searchParams.set("root", root);
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"), query ? { query } : undefined);
  }
  return win;
}

function ctxOf(sender: WebContents): WindowCtx {
  const ctx = windows.get(sender.id);
  if (!ctx) throw new Error("no window for this request");
  return ctx;
}

function send(cmd: MenuCommand) {
  BrowserWindow.getFocusedWindow()?.webContents.send("menu", cmd);
}

const badges = new Map<number, number>();
function updateBadge() {
  let total = 0;
  for (const [id, n] of badges) if (windows.has(id)) total += n;
  if (isMac) app.dock?.setBadge(total ? String(total) : "");
  else app.setBadgeCount(total);
}

// --- smoke mode: launch, connect, render, report, exit ----------------------------------------
const smokeErrors: string[] = [];
function watchSmoke(wc: WebContents) {
  wc.on("console-message", (...args: unknown[]) => {
    const e = args[0] as { level?: string | number; message?: string };
    const level = typeof e?.level === "string" ? e.level : (args[1] as number);
    const message = e?.message ?? String(args[2] ?? "");
    if (level === "error" || level === 3) smokeErrors.push(message);
    if (AUDIT && message.startsWith("[audit]")) console.log(message); // progress, so a hang shows where
  });
  wc.on("render-process-gone", (_e, d) => {
    console.error(`smoke: renderer gone (${d.reason})`);
    app.exit(2);
  });
  setTimeout(() => {
    console.error("smoke: timed out waiting for the app to become ready");
    if (smokeErrors.length) console.error(smokeErrors.join("\n"));
    app.exit(3);
  }, AUDIT ? 420_000 : PERF ? 240_000 : 90_000).unref();
}

// --- IPC -----------------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle("app:info", async () => ({
    version: app.getVersion(),
    platform: process.platform,
    packaged: app.isPackaged,
    core: await coreLabel(),
    smoke: Boolean(SMOKE),
    harness: PERF ? "perf" : AUDIT ? "audit" : SMOKE ? "smoke" : null,
    home: app.getPath("home"),
  }));

  ipcMain.handle("project:pick", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const r = await dialog.showOpenDialog(win!, { title: "Open a project folder", properties: ["openDirectory", "createDirectory"], buttonLabel: "Open" });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle("project:recent", () => recents());
  ipcMain.handle("project:forget", (_e, root: string) => writeJson("recent.json", readJson<RecentProject[]>("recent.json", []).filter((r) => r.root !== root)));
  ipcMain.handle("project:team", (_e, root: string, team: RecentProject["team"]) => noteRecent(root, { team }));

  ipcMain.handle("trust:check", (_e, root: string) => trustCheck(root));
  ipcMain.handle("trust:grant", (_e, root: string) => trustGrant(root));

  ipcMain.handle("core:start", async (e, root: string) => {
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`not a folder: ${root}`);
    const ctx = ctxOf(e.sender);
    if (ctx.core && ctx.core.root !== root) {
      await ctx.core.stop();
      ctx.core = undefined;
    }
    if (!ctx.core) {
      const core = new Core(root);
      core.on("exit", (info) => {
        if (!ctx.win.isDestroyed()) ctx.win.webContents.send("core:exit", info);
      });
      ctx.core = core;
    }
    const info = await ctx.core.start();
    noteRecent(root);
    ctx.win.setTitle(`${basename(root)} — niti`);
    ctx.win.setRepresentedFilename?.(root);
    return info;
  });
  ipcMain.handle("core:restart", async (e) => {
    const ctx = ctxOf(e.sender);
    if (!ctx.core) throw new Error("no project is open");
    return ctx.core.restart();
  });
  ipcMain.handle("core:stop", async (e) => {
    const ctx = ctxOf(e.sender);
    await ctx.core?.stop();
    ctx.core = undefined;
    ctx.win.setTitle("niti");
    badges.delete(e.sender.id);
    updateBadge();
  });
  ipcMain.handle("core:log", (e) => ctxOf(e.sender).core?.logTail(200) ?? "");

  ipcMain.handle("os:shell", async (e, cmd: string) => {
    const root = ctxOf(e.sender).core?.root;
    if (!root) throw new Error("no project is open");
    const env = await userEnv();
    return new Promise((resolve) => {
      exec(cmd, { cwd: root, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, shell: process.env.SHELL || "/bin/sh" }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, output: `${stdout}${stderr}`.trimEnd() });
      });
    });
  });
  // The editor: read and write files inside this window's project, nowhere else (fsjail.ts).
  ipcMain.handle("fs:read", (e, rel: string) => {
    const root = ctxOf(e.sender).core?.root;
    if (!root) throw new Error("no project is open");
    return readProjectFile(root, rel);
  });
  ipcMain.handle("fs:write", (e, rel: string, content: string, expectedMtime?: number) => {
    const root = ctxOf(e.sender).core?.root;
    if (!root) throw new Error("no project is open");
    return writeProjectFile(root, rel, content, expectedMtime);
  });
  ipcMain.handle("os:openExternal", (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url);
  });
  ipcMain.handle("os:openPath", async (e, p: string) => {
    // Opening a script or app *runs* it, and agents write files: confirm anything runnable.
    const st = statSync(p, { throwIfNoEntry: false });
    const runnable = /\.(app|command|tool|sh|zsh|bash|scpt|applescript|workflow|terminal|pkg|mpkg|jar|exe|bat|cmd|ps1|vbs|msi)$/i.test(p) || Boolean(st?.isFile() && st.mode & 0o111);
    if (runnable) {
      const win = BrowserWindow.fromWebContents(e.sender);
      const opts = { type: "warning" as const, buttons: ["Open", "Cancel"], defaultId: 1, cancelId: 1, message: `Run ${basename(p)}?`, detail: "Opening this file runs it. Only continue if you trust what's in it." };
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      if (r.response !== 0) return;
    }
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  });
  ipcMain.handle("os:reveal", (_e, p: string) => shell.showItemInFolder(p));
  ipcMain.handle("os:notify", (e, title: string, body: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win?.isFocused() || !Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: false });
    n.on("click", () => {
      win?.show();
      win?.focus();
    });
    n.show();
  });
  ipcMain.handle("os:badge", (e, count: number) => {
    badges.set(e.sender.id, count);
    updateBadge();
  });
  ipcMain.handle("theme:set", (_e, source: ThemeSource) => {
    nativeTheme.themeSource = source;
    writeJson("theme.json", { source });
    for (const { win } of windows.values()) if (!win.isDestroyed()) win.setBackgroundColor(themeBg());
    return nativeTheme.shouldUseDarkColors;
  });
  ipcMain.handle("window:new", (_e, root?: string) => {
    createWindow(root);
  });
  // Perf: real input through Chromium's input pipeline (trusted events, so Event Timing sees them).
  ipcMain.handle("perf:input", async (e, events: PerfInput[]) => {
    if (!SMOKE) return;
    const wc = e.sender;
    for (const ev of events) {
      if (ev.type === "click") {
        wc.sendInputEvent({ type: "mouseMove", x: ev.x, y: ev.y });
        wc.sendInputEvent({ type: "mouseDown", x: ev.x, y: ev.y, button: "left", clickCount: 1 });
        wc.sendInputEvent({ type: "mouseUp", x: ev.x, y: ev.y, button: "left", clickCount: 1 });
      } else if (ev.type === "key") {
        const mods = (ev.modifiers ?? []) as ("meta" | "shift" | "control" | "alt")[];
        wc.sendInputEvent({ type: "keyDown", keyCode: ev.key, modifiers: mods });
        if (ev.key.length === 1 && !mods.includes("meta")) wc.sendInputEvent({ type: "char", keyCode: ev.key, modifiers: mods });
        wc.sendInputEvent({ type: "keyUp", keyCode: ev.key, modifiers: mods });
      }
      if (ev.gapMs) await new Promise((r) => setTimeout(r, ev.gapMs));
    }
  });
  // Perf: the renderer's (and GPU's) CPU over a window — what "idle" really costs.
  ipcMain.handle("perf:cpu", async (e, ms: number) => {
    const pid = e.sender.getOSProcessId();
    const sample = () => app.getAppMetrics();
    sample();
    await new Promise((r) => setTimeout(r, ms));
    const m = sample();
    return {
      renderer: m.find((x) => x.pid === pid)?.cpu.percentCPUUsage ?? -1,
      gpu: m.find((x) => x.type === "GPU")?.cpu.percentCPUUsage ?? -1,
    };
  });
  // Audit: resize the window's content area to a target size.
  ipcMain.handle("audit:resize", async (e, w: number, h: number) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!SMOKE || !win) return;
    win.setContentSize(w, h);
    await new Promise((r) => setTimeout(r, 250));
  });
  ipcMain.handle("perf:report", (_e, report: { ok: boolean; text: string }) => {
    console.log(report.text);
    console.log(`${AUDIT ? "audit" : "perf"}: ${report.ok ? "PASS" : "FAIL"}`);
    setTimeout(() => app.exit(report.ok ? 0 : 1), 50);
  });

  ipcMain.handle("smoke:ready", (_e, report: { ok: boolean; detail: string }) => {
    if (!SMOKE) return;
    const errs = smokeErrors.filter((m) => !/Download the React DevTools|Electron Security Warning/.test(m));
    const ok = report.ok && errs.length === 0;
    console.log(`smoke: ${ok ? "PASS" : "FAIL"} — ${report.detail}${errs.length ? `\nconsole errors:\n${errs.join("\n")}` : ""}`);
    setTimeout(() => app.exit(ok ? 0 : 1), 50);
  });
}

// --- menu ----------------------------------------------------------------------------------
function buildMenu() {
  const page = (label: string, key: string, cmd: MenuCommand): MenuItemConstructorOptions => ({ label, accelerator: `CmdOrCtrl+${key}`, click: () => send(cmd) });
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => send("page:settings") },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: () => send("open-folder") },
        { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() },
        { type: "separator" },
        { label: "Close Project", accelerator: "CmdOrCtrl+Shift+W", click: () => send("close-project") },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Command Palette…", accelerator: "CmdOrCtrl+K", click: () => send("palette") },
        { type: "separator" },
        page("Session", "1", "page:session"),
        page("Tasks", "2", "page:tasks"),
        page("Tokens", "3", "page:tokens"),
        page("Graph", "4", "page:graph"),
        page("Dashboard", "5", "page:dashboard"),
        page("Models", "6", "page:models"),
        page("Settings", "7", "page:settings"),
        { type: "separator" },
        { label: "Toggle Sidebar", accelerator: "CmdOrCtrl+B", click: () => send("toggle-sidebar") },
        { label: "Focus Mode", accelerator: "CmdOrCtrl+.", click: () => send("focus-mode") },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : ([{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }] as MenuItemConstructorOptions[])),
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Keyboard Shortcuts", accelerator: "CmdOrCtrl+/", click: () => send("shortcuts") },
        { label: "niti on GitHub", click: () => void shell.openExternal("https://github.com/slenderongithub/niti") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- lifecycle -----------------------------------------------------------------------------
const pendingOpen: string[] = [];
function openProject(root: string) {
  const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const ctx = focused ? windows.get(focused.webContents.id) : undefined;
  if (focused && ctx && !ctx.core) focused.webContents.send("project:open", root);
  else createWindow(root);
}

app.on("open-file", (e, path) => {
  e.preventDefault();
  if (!existsSync(path) || !statSync(path).isDirectory()) return;
  if (app.isReady()) openProject(path);
  else pendingOpen.push(path);
});

app.setName("niti");
if (SMOKE) app.setPath("userData", join(app.getPath("temp"), `niti-app-smoke-${process.pid}`));

app.whenReady().then(async () => {
  const saved = readJson<{ source?: ThemeSource }>("theme.json", {});
  nativeTheme.themeSource = saved.source ?? "system";
  nativeTheme.on("updated", () => {
    for (const { win } of windows.values()) {
      if (win.isDestroyed()) continue;
      win.setBackgroundColor(themeBg());
      win.webContents.send("theme:system", nativeTheme.shouldUseDarkColors);
    }
  });
  registerIpc();
  buildMenu();
  void userEnv(); // warm the login-shell environment while the window loads
  if (SMOKE) createWindow(SMOKE);
  else if (pendingOpen.length) pendingOpen.splice(0).forEach((p) => createWindow(p));
  else createWindow(process.env.NITI_PROJECT_ROOT);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (!isMac || SMOKE) app.quit();
});

// Every core goes down with the app — an orphaned core keeps agents running with nobody watching.
// Windows close first (each can still cancel the quit via its unload prompt), each stopping its own
// core; the quit waits here for those stops to finish.
app.on("will-quit", (e) => {
  if (!stopping.size) return;
  e.preventDefault();
  void Promise.allSettled([...stopping]).then(() => app.quit());
});
