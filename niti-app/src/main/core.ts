import { spawn, execFile, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, type WriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";
import type { CoreExit, ServerInfo, TrustStatus } from "../shared/bridge";
import { userEnv, which } from "./env";

// niti-core, launched exactly the way the Go TUI does it (tui/cmd/niti/main.go): `<core> serve`
// with the project as cwd, its own process group, stderr into .niti/core.log, and the first stdout
// line as the handshake {"nitiServer":{url,token}}. Trust is settled by the app's own prompt
// before this runs, so the core gets NITI_TRUST=1 and never asks on a stdin it doesn't have.

const HANDSHAKE_TIMEOUT = 30_000;

interface Launch {
  cmd: string;
  args: string[]; // prefix: what comes before the subcommand ("serve", "trust check")
  label: string;
}

function repoRoot(): string | undefined {
  // In dev the app runs from niti-app/ inside the niti repo; the engine is ../src/cli.ts.
  const root = dirname(app.getAppPath());
  return existsSync(join(root, "src/cli.ts")) ? root : undefined;
}

export async function resolveCore(): Promise<Launch | undefined> {
  const env = await userEnv();
  const bun = env.NITI_BUN || which("bun", env.PATH ?? "") || "bun";
  if (env.NITI_CORE_ENTRY) return { cmd: bun, args: ["run", env.NITI_CORE_ENTRY], label: `bun run ${env.NITI_CORE_ENTRY}` };
  const exe = process.platform === "win32" ? "niti-core.exe" : "niti-core";
  const bundled = join(process.resourcesPath, exe);
  if (app.isPackaged && existsSync(bundled)) return { cmd: bundled, args: [], label: `bundled ${bundled}` };
  const repo = repoRoot();
  if (!app.isPackaged && repo) return { cmd: bun, args: ["run", join(repo, "src/cli.ts")], label: `bun run ${join(repo, "src/cli.ts")} (dev)` };
  const onPath = which(exe, env.PATH ?? "");
  if (onPath) return { cmd: onPath, args: [], label: onPath };
  return undefined;
}

export async function coreLabel(): Promise<string> {
  return (await resolveCore())?.label ?? "niti-core not found";
}

function run(launch: Launch, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return userEnv().then(
    (env) =>
      new Promise((resolve) => {
        execFile(launch.cmd, [...launch.args, ...args], { cwd, env, timeout: 20_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        });
      }),
  );
}

export async function trustCheck(root: string): Promise<TrustStatus> {
  const launch = await resolveCore();
  if (!launch) throw new Error(notFound());
  const r = await run(launch, ["trust", "check"], root);
  // Exit 1 means "not trusted", not failure — the JSON is on stdout either way.
  try {
    const j = JSON.parse(r.stdout.trim().split("\n").pop() || "{}") as Partial<TrustStatus>;
    return { trusted: Boolean(j.trusted), root: j.root ?? root, changed: Boolean(j.changed) };
  } catch {
    throw new Error(`niti-core trust check failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  }
}

export async function trustGrant(root: string): Promise<void> {
  const launch = await resolveCore();
  if (!launch) throw new Error(notFound());
  const r = await run(launch, ["trust", "grant"], root);
  if (r.code !== 0) throw new Error(`niti-core trust grant failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
}

function notFound(): string {
  return "niti-core was not found. Install niti (npm i -g @slenderbuilds/niti) or set NITI_CORE_ENTRY.";
}

export class Core extends EventEmitter {
  private proc?: ChildProcess;
  private log?: WriteStream;
  private stopping = false;
  info?: ServerInfo;

  constructor(readonly root: string) {
    super();
  }

  get logPath(): string {
    return join(this.root, ".niti", "core.log");
  }

  logTail(lines = 40): string {
    try {
      return readFileSync(this.logPath, "utf8").split("\n").slice(-lines).join("\n").trim();
    } catch {
      return "";
    }
  }

  private starting?: Promise<ServerInfo>;

  // Two starts at once (a double-clicked recent, a fast restart) share one launch, not two cores.
  start(): Promise<ServerInfo> {
    this.starting ??= this.launch().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async launch(): Promise<ServerInfo> {
    if (this.info && this.proc && this.proc.exitCode === null) return this.info;
    const launch = await resolveCore();
    if (!launch) throw new Error(notFound());
    const env = { ...(await userEnv()), NITI_TRUST: "1" };
    mkdirSync(join(this.root, ".niti"), { recursive: true });
    // Keep the previous run's log: after a crash, Restart must not erase the reason it crashed.
    try {
      renameSync(this.logPath, `${this.logPath}.1`);
    } catch {
      /* first start: nothing to keep */
    }
    this.log = createWriteStream(this.logPath, { flags: "w" });
    this.stopping = false;
    const proc = spawn(launch.cmd, [...launch.args, "serve"], {
      cwd: this.root,
      env,
      detached: process.platform !== "win32", // own process group: stop() takes the agents' shells with it
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;
    proc.stderr!.pipe(this.log, { end: false });

    const info = await new Promise<ServerInfo>((resolve, reject) => {
      let buf = "";
      let settled = false;
      const timer = setTimeout(() => finish(new Error(`niti-core did not start within ${HANDSHAKE_TIMEOUT / 1000}s`)), HANDSHAKE_TIMEOUT);
      const finish = (err: Error | null, value?: ServerInfo) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(value!);
      };
      proc.stdout!.on("data", (chunk: Buffer) => {
        if (settled) {
          this.log?.write(chunk); // anything after the handshake is diagnostics
          return;
        }
        buf += chunk.toString();
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        if (buf.length > nl + 1) this.log?.write(buf.slice(nl + 1));
        try {
          const hs = JSON.parse(line) as { nitiServer?: ServerInfo };
          if (!hs.nitiServer?.url) throw new Error("no nitiServer");
          finish(null, hs.nitiServer);
        } catch {
          finish(new Error(`unexpected first line from niti-core: ${line.slice(0, 200)}`));
        }
      });
      proc.once("error", (err) => finish(err));
      proc.once("exit", (code) => {
        // Give the log stream a beat to flush so the tail actually contains the reason.
        setTimeout(() => finish(new Error(`niti-core exited (code ${code}) before it was ready.\n${this.logTail(15)}`)), 150);
      });
    }).catch(async (err) => {
      await this.stop();
      throw err;
    });

    proc.once("exit", (code) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.info = undefined;
      if (!this.stopping) {
        setTimeout(() => this.emit("exit", { code, logTail: this.logTail() } satisfies CoreExit), 150);
      }
    });
    this.info = info;
    return info;
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.stopping = true;
    this.info = undefined;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      this.proc = undefined;
      return;
    }
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, sig);
        else proc.kill(sig);
      } catch {
        /* already gone */
      }
    };
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        kill("SIGKILL");
        resolve();
      }, 2000);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      kill("SIGTERM");
    });
    this.proc = undefined;
    this.log?.end();
  }

  async restart(): Promise<ServerInfo> {
    await this.stop();
    return this.start();
  }
}
