import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { condenseOutput, condenseForModel, isRunner, shellCommandLine } from "./condense.ts";

const passing = (n: number) => Array.from({ length: n }, (_, i) => `  ✓ handles case number ${i} correctly (3 ms)`).join("\n");

test("keeps every failure line and the summary, drops passing tests", () => {
  const out = `exit 1\n PASS src/a.test.ts\n${passing(80)}\n  ✕ rejects bad input (5 ms)\n    Expected: 3\n    Received: 4\n      at src/b.ts:12:5\nTests:       1 failed, 80 passed, 81 total`;
  const c = condenseOutput("npx jest", out)!;
  expect(c.dropped).toBe(81); // 80 passing + the PASS header
  for (const keep of ["exit 1", "✕ rejects bad input", "Expected: 3", "Received: 4", "src/b.ts:12:5", "1 failed, 80 passed"]) expect(c.text).toContain(keep);
  expect(c.text).not.toContain("✓");
});

test("only known runners, only when it pays", () => {
  const out = passing(80);
  expect(condenseOutput("cat notes.txt", out)).toBeUndefined(); // not a runner: never touched
  expect(condenseOutput("npm test", passing(3))).toBeUndefined(); // too small to bother
  expect(condenseOutput("npm test", "x\n".repeat(2000) + "y")).toBeDefined(); // repeats collapse
  expect(condenseOutput("npm test", Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n"))).toBeUndefined(); // nothing to drop
});

test("runner detection covers the common shapes and nothing else", () => {
  for (const cmd of ["pytest -q", "python -m pytest tests", "bun test", "go test ./...", "cargo test", "npm run test", "pnpm install", "npx tsc --noEmit", "./node_modules/.bin/vitest run", "make"])
    expect(isRunner(cmd)).toBe(true);
  for (const cmd of ["cat package.json", "git diff", "ls -la", "grep -rn test src", "node script.js"]) expect(isRunner(cmd)).toBe(false);
  expect(shellCommandLine({ command: "npm", args: ["run", "test"] })).toBe("npm run test");
});

test("progress redraws keep their last state, ANSI colour is stripped", () => {
  const bar = Array.from({ length: 60 }, (_, i) => `\r[${"#".repeat(i)}] ${i}%`).join("") + "\n";
  const out = `${bar}\x1b[31mERROR\x1b[0m src/x.ts:3 boom\n${passing(40)}`;
  const c = condenseOutput("cargo build", out)!;
  expect(c.text).toContain("ERROR src/x.ts:3 boom");
  expect(c.text).toContain("59%");
  expect(c.text).not.toContain("\x1b[");
  expect(c.text).not.toContain("] 58%");
});

test("go, cargo, pytest and bun passing lines all go; their failures stay", () => {
  const out = [
    ...Array.from({ length: 30 }, (_, i) => `=== RUN   TestThing${i}\n--- PASS: TestThing${i} (0.00s)`),
    "--- FAIL: TestBroken (0.01s)",
    ...Array.from({ length: 30 }, (_, i) => `test mod::case_${i} ... ok`),
    "test mod::broken ... FAILED",
    ...Array.from({ length: 30 }, (_, i) => `tests/test_a.py::test_${i} PASSED [ ${i}%]`),
    "tests/test_a.py::test_bad FAILED [ 99%]",
    ...Array.from({ length: 30 }, (_, i) => `(pass) suite > case ${i} [0.10ms]`),
    "(fail) suite > broken [0.20ms]",
  ].join("\n");
  const c = condenseOutput("go test ./...", out)!;
  for (const keep of ["--- FAIL: TestBroken", "test mod::broken ... FAILED", "test_bad FAILED", "(fail) suite > broken"]) expect(c.text).toContain(keep);
  expect(c.text).not.toMatch(/PASS:|\.\.\. ok|PASSED|\(pass\)|=== RUN/);
});

test("the untouched output is kept in a self-ignoring .niti/logs and the model is told where", () => {
  const root = mkdtempSync(join(tmpdir(), "niti-condense-"));
  const out = `${passing(80)}\n  ✕ broken`;
  const text = condenseForModel(root, "npx vitest run", out);
  const m = text.match(/full output is in (\S+) /);
  expect(m).not.toBeNull();
  expect(readFileSync(join(root, m![1]!), "utf8")).toBe(out);
  expect(readFileSync(join(root, ".niti/logs/.gitignore"), "utf8")).toBe("*\n");
  for (let i = 0; i < 25; i++) condenseForModel(root, "npx vitest run", out);
  expect(readdirSync(join(root, ".niti/logs")).filter((f) => f.endsWith(".log")).length).toBe(20);
  expect(condenseForModel(root, "ls", out)).toBe(out); // not a runner: byte-identical
});
