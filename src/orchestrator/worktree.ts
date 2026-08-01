import { spawn } from "node:child_process";
import { join } from "node:path";

// Git isolation for a run: agents write into a throwaway worktree/branch instead of the real root,
// merged back only on explicit user action (never automatically — this is a consequential action,
// same philosophy as approvals and dangerous-shell prompts elsewhere in this codebase).

export interface WorktreeHandle {
  path: string;
  branch: string;
  baseSha: string; // HEAD at creation time — what diffStat compares against
}

// spawn (never exec/shell:true) with args as an array — no shell metacharacter injection, same
// pattern as tools.ts's shell().
function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((res) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => res({ stdout, stderr, code: code ?? -1 }));
    child.on("error", (err) => res({ stdout, stderr: String(err), code: -1 }));
  });
}

// Precondition for worktree isolation. The caller must hard-fail when this is false rather than
// silently falling back to writing the real root — a user who opted into isolation should never
// get an unisolated run instead.
export async function isGitRepo(root: string): Promise<boolean> {
  const r = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

// Create an isolated worktree on a fresh branch off the current HEAD, under .amux/worktrees/<id>.
export async function createWorktree(root: string, id: string): Promise<WorktreeHandle> {
  const branch = `amux/${id}`;
  const path = join(root, ".amux", "worktrees", id);
  const head = await git(root, ["rev-parse", "HEAD"]);
  if (head.code !== 0) throw new Error(`git rev-parse HEAD failed: ${head.stderr.trim()}`);
  const r = await git(root, ["worktree", "add", "-b", branch, path]);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return { path, branch, baseSha: head.stdout.trim() };
}

// What changed in the worktree since it branched off — surfaced to the user before they decide
// whether to merge. Agents write files directly (write_file/edit tools), never `git add`/`commit`
// as they go, so this stages everything first: a plain `git diff` against a commit ignores
// untracked files entirely, which would hide every new file an agent created.
export async function diffStat(handle: WorktreeHandle): Promise<string> {
  await git(handle.path, ["add", "-A"]);
  const r = await git(handle.path, ["diff", "--stat", "--cached", handle.baseSha]);
  return r.stdout.trim();
}

// Commit whatever's pending in the worktree so mergeBack has something to bring across — a no-op
// (not an error) when there's nothing staged, e.g. a task run that made no file changes.
export async function commitPending(handle: WorktreeHandle, message = "amux: worktree changes"): Promise<void> {
  await git(handle.path, ["add", "-A"]);
  const staged = await git(handle.path, ["diff", "--cached", "--quiet"]); // exit 0 = clean, 1 = staged changes
  if (staged.code === 0) return;
  const r = await git(handle.path, ["commit", "-q", "-m", message]);
  if (r.code !== 0) throw new Error(`git commit failed: ${r.stderr.trim() || r.stdout.trim()}`);
}

// Merge the worktree's branch into whatever is currently checked out in `root`. Never automatic —
// only called from an explicit user action (the POST /worktree/merge route), and only after the
// caller has committed pending work (see commitPending) — merging a branch with nothing new
// committed on it is a silent no-op.
export async function mergeBack(root: string, branch: string): Promise<{ ok: boolean; message: string }> {
  const r = await git(root, ["merge", "--no-ff", branch]);
  return { ok: r.code === 0, message: (r.stdout + r.stderr).trim() };
}

// Tear down a worktree once its branch has been merged or abandoned. --force discards uncommitted
// changes in the worktree itself — safe here because mergeBack (or the user) already decided its
// fate; this is cleanup, not a second chance to save work.
export async function removeWorktree(root: string, path: string): Promise<void> {
  await git(root, ["worktree", "remove", "--force", path]);
}
