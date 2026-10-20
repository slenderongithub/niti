import type {
  AgentConfig,
  Checkpoint,
  CommandInfo,
  CommandResult,
  Credential,
  FileGraph,
  Providers,
  SessionInfo,
  SessionRow,
  Stats,
  WorktreeStatus,
  CatalogQuery,
  CatalogResult,
  ModelDetail,
  InstalledModel,
  DownloadProgress,
  LocalDevice,
} from "./types";

// A typed client for every niti-core route the app uses (src/server/server.ts). Errors come back
// as a JSON {error} body with status >= 400; they surface as ApiError with that message.

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class Api {
  constructor(
    readonly url: string,
    readonly token: string,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(this.url + path, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
      const text = await res.text();
      let data: unknown = undefined;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = undefined;
      }
      if (!res.ok) {
        const msg = (data as { error?: string } | undefined)?.error ?? (text || `HTTP ${res.status}`);
        throw new ApiError(msg, res.status);
      }
      return data as T;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if ((err as Error).name === "AbortError") throw new ApiError(`${method} ${path} timed out`, 0);
      throw new ApiError(`cannot reach niti-core (${(err as Error).message})`, 0);
    } finally {
      clearTimeout(t);
    }
  }

  private get<T>(path: string) {
    return this.req<T>("GET", path);
  }
  private post<T>(path: string, body: unknown = {}) {
    return this.req<T>("POST", path, body);
  }

  eventsUrl(from: number): string {
    return `${this.url}/events?from=${from}&token=${encodeURIComponent(this.token)}`;
  }

  session = () => this.post<SessionInfo>("/session");
  prompt = (text: string, mode: "build" | "plan") => this.post<{ accepted: boolean }>("/prompt", { text, mode });
  cancel = () => this.post<{ ok: boolean }>("/cancel");
  messageAgent = (id: string, text: string) => this.post<{ ok: boolean }>(`/agents/${encodeURIComponent(id)}/message`, { text });
  interruptAgent = (id: string, text: string) => this.post<{ ok: boolean }>(`/agents/${encodeURIComponent(id)}/interrupt`, { text });
  commands = () => this.get<{ commands: CommandInfo[] }>("/commands");
  runCommand = (name: string, args = "") => this.req<CommandResult>("POST", `/commands/${encodeURIComponent(name)}`, { args }, 120_000);
  graph = () => this.get<FileGraph>("/graph");
  stats = () => this.get<Stats>("/stats");
  checkpoints = (limit = 30) => this.get<{ checkpoints: Checkpoint[] }>(`/checkpoints?limit=${limit}`);
  sessions = () => this.get<{ sessions: SessionRow[] }>("/sessions");
  agents = () => this.get<{ agents: AgentConfig[] }>("/agents");
  saveAgents = (agents: AgentConfig[]) => this.post<{ ok: boolean; note: string }>("/agents", { agents });
  setTheme = (theme: string) => this.post<{ ok: boolean }>("/theme", { theme });
  setAuto = (auto: boolean) => this.post<{ ok: boolean; auto: boolean }>("/auto", { auto });
  setSettings = (patch: Record<string, boolean>) => this.post<Record<string, boolean>>("/settings", patch);
  providers = () => this.get<{ providers: Providers }>("/providers");
  models = (provider: string) => this.get<{ provider: string; models: string[] }>(`/models?provider=${encodeURIComponent(provider)}`);
  switchModel = (agentId: string, provider: string, model: string, baseURL?: string) =>
    this.post<{ ok: boolean }>("/model", { agentId, provider, model, ...(baseURL ? { baseURL } : {}) });
  reassign = (taskId: string, agentId: string) => this.post<{ ok: boolean }>("/reassign", { taskId, agentId });
  credentials = () => this.get<{ credentials: Credential[] }>("/auth");
  saveCredential = (cred: { provider: string; type: "api" | "local"; key?: string; baseURL?: string }) =>
    this.post<{ ok: boolean; note: string; agents: string[] }>("/auth", cred);
  removeCredential = (provider: string) => this.req<{ ok: boolean }>("DELETE", `/auth?provider=${encodeURIComponent(provider)}`);
  worktree = () => this.get<WorktreeStatus>("/worktree");
  mergeWorktree = (files?: string[]) => this.post<{ ok: boolean; message: string }>("/worktree/merge", files ? { files } : {});
  discardWorktree = () => this.post<{ ok: boolean; message: string }>("/worktree/discard");
  files = () => this.get<{ files: string[]; truncated: boolean }>("/files");
  file = (path: string) => this.get<{ path: string; content: string }>(`/file?path=${encodeURIComponent(path)}`);
  // Local models (src/local/routes.ts). The catalogue can take a while on a slow network.
  localDevice = () => this.get<LocalDevice>("/local/device");
  catalog = (q: CatalogQuery) => {
    const p = new URLSearchParams({ tab: q.tab });
    if (q.q) p.set("q", q.q);
    if (q.sort) p.set("sort", q.sort);
    if (q.tools) p.set("tools", "1");
    if (q.fits) p.set("fits", "1");
    if (q.size) p.set("size", q.size);
    return this.req<CatalogResult>("GET", `/local/catalog?${p}`, undefined, 45_000);
  };
  modelDetail = (repo: string) => this.req<ModelDetail>("GET", `/local/catalog/model?repo=${encodeURIComponent(repo)}`, undefined, 45_000);
  installedModels = () => this.get<{ models: InstalledModel[]; downloads: DownloadProgress[] }>("/local/models");
  download = (repo: string, quant: string) => this.req<{ download: DownloadProgress }>("POST", "/local/download", { repo, quant }, 45_000);
  cancelDownload = (id: string) => this.post<{ ok: boolean }>("/local/download/cancel", { id });
  deleteModel = (id: string) => this.req<{ ok: boolean }>("DELETE", `/local/models?id=${encodeURIComponent(id)}`);
  unloadModel = (model: string) => this.post<{ ok: boolean }>("/local/unload", { model });
  // Web search (Tavily). Saving tests the key with one search first.
  webSearch = () => this.get<{ configured: boolean; saved: boolean }>("/websearch");
  saveWebSearchKey = (key: string) => this.req<{ ok: boolean; configured: boolean }>("POST", "/websearch", { key }, 45_000);
  removeWebSearchKey = () => this.req<{ ok: boolean; configured: boolean }>("DELETE", "/websearch");
  approve = (ok: boolean, scope?: "agent" | "path", edited?: Record<string, unknown>, id?: number) =>
    this.post<{ ok: boolean }>("/approval", { ok, ...(scope ? { scope } : {}), ...(edited ? { edited } : {}), ...(id !== undefined ? { id } : {}) });
}
