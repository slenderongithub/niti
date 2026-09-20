import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChecks, checkSurface } from "./verify.ts";

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
