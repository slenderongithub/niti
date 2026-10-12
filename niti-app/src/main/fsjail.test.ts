import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JailError, readProjectFile, resolveInRoot, writeProjectFile } from "./fsjail";

const root = realpathSync(mkdtempSync(join(tmpdir(), "jail-")));
const outside = realpathSync(mkdtempSync(join(tmpdir(), "outside-")));
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
writeFileSync(join(outside, "secret"), "nope");
symlinkSync(outside, join(root, "escape"));
symlinkSync(join(root, "src/a.ts"), join(root, "alias.ts"));
writeFileSync(join(root, "bin.dat"), Buffer.from([1, 0, 2]));

test("paths stay inside the project", () => {
  expect(resolveInRoot(root, "src/a.ts")).toBe(join(root, "src/a.ts"));
  expect(resolveInRoot(root, "src/new/file.ts")).toBe(join(root, "src/new/file.ts")); // not yet existing
  expect(() => resolveInRoot(root, "../etc/passwd")).toThrow(JailError);
  expect(() => resolveInRoot(root, "/etc/passwd")).toThrow(JailError);
  expect(() => resolveInRoot(root, "src/../../x")).toThrow(JailError);
  expect(() => resolveInRoot(root, "escape/secret")).toThrow(JailError);
  expect(() => resolveInRoot(root, "escape/new.txt")).toThrow(JailError);
  expect(resolveInRoot(root, "alias.ts")).toBe(join(root, "alias.ts")); // a link that stays inside is fine
});

test("reads text, refuses binary", () => {
  expect(readProjectFile(root, "src/a.ts").content).toBe("export const a = 1;\n");
  expect(() => readProjectFile(root, "bin.dat")).toThrow("binary");
});

test("writes atomically and refuses to clobber a newer file", () => {
  const { mtimeMs } = readProjectFile(root, "src/a.ts");
  const w = writeProjectFile(root, "src/a.ts", "export const a = 2;\n", mtimeMs);
  expect(w.ok).toBe(true);
  expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("export const a = 2;\n");
  utimesSync(join(root, "src/a.ts"), new Date(), new Date(Date.now() + 5000)); // someone else wrote it
  const c = writeProjectFile(root, "src/a.ts", "mine", w.ok ? w.mtimeMs : 0);
  expect(c).toMatchObject({ ok: false, conflict: true });
  expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("export const a = 2;\n");
});
