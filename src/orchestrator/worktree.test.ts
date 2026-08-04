import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGitRepo, createWorktree, diffStat, commitPending, mergeBack, removeWorktree } from "./worktree.ts";

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "niti-worktree-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(join(root, "README.md"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  return root;
}

test("isGitRepo detects a real repo and rejects a plain directory", async () => {
  const repo = initRepo();
  expect(await isGitRepo(repo)).toBe(true);
  const plain = mkdtempSync(join(tmpdir(), "niti-plain-"));
  expect(await isGitRepo(plain)).toBe(false);
});

test("createWorktree, diffStat, commitPending, and mergeBack round-trip an UNCOMMITTED write back into the main branch", async () => {
  // Mirrors real usage: agents write files via write_file/edit, they never `git add`/`commit` as
  // they go — so the new file below is untracked in the worktree until commitPending stages it.
  const repo = initRepo();
  const handle = await createWorktree(repo, "t1");
  expect(existsSync(handle.path)).toBe(true);
  expect(handle.branch).toBe("niti/t1");

  writeFileSync(join(handle.path, "new.txt"), "added in the worktree\n");

  // diffStat must see an untracked file, not just tracked modifications.
  const stat = await diffStat(handle);
  expect(stat).toContain("new.txt");

  // The real root never saw the write — it only exists in the worktree until merged.
  expect(existsSync(join(repo, "new.txt"))).toBe(false);

  // Merging before committing is a silent no-op (nothing new on the branch yet).
  const premature = await mergeBack(repo, handle.branch);
  expect(premature.ok).toBe(true);
  expect(existsSync(join(repo, "new.txt"))).toBe(false);

  await commitPending(handle);
  const result = await mergeBack(repo, handle.branch);
  expect(result.ok).toBe(true);
  expect(existsSync(join(repo, "new.txt"))).toBe(true);

  await removeWorktree(repo, handle.path);
  expect(existsSync(handle.path)).toBe(false);
});

test("commitPending is a no-op when the worktree has no pending changes", async () => {
  const repo = initRepo();
  const handle = await createWorktree(repo, "t2");
  await commitPending(handle); // must not throw ("nothing to commit")
  const log = execFileSync("git", ["log", "--oneline", handle.branch], { cwd: repo }).toString();
  expect(log.trim().split("\n")).toHaveLength(1); // still just the initial commit — nothing new
});
