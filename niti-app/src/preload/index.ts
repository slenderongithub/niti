import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type { CoreExit, MenuCommand, NitiBridge } from "../shared/bridge";

function listen<T>(channel: string, cb: (v: T) => void): () => void {
  const h = (_e: IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

const bridge: NitiBridge = {
  appInfo: () => ipcRenderer.invoke("app:info"),
  pickFolder: () => ipcRenderer.invoke("project:pick"),
  recent: () => ipcRenderer.invoke("project:recent"),
  forgetRecent: (root) => ipcRenderer.invoke("project:forget", root),
  noteTeam: (root, team) => ipcRenderer.invoke("project:team", root, team),
  trustCheck: (root) => ipcRenderer.invoke("trust:check", root),
  trustGrant: (root) => ipcRenderer.invoke("trust:grant", root),
  startCore: (root) => ipcRenderer.invoke("core:start", root),
  restartCore: () => ipcRenderer.invoke("core:restart"),
  stopCore: () => ipcRenderer.invoke("core:stop"),
  coreLog: () => ipcRenderer.invoke("core:log"),
  onCoreExit: (cb) => listen<CoreExit>("core:exit", cb),
  runShell: (cmd) => ipcRenderer.invoke("os:shell", cmd),
  openExternal: (url) => ipcRenderer.invoke("os:openExternal", url),
  openPath: (p) => ipcRenderer.invoke("os:openPath", p),
  reveal: (p) => ipcRenderer.invoke("os:reveal", p),
  notify: (title, body) => ipcRenderer.invoke("os:notify", title, body),
  setBadge: (n) => ipcRenderer.invoke("os:badge", n),
  setTheme: (source) => ipcRenderer.invoke("theme:set", source),
  onSystemTheme: (cb) => listen<boolean>("theme:system", cb),
  newWindow: (root) => ipcRenderer.invoke("window:new", root),
  onMenu: (cb) => listen<MenuCommand>("menu", cb),
  onOpenProject: (cb) => listen<string>("project:open", cb),
  smokeReady: (report) => ipcRenderer.invoke("smoke:ready", report),
  perfInput: (events) => ipcRenderer.invoke("perf:input", events),
  perfCpu: (ms) => ipcRenderer.invoke("perf:cpu", ms),
  perfReport: (report) => ipcRenderer.invoke("perf:report", report),
  auditResize: (w, h) => ipcRenderer.invoke("audit:resize", w, h),
  pathForFile: (file) => webUtils.getPathForFile(file),
  readFile: (rel) => ipcRenderer.invoke("fs:read", rel),
  writeFile: (rel, content, expectedMtime) => ipcRenderer.invoke("fs:write", rel, content, expectedMtime),
};

contextBridge.exposeInMainWorld("niti", bridge);
