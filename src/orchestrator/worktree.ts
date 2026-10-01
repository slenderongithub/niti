import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// Git isolation for a run: agents write into a throwaway worktree/branch instead of the real root,
// merged back only on explicit user action (never automatically — this is a consequential action,
// same philosophy as approvals and dangerous-shell prompts elsewhere in this codebase).

export interface WorktreeHandle {
  path: string; // the worktree's checkout — the whole repo
  workDir: string; // where agents work: the launch folder's place inside it (== path when launched at the repo root)
  branch: string;
  baseSha: string; // HEAD at creation time — what diffStat compares against
}

// spawn (never exec/shell:true) with args as an array — no shell metacharacter injection, same
// pattern as tools.ts's shell().
function git(cwd: string, args: string[], env?: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((res) => {
    const child = spawn("git", args, { cwd, env: env ? { ...process.env, ...env } : undefined });
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

// Create an isolated worktree on a fresh branch off the current HEAD, under .niti/worktrees/<id>.
export async function createWorktree(root: string, id: string): Promise<WorktreeHandle> {
  const branch = `niti/${id}`;
  const path = join(root, ".niti", "worktrees", id);
  const head = await git(root, ["rev-parse", "HEAD"]);
  if (head.code !== 0) throw new Error(`git rev-parse HEAD failed: ${head.stderr.trim()}`);
  await pruneWorktrees(root); // clear registrations whose directories no longer exist
  const r = await git(root, ["worktree", "add", "-b", branch, path]);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`);
  await excludeWorktrees(root);
  // niti may have been launched from a folder inside the repo. The checkout is the whole repo, so
  // agents have to be pointed at the same folder within it, not at its top.
  const top = await git(root, ["rev-parse", "--show-toplevel"]);
  const sub = top.code === 0 ? relative(realpathSync(top.stdout.trim()), realpathSync(root)) : "";
  const workDir = sub && !sub.startsWith("..") ? join(path, sub) : path;
  mkdirSync(workDir, { recursive: true }); // a folder git does not track yet is absent from the checkout
  return { path, workDir, branch, baseSha: head.stdout.trim() };
}

// A worktree inside the repo is a nested checkout: to the outer repo it looks like a gitlink, so
// `git add -A` (an agent's, or the user's) commits an embedded-repo entry that breaks clones.
// .git/info/exclude rather than .gitignore, because this is a local mechanical detail — it should
// not appear in the user's tracked ignore file or in their next diff.
async function excludeWorktrees(root: string): Promise<void> {
  const dir = await git(root, ["rev-parse", "--git-common-dir"]);
  if (dir.code !== 0) return;
  // resolve, not join: from a subfolder git prints the common dir absolute, and joining an absolute
  // path onto root made a nonsense location the exclude was then silently written to.
  const excludePath = resolve(root, dir.stdout.trim(), "info", "exclude");
  try {
    const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    if (current.includes(".niti/worktrees/")) return;
    mkdirSync(dirname(excludePath), { recursive: true });
    writeFileSync(excludePath, `${current}${current.endsWith("\n") || !current ? "" : "\n"}.niti/worktrees/\n`);
  } catch {
    // Cosmetic hygiene — never a reason to fail a run that is otherwise fine.
  }
}

// What changed in the worktree since it branched off — surfaced to the user before they decide
// whether to merge. Agents write files directly (write_file/edit tools), never `git add`/`commit`
// as they go, so this stages everything first: a plain `git diff` against a commit ignores
// untracked files entirely, which would hide every new file an agent created.
export async function diffStat(handle: WorktreeHandle): Promise<string> {
  return await stagedDiff(handle, ["--stat"]);
}

// `git add -A` was the trick for including untracked files, but it is a *write*: GET /worktree
// (a status read, polled by the dashboard) was silently staging the user's work-in-progress, so
// a later `git commit` in that worktree committed more than they had chosen. `--intent-to-add`
// records the paths without staging content, which is exactly what a diff needs and nothing more.
async function stagedDiff(handle: WorktreeHandle, flags: string[], pathspec?: string): Promise<string> {
  await git(handle.path, ["add", "--intent-to-add", "-A"]);
  const args = ["diff", ...flags, handle.baseSha];
  if (pathspec) args.push("--", pathspec);
  const r = await git(handle.path, args);
  return r.stdout.trim();
}

// Zero-context hunks for the IDE's per-hunk review (see ide/extensions/niti-agents/src/hunks.ts):
// with git's default 3-line context, two nearby edits merge into one hunk, coupling their accept/
// reject decisions together even though they're unrelated changes. -U0 keeps every changed line
// range independent, matching what a reviewer actually wants to select between.
export async function diffPatchZeroContext(handle: WorktreeHandle, path?: string): Promise<string> {
  return await stagedDiff(handle, ["-U0"], path);
}

// The full patch (not just the stat summary) for /export's report — same staging as diffStat, so
// new/untracked files show up too.
export async function diffPatch(handle: WorktreeHandle): Promise<string> {
  return await stagedDiff(handle, []);
}

// Commit whatever's pending in the worktree so mergeBack has something to bring across — a no-op
// (not an error) when there's nothing staged, e.g. a task run that made no file changes.
export async function commitPending(handle: WorktreeHandle, message = "niti: worktree changes"): Promise<void> {
  await git(handle.path, ["add", "-A"]);
  const staged = await git(handle.path, ["diff", "--cached", "--quiet"]); // exit 0 = clean, 1 = staged changes
  if (staged.code === 0) return;
  const r = await git(handle.path, ["commit", "-q", "-m", message]);
  if (r.code !== 0) throw new Error(`git commit failed: ${r.stderr.trim() || r.stdout.trim()}`);
}

// /branch: record the working tree — uncommitted and untracked files included — as a commit on a
// new branch, so this line of work stays reachable by name before a /rewind discards it going
// forward. Read-only as far as the checkout goes: the commit is built from a scratch index, so
// HEAD, the real index and every file in the tree are exactly as they were. (The first version
// committed onto the new branch and checked the old one back out, which pulled the agents'
// uncommitted work out of the tree it was meant to protect.)
export async function snapshotBranch(root: string, name: string): Promise<{ ok: boolean; message: string }> {
  const valid = await git(root, ["check-ref-format", "--branch", name]);
  if (valid.code !== 0) return { ok: false, message: `'${name}' is not a valid branch name` };
  const exists = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
  if (exists.code === 0) return { ok: false, message: `branch '${name}' already exists` };
  const head = await git(root, ["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0) return { ok: false, message: "nothing to snapshot yet: this repository has no commits" };

  const gitDir = await git(root, ["rev-parse", "--absolute-git-dir"]);
  const index = join(gitDir.stdout.trim(), `niti-snapshot-${process.pid}-${Date.now()}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    for (const step of [["read-tree", "HEAD"], ["add", "-A"]]) {
      const r = await git(root, step, env);
      if (r.code !== 0) return { ok: false, message: r.stderr.trim() || r.stdout.trim() };
    }
    const tree = await git(root, ["write-tree"], env);
    if (tree.code !== 0) return { ok: false, message: tree.stderr.trim() || tree.stdout.trim() };
    const headTree = await git(root, ["rev-parse", "HEAD^{tree}"]);
    const clean = tree.stdout.trim() === headTree.stdout.trim();
    const target = clean
      ? head.stdout.trim()
      : (await git(root, ["commit-tree", tree.stdout.trim(), "-p", head.stdout.trim(), "-m", `niti: branch snapshot (${name})`])).stdout.trim();
    const made = await git(root, ["branch", name, target]);
    if (made.code !== 0) return { ok: false, message: made.stderr.trim() || made.stdout.trim() };
    return {
      ok: true,
      message: clean
        ? `branch '${name}' created at the current commit (nothing uncommitted to snapshot)`
        : `snapshotted current state to branch '${name}' — your working tree is untouched`,
    };
  } finally {
    rmSync(index, { force: true });
  }
}

// Selective merge: bring only the named files' content in from the worktree branch, leaving
// everything else on the branch untouched (the caller decides what happens to it — typically
// discarding the worktree afterward, since a reviewer who selected some files has already made
// their call on the rest). `git checkout <branch> -- <paths>` updates both the index and working
// tree for those paths from that branch, including paths that don't exist on the current branch
// yet (a file an agent created fresh) — then a pathspec-scoped commit records only those paths,
// leaving any other currently-staged changes in `root` untouched.
export async function mergeFiles(root: string, branch: string, files: string[]): Promise<{ ok: boolean; message: string }> {
  if (!files.length) return { ok: false, message: "no files selected" };
  // `files` are repo-relative (that is what the worktree's diff reports), and git reads pathspecs
  // relative to its cwd — which is a subfolder when niti was launched from one.
  const top = (await git(root, ["rev-parse", "--show-toplevel"])).stdout.trim() || root;
  const checkout = await git(top, ["checkout", branch, "--", ...files]);
  if (checkout.code !== 0) return { ok: false, message: checkout.stderr.trim() || checkout.stdout.trim() };
  const commit = await git(top, ["commit", "-q", "-m", `niti: merge ${files.length} file(s) from ${branch}`, "--", ...files]);
  // Nothing to commit (the checked-out content is identical to what's already in root) isn't a
  // failure — it means those files were already up to date, not that the merge went wrong.
  if (commit.code !== 0 && !(commit.stdout + commit.stderr).includes("nothing to commit")) {
    return { ok: false, message: commit.stderr.trim() || commit.stdout.trim() };
  }
  return { ok: true, message: `merged ${files.length} file(s) from ${branch}` };
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

// Undo a conflicted merge so the user's working tree is not left full of conflict markers they
// never asked for. `|| true` in spirit: if there is no merge in progress this is a harmless no-op.
export async function abortMerge(root: string): Promise<void> {
  await git(root, ["merge", "--abort"]);
}

// Delete the worktree AND its branch — a discard that leaves `niti/<id>` behind is not a discard,
// and those branches accumulate one per abandoned run.
export async function discardWorktree(root: string, handle: WorktreeHandle): Promise<void> {
  await removeWorktree(root, handle.path);
  await git(root, ["branch", "-D", handle.branch]);
}

// Worktrees whose directory is gone (a crash, a manual rm -rf, a machine reboot mid-run) stay
// registered in .git/worktrees forever and make `git worktree add` fail on the same id later.
// `prune` is git's own answer; run it before creating a new one.
export async function pruneWorktrees(root: string): Promise<void> {
  await git(root, ["worktree", "prune"]);
}
