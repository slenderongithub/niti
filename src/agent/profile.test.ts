import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileFor, capInstructions, LOCAL, STANDARD, LOCAL_GUIDANCE } from "./profile.ts";
import { repairJson, parseToolArgs, extractTextToolCalls, checkArgs, unknownToolMessage, closestTool, splitThinking } from "./toolcalls.ts";
import { RepeatGuard } from "./stall.ts";
import { LocalProvider } from "../local/provider.ts";
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

test("text tool calls: a JSON call on its own line after a sentence runs (what Qwen2.5-Coder wrote)", () => {
  const r = extractTextToolCalls('Sure, let\'s start with the first step.\n\n{"name": "read_file", "arguments": {"path": "config/settings.json"}}', NAMES)!;
  expect(r.calls[0]).toMatchObject({ name: "read_file", input: { path: "config/settings.json" } });
  expect(r.rest).toBe("Sure, let's start with the first step.");
  const two = extractTextToolCalls('First this:\n```json\n{"name": "grep", "arguments": {"pattern": "x"}}\n```\nthen:\n{"name": "shell", "arguments": {"command": "ls"}}', NAMES)!;
  expect(two.calls.map((c) => c.name)).toEqual(["grep", "shell"]);
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
      expect([...names].sort()).toEqual(["edit", "finish", "glob", "grep", "read_file", "shell", "todo", "write_file"]);
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
    [() => ({ text: '<tool_call>{"name": "read_file", "arguments": {"path": "a.txt"}}</tool_call>', toolCalls: [] }), () => ({ text: "", toolCalls: [{ id: "f", name: "finish", input: { summary: "It says hello." } }] })],
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

const finishCall = (summary = "made it") => ({ text: "", toolCalls: [{ id: `f${Math.random()}`, name: "finish", input: { summary } }] });
const warningsOf = (bus: Bus) => {
  const w: { payload: string; protocol?: string }[] = [];
  bus.subscribe((e) => (e.type === "warning" || e.type === "thought") && e.protocol && w.push({ payload: String(e.payload), protocol: e.protocol }));
  return w;
};

test("local: a plan in prose is refused, kept out of the history, and the file still gets written", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-profile-"));
  const seen = { tools: [] as string[][], formats: [] as (string | undefined)[], turns: [] as Turn[][] };
  const p = scripted(
    [
      () => ({ text: "To write the menu, I will follow these steps:\n1. List the drinks\n2. Add prices", toolCalls: [] }),
      () => ({ text: "", toolCalls: [{ id: "w", name: "write_file", input: { path: "menu.md", content: "# Coffee\n" } }] }),
      () => finishCall("Created menu.md."),
    ],
    seen,
  );
  const bus = new Bus();
  const events = warningsOf(bus);
  const messages: string[] = [];
  bus.subscribe((e) => e.type === "message" && messages.push(String(e.payload)));
  const cfg: AgentConfig = { ...localCfg, allowedTools: ["read_file", "write_file", "edit", "shell"] };
  const r = await new Agent(cfg, p, bus, { root }).runDetailed("Write the coffee shop's menu to menu.md");
  expect(r.outcome).toBe("done");
  expect(r.text).toBe("Created menu.md.");
  expect(readFileSync(join(root, "menu.md"), "utf8")).toContain("Coffee");
  expect(events.some((w) => w.protocol === "rejected_turn")).toBe(true);
  const history = JSON.stringify(seen.turns[1]);
  expect(history).not.toContain("follow these steps"); // the prose never reached the history…
  expect(messages.join()).not.toContain("follow these steps"); // …or the chat
  expect((seen.turns[1]!.at(-1) as Extract<Turn, { role: "user" }>).text).toContain("call write_file");
});

test("local: a model that never acts fails the task after three refused turns", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-profile-"));
  const seen = { tools: [] as string[][], formats: [] as (string | undefined)[], turns: [] as Turn[][] };
  const r = await new Agent(localCfg, scripted([() => ({ text: "Here's the plan: 1. design 2. build", toolCalls: [] })], seen), new Bus(), { root }).runDetailed("Build it");
  expect(r.outcome).toBe("failed");
  expect(r.error).toContain("never did the work");
  expect(seen.tools.length).toBe(3);
});

test("local: finish before any work, or a second checklist instead of work, is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-profile-"));
  const seen = { tools: [] as string[][], formats: [] as (string | undefined)[], turns: [] as Turn[][] };
  const todo = (n: number) => ({ text: "", toolCalls: [{ id: `t${n}`, name: "todo", input: { items: [{ text: "write it", status: "pending" }] } }] });
  const p = scripted(
    [
      () => finishCall("all done"), // nothing done yet
      () => todo(1), // a first checklist is planning: fine
      () => todo(2), // a second one, still with nothing done, is not
      () => ({ text: "", toolCalls: [{ id: "w", name: "write_file", input: { path: "a.txt", content: "a" } }] }),
      () => finishCall(),
    ],
    seen,
  );
  const bus = new Bus();
  const events = warningsOf(bus);
  const r = await new Agent({ ...localCfg, allowedTools: ["write_file"] }, p, bus, { root }).runDetailed("Write a.txt");
  expect(r.outcome).toBe("done");
  expect(events.filter((w) => w.protocol === "rejected_turn").map((w) => w.payload.split(" — ")[0])).toEqual(["finished without doing anything", "rewrote its checklist instead of working"]);
});

test("local: a file pasted into the reply is saved as the write it meant", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-profile-"));
  const seen = { tools: [] as string[][], formats: [] as (string | undefined)[], turns: [] as Turn[][] };
  const p = scripted([() => ({ text: "Here it is:\n\n`styles.css`\n```css\nbody { font-family: 'Fraunces', serif; }\n```", toolCalls: [] }), () => finishCall()], seen);
  const bus = new Bus();
  const events = warningsOf(bus);
  const r = await new Agent({ ...localCfg, allowedTools: ["write_file"] }, p, bus, { root }).runDetailed("Style the page");
  expect(r.outcome).toBe("done");
  expect(readFileSync(join(root, "styles.css"), "utf8")).toContain("Fraunces");
  expect(events.find((w) => w.protocol === "salvaged")?.payload).toContain("styles.css");
});

test("local: a prose reply on the local engine is asked again with the call required, and only the call is kept", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-profile-"));
  const sent: { next?: unknown; turns: Turn[] }[] = [];
  const replies = [
    { text: "I'll write the server now. It will use express and listen on 3000.", toolCalls: [] },
    { text: "", toolCalls: [{ id: "w", name: "write_file", input: { path: "notes.txt", content: "x" } }] },
    { text: "", toolCalls: [{ id: "f", name: "finish", input: { summary: "wrote notes.txt" } }] },
  ];
  const fake = Object.create(LocalProvider.prototype) as LocalProvider;
  fake.send = async function (_s: string, turns: Turn[]) {
    sent.push({ next: this.next, turns: structuredClone(turns) });
    this.next = undefined;
    return replies[sent.length - 1]!;
  };
  const r = await new Agent({ ...localCfg, allowedTools: ["write_file"] }, fake, new Bus(), { root }).runDetailed("Write notes.txt");
  expect(r.outcome).toBe("done");
  expect(sent[1]!.next).toMatchObject({ toolChoice: "required", thinking: false });
  expect(JSON.stringify(sent[2]!.turns)).not.toContain("express"); // the prose reply never entered the history
  expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("x");
});

test("cloud: a text answer to a task is still an answer", async () => {
  const seen = { tools: [] as string[][], formats: [] as (string | undefined)[], turns: [] as Turn[][] };
  const r = await new Agent(cloudCfg, scripted([() => ({ text: "Nothing to change: it already does that.", toolCalls: [] })], seen), new Bus(), { root: mkdtempSync(join(tmpdir(), "niti-profile-")) }).runDetailed("Check it");
  expect(r.outcome).toBe("done");
  expect(seen.tools.length).toBe(1);
});

test("local: an empty reply after the work is done counts as finishing", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-profile-"));
  const seen = { tools: [] as string[][], formats: [] as (string | undefined)[], turns: [] as Turn[][] };
  const p = scripted([() => ({ text: "", toolCalls: [{ id: "w", name: "write_file", input: { path: "notes.txt", content: "x" } }] }), () => ({ text: "", toolCalls: [] })], seen);
  const r = await new Agent({ ...localCfg, allowedTools: ["write_file"] }, p, new Bus(), { root }).runDetailed("Write notes.txt");
  expect(r.outcome).toBe("done");
  expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("x");
});

test("files pasted into a reply are saved when they're labelled, and left alone when they aren't", async () => {
  const { salvageFiles } = await import("./toolcalls.ts");
  const text = "Here's the page.\n\n**index.html**\n```html\n<!DOCTYPE html>\n<html><body><h1>Bean There</h1></body></html>\n```\n\nAnd the styles:\n```css\n/* styles.css */\nbody { font-family: 'Fraunces', serif; color: #2b1b12; }\n```\n\nSome code without a name:\n```js\nconsole.log('where would this go?')\n```";
  const calls = salvageFiles(text);
  expect(calls.map((c) => c.input.path)).toEqual(["index.html", "styles.css"]);
  expect(String(calls[0]!.input.content)).toContain("Bean There");
  expect(salvageFiles("Use `npm start` to run it.\n```\nnpm start\n```")).toEqual([]);
});

test("local: niti checks the work before 'done' — a bare page is sent back, and the fixed one passes", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-profile-"));
  const seen = { tools: [] as string[][], formats: [] as (string | undefined)[], turns: [] as Turn[][] };
  const html = '<!doctype html><html lang="en"><head><title>Bean There</title><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="styles.css"></head><body><h1>Bean There</h1></body></html>';
  const goodCss = ":root{--a:#3b2416;--b:#f6efe6;--c:#c8743a}\nbody{font-family:'Inter',sans-serif;background:var(--b)}\n" + Array.from({ length: 26 }, (_, i) => `.s${i}{padding:${i}px}`).join("\n") + "\na:hover{color:var(--c)}\n@media (max-width:700px){.s1{padding:0}}";
  const write = (path: string, content: string) => () => ({ text: "", toolCalls: [{ id: path + content.length, name: "write_file", input: { path, content } }] });
  const p = scripted([write("index.html", html), write("styles.css", "body{font-family:Arial;color:#333}"), () => finishCall("Built the page."), write("styles.css", goodCss), () => finishCall("Styled it.")], seen);
  const bus = new Bus();
  const checks: { ok: boolean }[][] = [];
  bus.subscribe((e) => e.protocol === "checks" && checks.push(e.checks!));
  const r = await new Agent({ ...localCfg, allowedTools: ["write_file"] }, p, bus, { root }).runDetailed("make a stunning landing page for Bean There");
  expect(r.outcome).toBe("done");
  expect(checks.length).toBe(2);
  expect(checks[0]!.some((c) => !c.ok)).toBe(true);
  expect(checks[1]!.every((c) => c.ok)).toBe(true);
  expect((seen.turns[3]!.at(-1) as Extract<Turn, { role: "user" }>).text).toContain("The page uses Arial");
});

test("local: work that never passes a must-check ends unverified, with the reasons", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-profile-"));
  const seen = { tools: [] as string[][], formats: [] as (string | undefined)[], turns: [] as Turn[][] };
  let n = 0;
  const p = scripted([() => (n++ % 2 === 0 ? { text: "", toolCalls: [{ id: `w${n}`, name: "write_file", input: { path: "index.html", content: '<html><body><h1>Shop</h1><script src="missing.js"></script></body></html>' } }] } : finishCall())], seen);
  const r = await new Agent({ ...localCfg, allowedTools: ["write_file"] }, p, new Bus(), { root }).runDetailed("make a landing page");
  expect(r.outcome).toBe("unverified");
  expect(r.error).toContain("missing.js");
});

test("a call whose JSON a small model broke — unescaped quotes, real newlines — is still read", async () => {
  const { extractTextToolCalls } = await import("./toolcalls.ts");
  const params = { write_file: ["path", "content"], finish: ["summary"] };
  const html = '<!DOCTYPE html>\n<html lang="en">\n<head><link rel="stylesheet" href="styles.css"></head>\n</html>\n';
  const broken = `{\n  "name": "write_file",\n  "arguments": {\n    "path": "index.html",\n    "content": "${html}"\n  }\n}`;
  const r = extractTextToolCalls(broken, ["write_file", "finish"], params)!;
  expect(r.calls[0]).toMatchObject({ name: "write_file", input: { path: "index.html", content: html } });
  // Escapes the model did write are undone; a call wrapped in <tool_call> is read the same way.
  const css = 'body {\n  font-family: \\"Inter\\";\n}';
  expect(extractTextToolCalls(`<tool_call>\n{"name": "write_file", "arguments": {"path": "a.css", "content": "${css}"}}\n</tool_call>`, ["write_file"], params)!.calls[0]!.input.content).toBe('body {\n  font-family: "Inter";\n}');
  // Prose that merely mentions a call shape is not one.
  expect(extractTextToolCalls('I would call {"name": "write_file" with the "path" set.', ["write_file"], params)).toBeUndefined();
});
