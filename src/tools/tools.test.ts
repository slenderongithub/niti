import { test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool, safePath, toolSpecs, toSandboxCall } from "./tools.ts";

const root = mkdtempSync(join(tmpdir(), "amux-tools-"));
const ALL = ["read_file", "write_file", "shell"];

test("write then read within the project root", async () => {
  await runTool({ tool: "write_file", path: "hello.txt", content: "hi" }, ALL, root);
  const out = await runTool({ tool: "read_file", path: "hello.txt" }, ALL, root);
  expect(out).toBe("hi");
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

test("tools not in allowedTools are rejected", async () => {
  await expect(
    runTool({ tool: "shell", command: "echo", args: ["x"] }, ["read_file"], root),
  ).rejects.toThrow(/not allowed/);
});

test("toolSpecs returns specs for known tools and drops unknowns", () => {
  expect(toolSpecs(["read_file", "bogus", "shell"]).map((s) => s.name)).toEqual(["read_file", "shell"]);
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
