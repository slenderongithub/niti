import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "../engine.ts";
import type { Task } from "../orchestrator/task.ts";
import type { Turn } from "../providers/provider.ts";
import { costOf } from "../providers/pricing.ts";
import { resumeConversation } from "../session.ts";
import { diffPatch } from "../orchestrator/worktree.ts";

// /export: a session audit report built entirely from data the engine already tracks (tasks,
// stored transcripts, usage, the worktree diff when isolation is on) — no new tracking added
// just to fill out a report. Kept out of registry.ts because it's the first command doing real
// formatting work rather than a one-line read of engine state.

function taskLine(t: Task): string {
  const box = t.status === "done" ? "[x]" : t.status === "failed" ? "[!]" : "[ ]";
  const deps = t.dependsOn?.length ? ` _(depends on ${t.dependsOn.join(", ")})_` : "";
  return `- ${box} **${t.id}** (${t.role ?? t.assignedTo ?? "unassigned"}) — ${t.description}${deps}`;
}

function renderTurn(t: Turn): string {
  if (t.role === "user") return `> **user:** ${t.text}`;
  if (t.role === "assistant") {
    const lines = t.text ? [`> **assistant:** ${t.text}`] : [];
    for (const c of t.toolCalls) {
      const { diff, ...rest } = c.input as Record<string, unknown> & { diff?: unknown };
      lines.push(`> - \`${c.name}\`(${JSON.stringify(rest)})`);
      if (typeof diff === "string" && diff) lines.push("```diff\n" + diff + "\n```");
    }
    return lines.join("\n");
  }
  return t.results.map((r) => `> - \`${r.name}\` → ${r.output.slice(0, 300).replace(/\n/g, " ")}`).join("\n");
}

// Best-effort only: nothing in amux runs or tracks test suites. This scans task text for
// pass/fail-shaped language and says so plainly rather than presenting it as a verified result.
const FAIL_RE = /\b(\d+\s+failed|tests?\s+failed|✗|failing|failure)\b/i;
const PASS_RE = /\b(\d+\s+passed|all tests pass|tests?\s+passed|✓|passing)\b/i;
function selfReportedTestStatus(t: Task): string {
  const text = `${t.output ?? ""} ${t.acceptance ?? ""}`;
  if (FAIL_RE.test(text)) return "possibly failing (self-reported, not verified)";
  if (PASS_RE.test(text)) return "possibly passing (self-reported, not verified)";
  return "unknown";
}

export async function buildExportReport(engine: Engine): Promise<{ path: string; message: string }> {
  const tasks = engine.orch.all;
  const lines: string[] = [
    "# amux session export",
    "",
    `**Project:** ${engine.root}`,
    `**Goal:** ${engine.lastGoal || "(none submitted this session)"}`,
    "",
    "## Tasks",
    "",
  ];
  lines.push(...(tasks.length ? tasks.map(taskLine) : ["(no tasks)"]), "");

  lines.push("## Cost", "");
  let total = 0;
  let complete = true;
  for (const { agentId, usage } of engine.usage.snapshot()) {
    const cfg = engine.configs.find((c) => c.id === agentId);
    if (!cfg) continue;
    const { usd, priced } = costOf(cfg.provider, cfg.model, usage.inputTokens, usage.outputTokens);
    total += usd;
    if (!priced) complete = false;
    lines.push(`- ${agentId}: ${usage.inputTokens}in ${usage.outputTokens}out — $${usd.toFixed(4)}${priced ? "" : " (unpriced)"}`);
  }
  lines.push("", `**Total:** $${total.toFixed(4)}${complete ? "" : "+"}`, "");

  lines.push("## Diff patch", "");
  if (engine.worktreeHandle) {
    const patch = await diffPatch(engine.worktreeHandle);
    lines.push(patch ? "```diff\n" + patch + "\n```" : "(worktree isolation was on, but nothing changed)");
  } else {
    lines.push("_not available — this session didn't run with worktree isolation (`--worktree`)_");
  }
  lines.push("");

  lines.push("## Test status (best-effort)", "");
  lines.push(...(tasks.length ? tasks.map((t) => `- **${t.id}**: ${selfReportedTestStatus(t)}`) : ["(no tasks)"]), "");

  lines.push("## Transcripts", "");
  for (const t of tasks) {
    lines.push(`### ${t.id} — ${t.description}`, "");
    const turns = engine.store ? resumeConversation(engine.store, t.id) : [];
    lines.push(...(turns.length ? turns.map(renderTurn) : ["_(no stored transcript — was this session run without a store?)_"]), "");
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(engine.root, ".amux", "reports");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${stamp}.md`);
  writeFileSync(path, lines.join("\n"));
  return { path, message: `wrote ${path}` };
}
