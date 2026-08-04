import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExportReport } from "./export.ts";
import { Engine } from "../engine.ts";
import { openDb } from "../store/db.ts";
import { SessionStore } from "../store/session-store.ts";
import type { Provider } from "../providers/provider.ts";

const stub: Provider = { async send() { return { text: "ok", toolCalls: [] }; } };

test("buildExportReport writes a markdown report covering goal, tasks, cost and transcripts", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-export-"));
  const store = new SessionStore(openDb(":memory:"));
  const engine = new Engine({ configs: [{ id: "a", provider: "anthropic", model: "claude-opus-4-8", role: "r", systemPrompt: "s" }], makeProvider: () => stub, root, store });

  const agent = engine as unknown as { agents: { run: (task: string, opts: { taskId: string }) => Promise<string> }[] };
  await agent.agents[0]!.run("say hi", { taskId: "t1" });
  engine.orch.load([{ id: "t1", description: "say hi", status: "done", role: "a", dependsOn: [] }]);

  const { path, message } = await buildExportReport(engine);
  expect(message).toContain(path);
  const report = readFileSync(path, "utf8");
  expect(report).toContain("# niti session export");
  expect(report).toContain(root);
  expect(report).toContain("t1");
  expect(report).toContain("say hi");
  expect(report).toContain("## Cost");
  expect(report).toContain("## Diff patch");
  expect(report).toContain("not available"); // no worktree isolation in this test
  expect(report).toContain("## Transcripts");
});

test("without a store, /export still writes a report and says transcripts aren't available", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-export-nostore-"));
  const engine = new Engine({ configs: [], makeProvider: () => stub, root });
  engine.orch.load([{ id: "t1", description: "solo task", status: "pending", role: "a", dependsOn: [] }]);

  const { path } = await buildExportReport(engine);
  const report = readFileSync(path, "utf8");
  expect(report).toContain("no stored transcript");
});
