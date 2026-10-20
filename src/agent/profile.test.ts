import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileFor, capInstructions, LOCAL, STANDARD, LOCAL_GUIDANCE } from "./profile.ts";
import { repairJson, parseToolArgs, extractTextToolCalls, checkArgs, unknownToolMessage, closestTool, splitThinking } from "./toolcalls.ts";
import { RepeatGuard } from "./stall.ts";
import { Agent, type AgentConfig } from "./agent.ts";
import { Bus } from "../events/bus.ts";
import { TOOL_GUIDANCE } from "../tools/tools.ts";
import type { Provider, ToolSpec, Turn } from "../providers/provider.ts";

// ---- choosing a profile ------------------------------------------------------------------------

test("models on this Mac get the local profile; cloud and custom endpoints the standard one", () => {
  expect(profileFor({ provider: "local" })).toBe(LOCAL);
  expect(profileFor({ provider: "ollama" })).toBe(LOCAL);
  expect(profileFor({ provider: "lmstudio" })).toBe(LOCAL);
  expect(profileFor({ provider: "anthropic" })).toBe(STANDARD);
  expect(profileFor({ provider: "custom" })).toBe(STANDARD);
  expect(profileFor({ provider: "custom", profile: "local" })).toBe(LOCAL);
  expect(profileFor({ provider: "local", profile: "standard" })).toBe(STANDARD);
});

test("the standard profile is exactly what every agent had before profiles", () => {
  expect(STANDARD.guidance).toBe(TOOL_GUIDANCE);
  expect(STANDARD).toMatchObject({ warnRatio: 0.85, compactRatio: 0.95, maxResultChars: 60_000, maskHighWater: 30_000, dropTools: [], mcpBlanket: true, forks: true, textToolCalls: false, jsonAsks: false });
  expect(STANDARD.repeatGuard).toBeUndefined();
  expect(capInstructions("x".repeat(100_000), STANDARD.instructionsMax).length).toBe(100_000);
});

test("local guidance keeps the shared conventions in far fewer words, and drops batching and forks", () => {
  expect(LOCAL_GUIDANCE.length).toBeLessThan(TOOL_GUIDANCE.length * 0.75);
  for (const rule of ["inside the project", "grep", "read_file", "oldString", "tests", "Never edit, skip or delete a test"]) expect(LOCAL_GUIDANCE).toContain(rule);
  expect(LOCAL_GUIDANCE).not.toContain("spawn_fork");
  expect(LOCAL_GUIDANCE).toContain("one tool call at a time");
});

test("capInstructions cuts at a line and says where the rest is", () => {
  const text = Array.from({ length: 400 }, (_, i) => `rule ${i}: something`).join("\n");
  const cut = capInstructions(text, 2000);
  expect(cut.length).toBeLessThan(2300);
  expect(cut).toContain("read it with read_file");
  expect(cut.split("\n\n[…")[0]!.endsWith("something")).toBe(true);
});

// ---- tool-call repair --------------------------------------------------------------------------

test("repairJson fixes what models get wrong without changing what valid JSON means", () => {
  expect(repairJson('```json\n{"path": "a.ts",}\n```')).toEqual({ path: "a.ts" });
  expect(repairJson("{'path': 'a.ts'}")).toEqual({ path: "a.ts" });
  expect(repairJson('{"all": True, "x": None}')).toEqual({ all: true, x: null });
  expect(repairJson('{"path": "a.ts"')).toEqual({ path: "a.ts" });
  expect(repairJson("not json at all")).toBeUndefined();
  expect(parseToolArgs('{"a":1}')).toEqual({ input: { a: 1 } });
  expect(parseToolArgs("[1,2]").error).toContain("object");
  expect(parseToolArgs("{oops").error).toContain("not valid JSON");
  expect(parseToolArgs("")).toEqual({ input: {} });
});

const NAMES = ["read_file", "write_file", "edit", "shell", "grep"];

test("text tool calls: Hermes <tool_call>, Qwen3-Coder <function=>, and a reply that is only a JSON call", () => {
  const hermes = extractTextToolCalls('Let me look.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "src/a.ts"}}\n</tool_call>', NAMES)!;
  expect(hermes.calls.map((c) => [c.name, c.input])).toEqual([["read_file", { path: "src/a.ts" }]]);
  expect(hermes.rest).toBe("Let me look.");
  const coder = extractTextToolCalls("<function=edit>\n<parameter=path>\na.ts\n</parameter>\n<parameter=replaceAll>\ntrue\n</parameter>\n</function>", NAMES)!;
  expect(coder.calls[0]).toMatchObject({ name: "edit", input: { path: "a.ts", replaceAll: true } });
  // Exactly what Qwen2.5-Coder-14B-Instruct-MLX-4bit wrote through mlx-lm's server.
  const qwen25 = extractTextToolCalls('<function>\n{"name": "read_file", "arguments": {"path": "src/a.ts"}}\n</function>', NAMES)!;
  expect(qwen25.calls[0]).toMatchObject({ name: "read_file", input: { path: "src/a.ts" } });
  expect(qwen25.rest).toBe("");
  const whole = extractTextToolCalls('```json\n{"name": "shell", "parameters": {"command": "bun", "args": ["test"]}}\n```', NAMES)!;
  expect(whole.calls[0]).toMatchObject({ name: "shell", input: { command: "bun", args: ["test"] } });
  expect(whole.rest).toBe("");
});

test("text tool calls: unknown names and JSON inside prose are left alone", () => {
  expect(extractTextToolCalls('<tool_call>{"name": "launch_rockets", "arguments": {}}</tool_call>', NAMES)).toBeUndefined();
  expect(extractTextToolCalls('The API takes {"name": "shell", "arguments": {}} as its body, see the docs.', NAMES)).toBeUndefined();
  expect(extractTextToolCalls("All done — the tests pass.", NAMES)).toBeUndefined();
});

test("checkArgs names a missing or mistyped argument; unknown tools get the nearest real one", () => {
  const spec: ToolSpec = { name: "read_file", description: "", parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" } }, required: ["path"] } };
  expect(checkArgs(spec, {})).toContain("needs 'path'");
  expect(checkArgs(spec, { path: { nested: true } })).toContain("'path' must be a string");
  expect(checkArgs(spec, { path: "a", offset: 1.5 })).toContain("integer");
  expect(checkArgs(spec, { path: "a", offset: [2] })).toContain("integer");
  expect(checkArgs(spec, { path: "a", offset: 2 })).toBeUndefined();
  // What the tools already coerce is not an error.
  expect(checkArgs(spec, { path: "a", offset: "12" })).toBeUndefined();
  expect(checkArgs(spec, { path: 3 })).toBeUndefined();
  expect(closestTool("readfile", NAMES)).toBe("read_file");
  expect(closestTool("deploy", NAMES)).toBeUndefined();
  expect(unknownToolMessage("Read_File", NAMES)).toContain("Did you mean 'read_file'?");
});

test("splitThinking separates inline thinking from the answer", () => {
  expect(splitThinking("<think>a</think>\nB")).toEqual({ thinking: "a", answer: "B" });
  expect(splitThinking("<think>still going")).toEqual({ thinking: "still going", answer: "" });
  expect(splitThinking("a</think>B", true)).toEqual({ thinking: "a", answer: "B" });
  expect(splitThinking("a</think>B")).toEqual({ thinking: "", answer: "a</think>B" });
});

// ---- repeat guard ------------------------------------------------------------------------------

test("RepeatGuard nudges at the third identical call, stops at the fifth, and catches A-B-A-B", () => {
  const g = new RepeatGuard(3, 5);
  const call = (name: string, input: Record<string, unknown>) => [{ id: crypto.randomUUID(), name, input }];
  expect(g.observe(call("read_file", { path: "a", offset: 1 }))).toBe("ok");
  expect(g.observe(call("read_file", { offset: 1, path: "a" }))).toBe("ok"); // key order doesn't matter
  expect(g.observe(call("read_file", { path: "a", offset: 1 }))).toBe("nudge");
  expect(g.observe(call("read_file", { path: "a", offset: 1 }))).toBe("ok"); // nudged once only
  expect(g.observe(call("read_file", { path: "a", offset: 1 }))).toBe("stop");
  const ab = new RepeatGuard(3, 5);
  const verdicts = ["a", "b", "a", "b", "a", "b"].map((p) => ab.observe(call("read_file", { path: p })));
  expect(verdicts).toContain("nudge");
  expect(new RepeatGuard(3, 5).observe([...call("grep", { pattern: "x" }), ...call("grep", { pattern: "y" })])).toBe("ok");
});

// ---- the agent loop under each profile ---------------------------------------------------------

function scripted(replies: ((tools: ToolSpec[], turns: Turn[]) => Awaited<ReturnType<Provider["send"]>>)[], seen: { tools: string[][]; formats: (string | undefined)[]; turns: Turn[][] }): Provider {
  let i = 0;
  return {
    async send(_s, turns, tools, _d, _sig, _think, format) {
      seen.tools.push(tools.map((t) => t.name));
      seen.formats.push(format);
      seen.turns.push(structuredClone(turns));
      return replies[Math.min(i++, replies.length - 1)]!(tools, turns);
    },
  };
}

const ALL = ["read_file", "write_file", "edit", "shell", "mcp"];
const localCfg: AgentConfig = { id: "l", provider: "local", model: "a/b-GGUF:Q4_K_M", role: "r", systemPrompt: "s", allowedTools: ALL };
const cloudCfg: AgentConfig = { ...localCfg, id: "c", provider: "anthropic", model: "claude-x" };

test("a local agent is offered the short tool list; a cloud agent the full one", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-profile-"));
  for (const c of [localCfg, cloudCfg]) {
    const seen = { tools: [] as string[][], formats: [] as (string | undefined)[], turns: [] as Turn[][] };
    await new Agent(c, scripted([() => ({ text: "done", toolCalls: [] })], seen), new Bus(), { root }).run("hi");
    const names = seen.tools[0]!;
    if (c === localCfg) {
      expect([...names].sort()).toEqual(["edit", "glob", "grep", "read_file", "shell", "todo", "write_file"]);
      for (const n of ["list_dir", "repo_map", "spawn_fork"]) expect(names).not.toContain(n);
    } else {
      for (const n of ["list_dir", "repo_map", "spawn_fork", "todo"]) expect(names).toContain(n);
    }
  }
});

test("local: a tool call written as text runs as a real call and enters the history as one", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-profile-"));
  writeFileSync(join(root, "a.txt"), "hello from a\n");
  const seen = { tools: [] as string[][], formats: [] as (string | undefined)[], turns: [] as Turn[][] };
  const p = scripted(
    [() => ({ text: '<tool_call>{"name": "read_file", "arguments": {"path": "a.txt"}}</tool_call>', toolCalls: [] }), () => ({ text: "It says hello.", toolCalls: [] })],
    seen,
  );
  expect(await new Agent(localCfg, p, new Bus(), { root }).run("read a.txt")).toBe("done");
  const second = seen.turns[1]!;
  const assistant = second.find((t) => t.role === "assistant") as Extract<Turn, { role: "assistant" }>;
  expect(assistant.toolCalls[0]).toMatchObject({ name: "read_file", input: { path: "a.txt" } });
  const tool = second.find((t) => t.role === "tool") as Extract<Turn, { role: "tool" }>;
  expect(tool.results[0]!.output).toContain("hello from a");
});

test("cloud: text that looks like a call is left as the answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-profile-"));
  const seen = { tools: [] as string[][], formats: [] as (string | undefined)[], turns: [] as Turn[][] };
  const p = scripted([() => ({ text: '<tool_call>{"name": "read_file", "arguments": {"path": "a.txt"}}</tool_call>', toolCalls: [] })], seen);
  expect(await new Agent(cloudCfg, p, new Bus(), { root }).run("x")).toBe("done");
  expect(seen.tools.length).toBe(1);
});

test("a malformed call, a made-up tool and a missing argument are each answered with what to fix", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-profile-"));
  const seen = { tools: [] as string[][], formats: [] as (string | undefined)[], turns: [] as Turn[][] };
  const p = scripted(
    [
      () => ({
        text: "",
        toolCalls: [
          { id: "1", name: "read_file", input: {}, parseError: "arguments were not valid JSON (Unexpected EOF)" },
          { id: "2", name: "readfile", input: { path: "a" } },
          { id: "3", name: "read_file", input: {} },
        ],
      }),
      () => ({ text: "ok", toolCalls: [] }),
    ],
    seen,
  );
  await new Agent(cloudCfg, p, new Bus(), { root }).run("x");
  const results = (seen.turns[1]!.find((t) => t.role === "tool") as Extract<Turn, { role: "tool" }>).results.map((r) => r.output);
  expect(results[0]).toContain("not valid JSON");
  expect(results[1]).toContain("Did you mean 'read_file'?");
  expect(results[2]).toContain("needs 'path'");
});

test("local: the same call five times ends the run as exhausted, after one nudge", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-profile-"));
  writeFileSync(join(root, "a.txt"), "x\n");
  const seen = { tools: [] as string[][], formats: [] as (string | undefined)[], turns: [] as Turn[][] };
  let n = 0;
  const p = scripted([() => ({ text: "", toolCalls: [{ id: String(n++), name: "grep", input: { pattern: "nothing-here" } }] })], seen);
  const bus = new Bus();
  const warnings: string[] = [];
  bus.subscribe((e) => e.type === "warning" && warnings.push(String(e.payload)));
  const r = await new Agent(localCfg, p, bus, { root }).runDetailed("find it");
  expect(r.outcome).toBe("exhausted");
  expect(r.error).toContain("same arguments 5 times");
  expect(warnings.some((w) => w.includes("change course"))).toBe(true);
  expect(seen.tools.length).toBe(5);
});

test("asks that expect JSON are constrained for a local lead, left alone for a cloud one", async () => {
  for (const [c, want] of [[localCfg, "json"], [cloudCfg, undefined]] as const) {
    const seen = { tools: [] as string[][], formats: [] as (string | undefined)[], turns: [] as Turn[][] };
    await new Agent(c, scripted([() => ({ text: "{}", toolCalls: [] })], seen), new Bus()).ask("plan", { json: true });
    expect(seen.formats[0]).toBe(want);
    await new Agent(c, scripted([() => ({ text: "prose", toolCalls: [] })], seen), new Bus()).ask("debate");
    expect(seen.formats[1]).toBeUndefined();
  }
});
