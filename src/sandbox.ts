import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

// OS-level containment for the `shell` tool. Approvals decide what an agent *should* run; this is
// what stops an approved command — or one a prompt injection talked the model into — from doing more
// than it said. Writes are confined to the project (plus temp and the usual tool caches), niti's own
// config under .niti/ is read-only, and credential stores are unreadable. Network is left open:
// installs and builds need it, and egress is already force-asked by the agent loop.
//
// macOS: Seatbelt (sandbox-exec), always present. Linux: bubblewrap when installed, probed once and
// skipped (with a warning) if it cannot run here. Elsewhere: no OS sandbox.
// ponytail: no egress allowlist proxy — the egress prompt is the network boundary for now.

const HOME = homedir();

// Credential stores a command never needs to read for project work.
export const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".kube", ".config/gcloud", ".config/gh", ".config/niti"].map((d) => join(HOME, d));
export const SECRET_FILES = [".netrc", ".git-credentials", ".docker/config.json", ".pypirc"].map((f) => join(HOME, f));

// Where tools keep caches and their own state outside the project. Package managers and compilers
// write caches on every run, and CLIs (Next.js telemetry, Vercel, Firebase, gh, …) save settings
// under ~/Library and ~/.config — blocking those failed ordinary commands. What stays protected is
// what matters: the rest of $HOME (shell rc files, other projects, documents), ~/.ssh and friends
// (unreadable, below), and everything outside $HOME.
const CACHE_DIRS = [
  ".npm", ".cache", ".bun", "go", ".cargo", ".rustup", ".gradle", ".m2", ".pnpm-store", ".yarn", ".config", ".local",
  "Library/Caches", "Library/Preferences", "Library/Application Support", "Library/Logs", "Library/pnpm",
].map((d) => join(HOME, d));

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

// The repo's git dir can sit outside the project (launched from a subfolder, or a worktree), and
// `git commit` has to be able to write there.
const gitDirs = new Map<string, string[]>();
function gitWritable(root: string): string[] {
  let dirs = gitDirs.get(root);
  if (!dirs) {
    const r = spawnSync("git", ["-C", root, "rev-parse", "--absolute-git-dir", "--git-common-dir"], { encoding: "utf8", timeout: 5000 });
    dirs = r.status === 0 ? r.stdout.split("\n").filter(Boolean).map((d) => real(d.startsWith("/") ? d : join(root, d))) : [];
    gitDirs.set(root, dirs);
  }
  return dirs;
}

const sbString = (p: string) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function seatbeltProfile(root: string): string {
  const r = real(root);
  // dirname(tmpdir) is the per-user /var/folders/… dir: T/ is temp, C/ is the cache dir clang/swift use.
  const writable = [r, "/private/tmp", dirname(real(tmpdir())), ...gitWritable(root), ...CACHE_DIRS.map(real)];
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${writable.map((p) => `(subpath ${sbString(p)})`).join(" ")} (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/(fd/[0-9]+|ttys[0-9]+|dtracehelper)$"))`,
    // Later rules win: carve niti's own config and the credential stores back out of what is writable.
    `(deny file-write* (subpath ${sbString(join(r, ".niti"))}) ${SECRET_DIRS.map((d) => `(subpath ${sbString(real(d))})`).join(" ")})`,
    `(deny file-read* ${SECRET_DIRS.map((d) => `(subpath ${sbString(real(d))})`).join(" ")} ${SECRET_FILES.map((f) => `(literal ${sbString(real(f))})`).join(" ")})`,
  ].join("\n");
}

function bwrapArgs(root: string): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--die-with-parent"];
  for (const d of [root, ...gitWritable(root), ...CACHE_DIRS]) if (existsSync(d)) args.push("--bind", d, d);
  if (existsSync(join(root, ".niti"))) args.push("--ro-bind", join(root, ".niti"), join(root, ".niti"));
  for (const d of SECRET_DIRS) if (existsSync(d)) args.push("--tmpfs", d);
  for (const f of SECRET_FILES) if (existsSync(f)) args.push("--ro-bind", "/dev/null", f);
  return [...args, "--chdir", root];
}

let bwrapWorks: boolean | undefined;
function bwrapAvailable(): boolean {
  if (bwrapWorks === undefined) {
    // Probed rather than assumed: bwrap is often installed but unusable (no user namespaces in a
    // container, or disabled by the distro), and a sandbox that fails every command is worse than none.
    const r = spawnSync("bwrap", [...bwrapArgs(tmpdir()), "true"], { stdio: "ignore", timeout: 5000 });
    bwrapWorks = r.status === 0;
  }
  return bwrapWorks;
}

export type SandboxKind = "seatbelt" | "bubblewrap" | "none";

export function sandboxKind(): SandboxKind {
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) return "seatbelt";
  if (process.platform === "linux" && bwrapAvailable()) return "bubblewrap";
  return "none";
}

// The argv that runs `command args` inside the sandbox for `root`, or the original when there is no
// OS sandbox here.
export function wrap(root: string, command: string, args: string[]): { command: string; args: string[] } {
  switch (sandboxKind()) {
    case "seatbelt":
      return { command: "/usr/bin/sandbox-exec", args: ["-p", seatbeltProfile(root), command, ...args] };
    case "bubblewrap":
      return { command: "bwrap", args: [...bwrapArgs(root), command, ...args] };
    default:
      return { command, args };
  }
}

// What the model is told when the sandbox stopped a command, so its next attempt is a safer one
// instead of a retry of the same thing or a claim that it worked.
export const SANDBOX_NOTE =
  "\n[blocked by niti's sandbox: shell commands can write only inside the project (plus temp, tool caches and app settings), " +
  "cannot write .niti/ or the rest of your home folder, and cannot read credential stores (~/.ssh, ~/.aws, …). To change a file outside the project, " +
  "use write_file/edit with its path — the user is asked to approve it.]";

// The errors each sandbox produces. Only matched while that sandbox is active, so an ordinary
// "Permission denied" from a file's own mode is not blamed on niti.
export function blockedBySandbox(output: string, kind = sandboxKind()): boolean {
  if (kind === "seatbelt") return /Operation not permitted/.test(output);
  if (kind === "bubblewrap") return /Read-only file system|Permission denied/.test(output);
  return false;
}
