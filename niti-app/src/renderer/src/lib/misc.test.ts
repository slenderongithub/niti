import { expect, test } from "bun:test";
import { buildTree, defaultParams, tick, type SimNode } from "../features/graph/physics";
import { buildAgent, sanitize, systemPrompt } from "../features/setup/team";
import { parseUnified, toRows } from "./diff";
import { streaks } from "./stats";
import { fmtApprovalCountdown } from "./format";
import { layoutDag } from "./dag";
import { fmtCost, fmtTokens } from "./format";

test("physics settles a small graph and freezes", () => {
  const nodes: SimNode[] = Array.from({ length: 30 }, (_, i) => ({ id: String(i), x: Math.cos(i) * 50, y: Math.sin(i) * 50, vx: 0, vy: 0, r: 4, pinned: false }));
  const links = Array.from({ length: 29 }, (_, i) => ({ s: i, t: i + 1 }));
  const sim = defaultParams();
  let steps = 0;
  while (tick(nodes, links, sim) && steps < 5000) steps++;
  expect(steps).toBeLessThan(5000);
  expect(sim.alpha).toBe(0);
  for (const n of nodes) expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
});

test("coincident nodes don't blow the quadtree up", () => {
  const nodes: SimNode[] = Array.from({ length: 50 }, (_, i) => ({ id: String(i), x: 1, y: 1, vx: 0, vy: 0, r: 4, pinned: false }));
  expect(buildTree(nodes)!.mass).toBe(50);
});

test("teams are written exactly like the TUI writes them", () => {
  expect(sanitize("Front End!!")).toBe("front-end");
  expect(sanitize("★")).toBe("agent");
  const used = new Set<string>();
  const a = buildAgent({ provider: "anthropic", model: "m", role: "Dev", desc: "Owns it.", lead: true }, used);
  const b = buildAgent({ provider: "openai", model: "m", role: "dev", desc: "" }, used);
  expect([a.id, b.id]).toEqual(["dev", "dev-2"]);
  expect(a.lead).toBe(true);
  expect(b.lead).toBeUndefined();
  expect(a.allowedTools).toEqual(["read_file", "write_file", "edit", "shell"]);
  expect(systemPrompt("Dev", "Owns it.")).toStartWith("You are the Dev. Owns it. Implement your assigned tasks");
});

test("approval diffs parse, and paired rows highlight what changed", () => {
  const h = parseUnified("@@ line 3 @@\n-const a = 1;\n+const a = 2;");
  expect(h[0]!.lines).toEqual([
    { k: "-", t: "const a = 1;", o: 3 },
    { k: "+", t: "const a = 2;", n: 3 },
  ]);
  const rows = toRows(h);
  expect(rows[0]!.hi).toEqual([10, 11]);
  expect(rows[1]!.hi).toEqual([10, 11]);
  expect(parseUnified("@@ -1,2 +1,2 @@\n ctx\n-a\n+b")[0]!.lines[0]).toEqual({ k: " ", t: "ctx", o: 1, n: 1 });
});

test("streaks count consecutive days and forgive an idle today", () => {
  const today = new Date("2026-10-07T12:00:00");
  const days = ["2026-10-04", "2026-10-05", "2026-10-06", "2026-09-01"].map((date) => ({ date, tokens: 10, msgs: 1 }));
  expect(streaks(days, today)).toEqual({ current: 3, longest: 3, activeDays: 4 });
});

test("the DAG lays tasks out by dependency depth, and survives a cycle", () => {
  const t = (id: string, deps: string[] = []) => ({ id, description: id, status: "pending" as const, dependsOn: deps });
  const { pos } = layoutDag([t("a"), t("b", ["a"]), t("c", ["a"]), t("d", ["b", "c"])]);
  expect([pos.get("a")!.depth, pos.get("b")!.depth, pos.get("d")!.depth]).toEqual([0, 1, 2]);
  expect(layoutDag([t("x", ["y"]), t("y", ["x"])]).pos.size).toBe(2);
});

test("numbers read like people say them", () => {
  expect(fmtTokens(950)).toBe("950");
  expect(fmtTokens(12_300)).toBe("12.3k");
  expect(fmtTokens(2_500_000)).toBe("2.5M");
  expect(fmtCost(0.004)).toBe("$0.0040");
  expect(fmtCost(1.5, false)).toBe("$1.50+");
});

test("fmtApprovalCountdown counts minutes and seconds down to the core's deadline", () => {
  expect(fmtApprovalCountdown(undefined)).toBe("");
  expect(fmtApprovalCountdown(1_063_000, 1_000_000)).toContain("in 1:03,");
  expect(fmtApprovalCountdown(999_000, 1_000_000)).toContain("in 0:00,");
});
