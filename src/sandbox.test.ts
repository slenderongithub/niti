import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { shell } from "./tools/tools.ts";
import { seatbeltProfile, sandboxKind } from "./sandbox.ts";

const onMac = sandboxKind() === "seatbelt";

test.skipIf(!onMac)("sandboxed shell writes inside the project, not outside it, and not into .niti/", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "niti-sbx-")));
  mkdirSync(join(root, ".niti"));
  const outside = join(homedir(), `.niti-sandbox-test-${process.pid}`);
  const run = (script: string) => shell(root, "sh", ["-c", script], { sandbox: true });

  expect((await run("echo ok > inside.txt")).code).toBe(0);
  expect(existsSync(join(root, "inside.txt"))).toBe(true);

  const out = await run(`echo x > '${outside}'`);
  expect(out.code).not.toBe(0);
  expect(existsSync(outside)).toBe(false);
  expect(out.stderr).toContain("blocked by niti's sandbox"); // the model is told why, not left guessing

  expect((await run("echo x > .niti/agents.yaml")).code).not.toBe(0);
  expect(existsSync(join(root, ".niti", "agents.yaml"))).toBe(false);

  expect((await run("echo ok > \"$TMPDIR/niti-sbx-tmp\"")).code).toBe(0); // temp stays usable for builds
});

test.skipIf(!onMac)("an ordinary failure is not blamed on the sandbox", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "niti-sbx-")));
  const r = await shell(root, "sh", ["-c", "exit 3"], { sandbox: true });
  expect(r.code).toBe(3);
  expect(r.stderr).not.toContain("sandbox");
});

test.skipIf(!onMac)("the profile denies reading credential stores and quotes paths safely", () => { // Seatbelt is macOS-only
  const p = seatbeltProfile(join(tmpdir(), 'niti "quoted" dir')); // a string is enough — no folder needed
  expect(p).toContain(`(deny file-read*`);
  expect(p).toContain(join(homedir(), ".ssh"));
  expect(p).toContain('\\"quoted\\"');
});

test("git hooks and git config are read-only in the sandbox — git runs them later, outside it", () => {
  const root = mkdtempSync(join(tmpdir(), "niti-sbx-git-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  const profile = seatbeltProfile(root);
  const deny = profile.split("\n").find((l) => l.startsWith("(deny file-write*") && l.includes(".niti"))!;
  for (const p of [join(".git", "hooks"), join(".git", "config"), join(".config", "git")]) expect(deny).toContain(p);
});

test.skipIf(!onMac)("verification checks run inside the sandbox too — a check script cannot write outside the project", async () => {
  const { runChecks } = await import("./agent/verify.ts");
  const root = mkdtempSync(join(tmpdir(), "niti-sbx-verify-"));
  const outside = join(homedir(), `.niti-sbx-verify-${process.pid}`);
  const r = await runChecks(root, [{ name: "touch outside", command: "touch", args: [outside] }], true);
  expect(r.ok).toBe(false);
  expect(existsSync(outside)).toBe(false);
});
