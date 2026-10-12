import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";

// A macOS app launched from Finder or the Dock gets launchd's bare environment: PATH is
// /usr/bin:/bin:/usr/sbin:/sbin and none of the user's shell exports exist. niti-core falls back
// to provider env vars (ANTHROPIC_API_KEY…) for keys, and its agents run `npm`, `go`, `bun` — so
// the core must see the same environment a terminal would. Read it once from a login shell, the
// way VS Code does, and fall back to a widened PATH if the shell is slow or broken.
let cached: NodeJS.ProcessEnv | undefined;

const EXTRA_PATHS = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", join(homedir(), ".bun/bin"), join(homedir(), ".local/bin"), join(homedir(), "go/bin")];

function widen(path: string | undefined): string {
  const parts = (path ?? "").split(delimiter).filter(Boolean);
  for (const p of EXTRA_PATHS) if (!parts.includes(p)) parts.push(p);
  return parts.join(delimiter);
}

function loginShellEnv(): Promise<NodeJS.ProcessEnv | undefined> {
  if (process.platform === "win32") return Promise.resolve(undefined);
  const shell = process.env.SHELL || "/bin/zsh";
  const mark = "__NITI_ENV__";
  return new Promise((resolve) => {
    execFile(shell, ["-ilc", `printf '${mark}'; env -0; printf '${mark}'`], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout.includes(mark)) return resolve(undefined);
      const body = stdout.split(mark)[1] ?? "";
      const env: NodeJS.ProcessEnv = {};
      for (const kv of body.split("\0")) {
        const i = kv.indexOf("=");
        if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      resolve(env);
    });
  });
}

export async function userEnv(): Promise<NodeJS.ProcessEnv> {
  if (cached) return cached;
  // Started from a terminal (dev, or `open` from a shell): the environment is already the user's.
  const fromTerminal = Boolean(process.env.TERM_PROGRAM || process.env.TERM);
  const shellEnv = fromTerminal ? undefined : await loginShellEnv();
  const env = { ...process.env, ...(shellEnv ?? {}) };
  env.PATH = widen(env.PATH);
  // Electron-specific variables must not leak into the core or the agents' shells.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  cached = env;
  return env;
}

// First match for an executable on the given PATH.
export function which(cmd: string, path: string): string | undefined {
  for (const dir of path.split(delimiter)) {
    const p = join(dir, cmd);
    try {
      if (existsSync(p) && statSync(p).isFile()) return p;
    } catch {
      /* unreadable dir */
    }
  }
  return undefined;
}
