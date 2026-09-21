import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChecks, checkSurface, taskEditsCheckFile } from "./verify.ts";

const surface = checkSurface(parseChecks(["node check.js", "npm run typecheck"]));

test("the script a check runs is an enforcer — editing it to clear a failure is never the fix", () => {
  expect(surface("check.js")).toBe("enforcer");
  expect(surface("./check.js")).toBe("enforcer");
});

test("strictness config is an enforcer; tests and manifests are dual-use", () => {
  for (const p of ["tsconfig.json", ".eslintrc.json", "mypy.ini", ".golangci.yml", "vitest.config.ts"]) {
    expect(surface(p)).toBe("enforcer");
  }
  // These change for honest reasons constantly — rename a function and its tests follow; add a
  // dependency and the manifest follows. Refusing those would derail ordinary refactors.
  for (const p of ["src/math.test.ts", "tests/unit/thing.py", "internal/api/client_test.go", "package.json", "Makefile"]) {
    expect(surface(p)).toBe("test");
  }
});

test("ordinary source is not check surface at all", () => {
  for (const p of ["src/math.ts", "src/routes/users.ts", "README.md", "web/app.js", "src/latest.ts"]) {
    expect(surface(p)).toBeUndefined();
  }
});

test("a package-manager script is expanded to the command it actually runs", () => {
  // `npm run typecheck` names no files at all — the real command is in package.json — and almost
  // every project's check is that shape. Missing this made the guard blind to the single file most
  // worth protecting, which is exactly how a live model walked past it.
  const dir = mkdtempSync(join(tmpdir(), "niti-surface-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit && node check.js" } }));
  const s = checkSurface(parseChecks(["npm run typecheck"]), dir);
  expect(s("check.js")).toBe("enforcer"); // reached through the script body, and past the `&&`
  expect(s("src/app.ts")).toBeUndefined();
});

test("a missing or unparseable package.json degrades to the name patterns, not a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "niti-surface-bad-"));
  writeFileSync(join(dir, "package.json"), "{ not json");
  const s = checkSurface(parseChecks(["npm run typecheck"]), dir);
  expect(s("src/app.ts")).toBeUndefined();
  expect(s("src/app.test.ts")).toBe("test");
});

test("a task that asks for a config change exempts that config file", () => {
  expect(taskEditsCheckFile("Update tsconfig to ESNext", "tsconfig.json")).toBe(true);
  expect(taskEditsCheckFile("Enable strict mode in tsconfig.json.", "tsconfig.json")).toBe(true);
  expect(taskEditsCheckFile("Add a new linter rule banning console.log", "eslint.config.js")).toBe(true);
  expect(taskEditsCheckFile("Tighten the eslint config, then fix what it flags.", ".eslintrc.json")).toBe(true);
  expect(taskEditsCheckFile("Set the python version in mypy.ini to 3.12", "mypy.ini")).toBe(true);
  expect(taskEditsCheckFile("Change the vitest config to use jsdom", "vitest.config.ts")).toBe(true);
  // A nested path matches on the file's own name.
  expect(taskEditsCheckFile("update packages/web/tsconfig.json to extend the base", "packages/web/tsconfig.json")).toBe(true);
});

test("a task that only mentions the check, or forbids touching the config, exempts nothing", () => {
  // Naming the tool is naming the check, not asking for its configuration to change.
  expect(taskEditsCheckFile("Fix the type errors so tsc passes", "tsconfig.json")).toBe(false);
  expect(taskEditsCheckFile("Update the code so eslint passes", "eslint.config.js")).toBe(false);
  expect(taskEditsCheckFile("Make the linter happy", "eslint.config.js")).toBe(false);
  expect(taskEditsCheckFile("Fix the failing test in src/math.ts", "tsconfig.json")).toBe(false);
  // The user said not to: the guard stays fully on.
  expect(taskEditsCheckFile("Fix the failing test. Do not touch tsconfig.json.", "tsconfig.json")).toBe(false);
  expect(taskEditsCheckFile("Update the parser without changing the eslint config", "eslint.config.js")).toBe(false);
  expect(taskEditsCheckFile("Never edit tsconfig.json to make this pass", "tsconfig.json")).toBe(false);
  // A verb in one sentence and the file in another is not a request.
  expect(taskEditsCheckFile("Update the parser. It reads tsconfig.json.", "tsconfig.json")).toBe(false);
  // Only the file it names: a request for one config says nothing about another.
  expect(taskEditsCheckFile("Update tsconfig to ESNext", "eslint.config.js")).toBe(false);
});

test("terse orchestrator shorthand exempts the config it targets", () => {
  expect(taskEditsCheckFile("target esnext in tsconfig", "tsconfig.json")).toBe(true);
  expect(taskEditsCheckFile("deps: bump typescript to 5.5", "package.json")).toBe(true);
  expect(taskEditsCheckFile("configure eslint rules", "eslint.config.js")).toBe(true);
  expect(taskEditsCheckFile("eslint: no-console off", "eslint.config.js")).toBe(true);
  expect(taskEditsCheckFile("python 3.12 in mypy", "mypy.ini")).toBe(true);
  // Shorthand still names one file only, and a bare tool without a target is still just the check.
  expect(taskEditsCheckFile("target esnext in tsconfig", "eslint.config.js")).toBe(false);
  expect(taskEditsCheckFile("make eslint pass", "eslint.config.js")).toBe(false);
  expect(taskEditsCheckFile("fix types in src/a.ts", "tsconfig.json")).toBe(false);
});

test("negated directives keep the guard on, shorthand or not", () => {
  expect(taskEditsCheckFile("do not touch tsconfig", "tsconfig.json")).toBe(false);
  expect(taskEditsCheckFile("never modify eslint config", "eslint.config.js")).toBe(false);
  expect(taskEditsCheckFile("tsconfig: leave unchanged", "tsconfig.json")).toBe(false);
  expect(taskEditsCheckFile("keep tsconfig as is", "tsconfig.json")).toBe(false);
  expect(taskEditsCheckFile("deps: don't bump typescript", "package.json")).toBe(false);
});
