import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { AuditLog } from "./audit-log.ts";

const log = () => new AuditLog(openDb(":memory:"));

test("append records entries in order and chains each hash to the previous one", () => {
  const a = log();
  a.append({ agentId: "architect", kind: "tool_call", detail: { tool: "write_file", path: "x.ts" } });
  a.append({ agentId: "architect", kind: "approval", detail: { tool: "shell", ok: true } });

  const rows = a.list();
  expect(rows).toHaveLength(2);
  expect(rows[0]!.prevHash).toBe("0".repeat(64)); // genesis
  expect(rows[1]!.prevHash).toBe(rows[0]!.hash); // chained
  expect(rows[0]!.hash).not.toBe(rows[1]!.hash);
});

test("verify() confirms an untouched chain is intact", () => {
  const a = log();
  for (let i = 0; i < 5; i++) a.append({ agentId: "a", kind: "tool_call", detail: { i } });
  expect(a.verify()).toBe(true);
});

test("verify() detects a tampered row — editing detail after the fact breaks the chain from there", () => {
  const db = openDb(":memory:");
  const a = new AuditLog(db);
  a.append({ agentId: "a", kind: "tool_call", detail: { tool: "shell", command: "ls" } });
  a.append({ agentId: "a", kind: "tool_call", detail: { tool: "shell", command: "pwd" } });
  a.append({ agentId: "a", kind: "tool_call", detail: { tool: "shell", command: "cat x" } });

  // Simulate someone editing row 1's detail directly in the database, after the fact.
  db.query("UPDATE audit_log SET detail = ? WHERE id = 1").run(JSON.stringify({ tool: "shell", command: "rm -rf /" }));

  const result = a.verify();
  expect(result).not.toBe(true);
  expect((result as { brokenAt: number }).brokenAt).toBe(1);
});

test("an empty log verifies as intact", () => {
  expect(log().verify()).toBe(true);
});

test("three processes appending at once keep one intact chain", async () => {
  const db = join(mkdtempSync(join(tmpdir(), "niti-audit-race-")), "niti.db");
  const store = new URL("../store/", import.meta.url).pathname;
  const writer = `const { openDb } = await import("${store}db.ts"); const { AuditLog } = await import("${store}audit-log.ts");
    const log = new AuditLog(openDb(process.argv[1])); for (let i = 0; i < 2000; i++) log.append({ kind: "tool_call", detail: { i } });`;
  const procs = [0, 1, 2].map(() => Bun.spawn(["bun", "-e", writer, db], { stdout: "ignore", stderr: "inherit" }));
  expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0, 0]);
  const log = new AuditLog(openDb(db));
  expect(log.list()).toHaveLength(6000);
  expect(log.verify()).toBe(true); // without the write lock both processes chained onto the same row
});
