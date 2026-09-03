import { test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool, safePath, shell, toolSpecs, toSandboxCall, applyEdit, editDiff } from "./tools.ts";

const root = mkdtempSync(join(tmpdir(), "niti-tools-"));
const ALL = ["read_file", "write_file", "edit", "shell"];

test("write then read within the project root", async () => {
  await runTool({ tool: "write_file", path: "hello.txt", content: "hi" }, ALL, root);
  const out = await runTool({ tool: "read_file", path: "hello.txt" }, ALL, root);
  expect(out).toBe("hi");
});

test("write_file creates missing parent directories", async () => {
  await runTool({ tool: "write_file", path: "a/b/c/deep.txt", content: "nested" }, ALL, root);
  expect(await readFile(join(root, "a/b/c/deep.txt"), "utf8")).toBe("nested");
});

test("write_file's mkdir never escapes the project root", async () => {
  await expect(
    runTool({ tool: "write_file", path: "../outside/x.txt", content: "x" }, ALL, root),
  ).rejects.toThrow(/escapes project root/);
  expect(existsSync(join(root, "..", "outside"))).toBe(false);
});

test("path traversal is rejected", () => {
  expect(() => safePath(root, "../../etc/passwd")).toThrow(/escapes project root/);
  expect(() => safePath(root, "/etc/passwd")).toThrow(/escapes project root/);
});

test("a write via traversal never touches the target", async () => {
  await expect(
    runTool({ tool: "write_file", path: "../escape.txt", content: "x" }, ALL, root),
  ).rejects.toThrow(/escapes project root/);
  expect(existsSync(join(root, "..", "escape.txt"))).toBe(false);
});

test("shell args are literal — no shell metacharacter injection", async () => {
  // If a shell interpreted this, `whoami` would run separately. spawn treats it as one literal arg.
  const out = await runTool({ tool: "shell", command: "echo", args: ["hello; whoami"] }, ALL, root);
  expect(out).toContain("hello; whoami");
});

test("shell runs with cwd pinned to the project root", async () => {
  await runTool({ tool: "shell", command: "touch", args: ["marker"] }, ALL, root);
  expect(existsSync(join(root, "marker"))).toBe(true);
});

test("a command that waits on stdin gets EOF instead of hanging", async () => {
  // `cat` with no file reads stdin. With an inherited/piped stdin this never returns and the
  // agent's SHELL_LOCK is held forever — the whole point of stdio[0] = "ignore".
  const r = await shell(root, "cat", []);
  expect(r.code).toBe(0);
});

test("a command that outruns its timeout is killed and reported", async () => {
  const r = await shell(root, "sleep", ["30"], { timeoutMs: 200 });
  expect(r.code).toBe(-1);
  expect(r.stderr).toContain("[timed out after 0.2s]");
});

test("runaway output is capped, not accumulated", async () => {
  const r = await shell(root, "head", ["-c", "5000", "/dev/zero"], { maxOutput: 500 });
  expect(r.stdout.length).toBeLessThan(600); // 500 + the marker, not 5000
  expect(r.stdout).toContain("[output truncated]");
});

test("tools not in allowedTools are rejected", async () => {
  await expect(
    runTool({ tool: "shell", command: "echo", args: ["x"] }, ["read_file"], root),
  ).rejects.toThrow(/not allowed/);
});

test("edit replaces a unique occurrence in place", async () => {
  await runTool({ tool: "write_file", path: "e.ts", content: "const a = 1;\nconst b = 2;\n" }, ALL, root);
  const out = await runTool({ tool: "edit", path: "e.ts", oldString: "const b = 2;", newString: "const b = 99;" }, ALL, root);
  expect(out).toBe("edited e.ts");
  expect(await readFile(join(root, "e.ts"), "utf8")).toBe("const a = 1;\nconst b = 99;\n");
});

test("edit refuses an ambiguous or absent match rather than guessing", async () => {
  await runTool({ tool: "write_file", path: "dup.ts", content: "x\nx\n" }, ALL, root);
  await expect(runTool({ tool: "edit", path: "dup.ts", oldString: "x", newString: "y" }, ALL, root)).rejects.toThrow(/occurs 2 times/);
  await expect(runTool({ tool: "edit", path: "dup.ts", oldString: "zzz", newString: "y" }, ALL, root)).rejects.toThrow(/not found/);
  await expect(runTool({ tool: "edit", path: "dup.ts", oldString: "", newString: "y" }, ALL, root)).rejects.toThrow(/must not be empty/);
  expect(await readFile(join(root, "dup.ts"), "utf8")).toBe("x\nx\n"); // untouched by any of them
});

test("edit with replaceAll rewrites every occurrence", async () => {
  await runTool({ tool: "write_file", path: "all.ts", content: "x\nx\n" }, ALL, root);
  await runTool({ tool: "edit", path: "all.ts", oldString: "x", newString: "y", replaceAll: true }, ALL, root);
  expect(await readFile(join(root, "all.ts"), "utf8")).toBe("y\ny\n");
});

test("editDiff shows the hunk with its line number", () => {
  expect(editDiff("a\nb\nc\n", "b", "B")).toBe("@@ line 2 @@\n-b\n+B");
});

test("applyEdit is pure — it never touches disk", () => {
  expect(applyEdit("hello world", "world", "there", false)).toBe("hello there");
  expect(applyEdit("a-a-a", "a", "b", true)).toBe("b-b-b");
});

test("toolSpecs returns specs for known tools and drops unknowns", () => {
  expect(toolSpecs(["read_file", "bogus", "shell", "edit"]).map((s) => s.name)).toEqual(["read_file", "shell", "edit"]);
});

test("toSandboxCall maps provider tool calls to sandbox calls", () => {
  expect(toSandboxCall({ id: "1", name: "read_file", input: { path: "a.txt" } })).toEqual({
    tool: "read_file",
    path: "a.txt",
  });
  expect(toSandboxCall({ id: "2", name: "shell", input: { command: "ls", args: ["-a"] } })).toEqual({
    tool: "shell",
    command: "ls",
    args: ["-a"],
  });
  expect(() => toSandboxCall({ id: "3", name: "nope", input: {} })).toThrow(/unknown tool/);
});

test("a whole command line in 'command' is split rather than spawned as one binary name", () => {
  // Observed live: a model's first tool call was {"command":"git status"}, which failed with
  // 'Executable not found in $PATH: "git status"' — an error that blames the user's PATH.
  expect(toSandboxCall({ id: "1", name: "shell", input: { command: "git status" } })).toEqual({
    tool: "shell",
    command: "git",
    args: ["status"],
  });
  // An explicit args[] is the documented shape and always wins over the split.
  expect(toSandboxCall({ id: "2", name: "shell", input: { command: "ls", args: ["-la"] } })).toEqual({
    tool: "shell",
    command: "ls",
    args: ["-la"],
  });
});

test("provider credentials are not handed to spawned commands", async () => {
  process.env.NITI_TEST_FAKE_KEY = "sk-should-not-leak";
  const r = await shell(root, "env", []);
  expect(r.stdout).not.toContain("sk-should-not-leak");
  expect(r.stdout).toContain("PATH="); // ...but the allowlist still gets through
  delete process.env.NITI_TEST_FAKE_KEY;
});


test("read_file caps huge files and refuses binaries", async () => {
  // A tool result is re-sent on every later turn, so an unbounded read is one big response per
  // turn rather than one big response.
  const big = "x".repeat(300_000);
  await runTool({ tool: "write_file", path: "big.txt", content: big }, ALL, root);
  const out = await runTool({ tool: "read_file", path: "big.txt" }, ALL, root);
  expect(out.length).toBeLessThan(300_000);
  expect(out).toContain("[truncated:");

  const nul = "a" + String.fromCharCode(0) + "b";
  await runTool({ tool: "write_file", path: "bin.dat", content: nul }, ALL, root);
  expect(await runTool({ tool: "read_file", path: "bin.dat" }, ALL, root)).toContain("binary file");
});
