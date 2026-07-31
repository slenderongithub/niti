import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// A minimal LSP client: JSON-RPC over the server's stdio, framed with Content-Length headers.
// Hand-rolled for the same reason src/mcp/mcp.ts manages its own subprocesses — the wire format is
// a header and a JSON body, and the alternative is a dependency that mostly re-implements this.
// Scope is deliberately what the agent tools need: diagnostics and hover.

const REQUEST_TIMEOUT_MS = 10_000; // a hung server must not wedge an agent's tool loop
const DIAGNOSTICS_WAIT_MS = 3_000; // diagnostics arrive as a push, not a reply — wait, then answer with what we have

export type Severity = "error" | "warning" | "info" | "hint";

export interface Diagnostic {
  line: number; // 1-based, as humans and compilers count
  column: number;
  severity: Severity;
  message: string;
  source?: string;
}

const SEVERITY: Record<number, Severity> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

// Language id from extension — servers use it to pick a parser. Unknown extensions fall back to
// "plaintext", which every server tolerates.
const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".go": "go",
  ".py": "python",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".json": "json",
  ".css": "css",
  ".html": "html",
  ".md": "markdown",
};

export function languageId(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot < 0 ? undefined : LANGUAGE_IDS[path.slice(dot).toLowerCase()]) ?? "plaintext";
}

interface Message {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LspClient {
  private proc?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private diagnosticsByUri = new Map<string, Diagnostic[]>();
  private waiters = new Map<string, (() => void)[]>();
  private versions = new Map<string, number>();
  private starting?: Promise<void>;
  private dead?: Error;

  constructor(
    private command: string,
    private args: string[] = [],
    private root: string = process.cwd(),
  ) {}

  get running(): boolean {
    return Boolean(this.proc) && !this.dead;
  }

  // Idempotent and concurrency-safe: two agents asking for diagnostics at once share one handshake.
  start(): Promise<void> {
    if (this.dead) return Promise.reject(this.dead);
    return (this.starting ??= this.spawnAndInitialize());
  }

  private async spawnAndInitialize(): Promise<void> {
    const proc = spawn(this.command, this.args, { cwd: this.root, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    this.proc = proc;
    // A missing binary (ENOENT) surfaces here, not as a throw from spawn — same posture as an
    // optional MCP server: a clear error string, never a crashed agent.
    proc.on("error", (err) => this.die(new Error(`${this.command}: ${err.message}`)));
    proc.on("exit", (code) => this.die(new Error(`${this.command} exited (code ${code})`)));
    proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    proc.stderr.on("data", () => {}); // language servers log chattily on stderr; not our business

    await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.root).href,
      workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: "root" }],
      capabilities: { textDocument: { publishDiagnostics: {}, hover: { contentFormat: ["plaintext", "markdown"] } } },
    });
    this.notify("initialized", {});
  }

  async diagnostics(path: string): Promise<Diagnostic[]> {
    await this.start();
    const uri = await this.sync(path);
    if (!this.diagnosticsByUri.has(uri)) await this.waitForDiagnostics(uri);
    return this.diagnosticsByUri.get(uri) ?? [];
  }

  async hover(path: string, line: number, column: number): Promise<string> {
    await this.start();
    const uri = await this.sync(path);
    // LSP positions are 0-based; the tool's contract is the 1-based numbers an editor shows.
    const res = (await this.request("textDocument/hover", {
      textDocument: { uri },
      position: { line: Math.max(0, line - 1), character: Math.max(0, column - 1) },
    })) as { contents?: unknown } | null;
    return res ? hoverText(res.contents) : "";
  }

  stop(): void {
    this.die(new Error("stopped"));
    this.proc?.kill();
  }

  // --- document sync ---------------------------------------------------------
  // First touch is didOpen; later ones are didChange with a bumped version. Either way the cached
  // diagnostics for the file are dropped, so a caller always waits for a fresh publish.
  private async sync(path: string): Promise<string> {
    const uri = pathToFileURL(path).href;
    const text = await readFile(path, "utf8");
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    this.diagnosticsByUri.delete(uri);
    if (version === 1) {
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId: languageId(path), version, text } });
    } else {
      this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
    }
    return uri;
  }

  private waitForDiagnostics(uri: string): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.set(uri, (this.waiters.get(uri) ?? []).filter((w) => w !== done));
        resolve(); // no publish in time — report what we have rather than blocking the agent
      }, DIAGNOSTICS_WAIT_MS);
      this.waiters.set(uri, [...(this.waiters.get(uri) ?? []), done]);
    });
  }

  // --- JSON-RPC plumbing -----------------------------------------------------
  private request(method: string, params: unknown): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.command}: ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.dead) this.send({ jsonrpc: "2.0", method, params });
  }

  private send(msg: unknown): void {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    this.proc?.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc?.stdin.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const split = this.buffer.indexOf("\r\n\r\n");
      if (split < 0) return;
      const header = this.buffer.subarray(0, split).toString("utf8");
      const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? NaN);
      if (!Number.isFinite(length)) {
        this.buffer = this.buffer.subarray(split + 4); // unparseable header — resync past it
        continue;
      }
      const start = split + 4;
      if (this.buffer.length < start + length) return; // body still arriving
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      try {
        this.dispatch(JSON.parse(body) as Message);
      } catch {
        /* a malformed frame is the server's bug — skip it, keep the stream alive */
      }
    }
  }

  private dispatch(msg: Message): void {
    if (msg.id !== undefined && msg.method) {
      // Server→client request (workspace/configuration, client/registerCapability, …). We advertise
      // no capabilities, so an empty result is correct — and silence would hang some servers.
      this.send({ jsonrpc: "2.0", id: msg.id, result: null });
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(new Error(msg.error.message ?? "lsp error")) : p.resolve(msg.result);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as { uri: string; diagnostics?: unknown[] };
      this.diagnosticsByUri.set(params.uri, (params.diagnostics ?? []).map(toDiagnostic));
      for (const wake of this.waiters.get(params.uri) ?? []) wake();
      this.waiters.delete(params.uri);
    }
  }

  private die(err: Error): void {
    if (this.dead) return;
    this.dead = err;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    for (const [, waiters] of this.waiters) for (const wake of waiters) wake();
    this.waiters.clear();
  }
}

function toDiagnostic(raw: unknown): Diagnostic {
  const d = raw as { range?: { start?: { line?: number; character?: number } }; severity?: number; message?: string; source?: string };
  return {
    line: (d.range?.start?.line ?? 0) + 1,
    column: (d.range?.start?.character ?? 0) + 1,
    severity: SEVERITY[d.severity ?? 1] ?? "error",
    message: d.message ?? "",
    source: d.source,
  };
}

// hover.contents is one of three shapes across LSP versions: a string, a {kind,value} MarkupContent,
// or an array of either. Flatten them all to plain text.
export function hoverText(contents: unknown): string {
  if (contents == null) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join("\n");
  const c = contents as { value?: unknown };
  return typeof c.value === "string" ? c.value : "";
}
