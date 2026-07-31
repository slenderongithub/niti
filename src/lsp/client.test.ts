import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient, hoverText, languageId } from "./client.ts";
import { LspRegistry } from "./registry.ts";
import { runLspTool, lspToolSpecs, formatDiagnostics } from "../tools/lsp-tools.ts";

const FAKE = new URL("./fake-server.ts", import.meta.url).pathname;
const fakeServer = { name: "fake", command: process.execPath, args: [FAKE], extensions: [".ts"] };

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "amux-lsp-"));
  writeFileSync(join(root, "a.ts"), "const a = 1;\nconst b: string = 2;\n");
  return root;
}

test("diagnostics come back from a live server, converted to 1-based positions", async () => {
  const root = project();
  const client = new LspClient(process.execPath, [FAKE], root);
  const diags = await client.diagnostics(join(root, "a.ts"));
  expect(diags).toEqual([{ line: 2, column: 5, severity: "error", message: "type error", source: "fake" }]);
  client.stop();
});

test("hover translates 1-based tool coordinates to LSP's 0-based positions", async () => {
  const root = project();
  const client = new LspClient(process.execPath, [FAKE], root);
  expect(await client.hover(join(root, "a.ts"), 2, 7)).toBe("hover at 1:6");
  client.stop();
});

test("a second call re-syncs the file and still resolves (didChange path)", async () => {
  const root = project();
  const client = new LspClient(process.execPath, [FAKE], root);
  await client.diagnostics(join(root, "a.ts"));
  writeFileSync(join(root, "a.ts"), "const a = 1;\nconst b: string = 3;\n");
  expect(await client.diagnostics(join(root, "a.ts"))).toHaveLength(1);
  client.stop();
});

test("a missing server binary is an error string, not a crash", async () => {
  const root = project();
  const registry = new LspRegistry([{ name: "nope", command: "amux-no-such-language-server", extensions: [".ts"] }], root);
  const out = await runLspTool(registry, "diagnostics", { path: "a.ts" }, root);
  expect(out).toMatch(/language server unavailable/);
  registry.close();
});

test("the registry maps extensions to servers and reuses one process per language", () => {
  const registry = new LspRegistry([fakeServer], project());
  expect(registry.configured).toBe(true);
  const a = registry.clientFor("/x/one.ts");
  expect(registry.clientFor("/x/two.ts")).toBe(a!); // shared: diagnostics are project-global
  expect(registry.clientFor("/x/main.go")).toBeUndefined();
  registry.close();
});

test("the tool reports an unconfigured language instead of failing", async () => {
  const root = project();
  const registry = new LspRegistry([fakeServer], root);
  expect(await runLspTool(registry, "diagnostics", { path: "main.go" }, root)).toMatch(/no language server configured/);
  registry.close();
});

test("tool paths are jailed to the project root like every other tool", async () => {
  const root = project();
  const registry = new LspRegistry([fakeServer], root);
  await expect(runLspTool(registry, "diagnostics", { path: "../../etc/passwd" }, root)).rejects.toThrow(/escapes project root/);
  registry.close();
});

test("specs are only offered when a server is configured", () => {
  expect(lspToolSpecs(undefined)).toEqual([]);
  expect(lspToolSpecs(new LspRegistry([], "."))).toEqual([]);
  expect(lspToolSpecs(new LspRegistry([fakeServer], ".")).map((s) => s.name)).toEqual(["diagnostics", "hover"]);
});

test("diagnostics format readably, and 'clean' says so", () => {
  expect(formatDiagnostics("a.ts", [])).toBe("a.ts: no diagnostics");
  expect(formatDiagnostics("a.ts", [{ line: 2, column: 5, severity: "error", message: "bad", source: "tsc" }])).toBe("a.ts:2:5 error: bad (tsc)");
});

test("hoverText flattens every LSP contents shape", () => {
  expect(hoverText("plain")).toBe("plain");
  expect(hoverText({ kind: "markdown", value: "md" })).toBe("md");
  expect(hoverText(["a", { value: "b" }])).toBe("a\nb");
  expect(hoverText(null)).toBe("");
});

test("languageId maps by extension and falls back to plaintext", () => {
  expect(languageId("a.ts")).toBe("typescript");
  expect(languageId("main.go")).toBe("go");
  expect(languageId("LICENSE")).toBe("plaintext");
});
