import { test, expect } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgents, loadOptions, loadInstructions, loadPermissions, loadMcpServers, saveAgents } from "./config.ts";

function writeYaml(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "amux-cfg-"));
  const path = join(dir, "agents.yaml");
  writeFileSync(path, body);
  return path;
}

test("loads a valid agents.yaml", () => {
  const path = writeYaml(`
agents:
  - id: a
    provider: anthropic
    model: claude-opus-4-8
    role: Architect
    lead: true
    systemPrompt: hi
`);
  const agents = loadAgents(path);
  expect(agents).toHaveLength(1);
  expect(agents[0]).toMatchObject({ id: "a", provider: "anthropic", lead: true });
});

test("throws on missing required field", () => {
  const path = writeYaml(`
agents:
  - id: a
    provider: anthropic
    model: x
    role: r
`); // no systemPrompt
  expect(() => loadAgents(path)).toThrow(/systemPrompt/);
});

test("parses autoApprove into a string list", () => {
  const path = writeYaml(`
agents:
  - id: a
    provider: anthropic
    model: x
    role: r
    systemPrompt: hi
    autoApprove: [read_file, write_file]
`);
  expect(loadAgents(path)[0]?.autoApprove).toEqual(["read_file", "write_file"]);
});

test("parses reviewer into the agent config", () => {
  const path = writeYaml(`
agents:
  - id: a
    provider: anthropic
    model: x
    role: r
    systemPrompt: hi
    reviewer: qa
`);
  expect(loadAgents(path)[0]?.reviewer).toBe("qa");
});

test("throws on unknown provider", () => {
  const path = writeYaml(`
agents:
  - id: a
    provider: cohere
    model: x
    role: r
    systemPrompt: hi
`);
  expect(() => loadAgents(path)).toThrow(/unknown provider/);
});

test("loadOptions reads the top-level knobs, and defaults everything it doesn't find", () => {
  const path = writeYaml(`
theme: nord
auto: true
watch: false
maxTurns: 40
maxAgents: 3
instructions: [AGENTS.md, 12, CLAUDE.md]
agents:
  - id: a
    provider: anthropic
    model: m
    role: r
    systemPrompt: s
`);
  expect(loadOptions(path)).toEqual({
    theme: "nord",
    auto: true,
    watch: false,
    maxTurns: 40,
    maxAgents: 3,
    instructions: ["AGENTS.md", "CLAUDE.md"], // non-strings are dropped, not fatal
    worktree: false,
  });

  const bare = writeYaml(`
agents:
  - id: a
    provider: anthropic
    model: m
    role: r
    systemPrompt: s
`);
  // watch stays undefined (not false) so the caller's own default still wins.
  expect(loadOptions(bare)).toEqual({ theme: undefined, auto: false, watch: undefined, maxTurns: undefined, maxAgents: undefined, instructions: undefined, worktree: false });
  expect(loadOptions(join(tmpdir(), "does-not-exist.yaml"))).toEqual({});
});

test("maxAgents is enforced when the team is loaded", () => {
  const agent = (id: string) => `  - id: ${id}\n    provider: anthropic\n    model: m\n    role: r\n    systemPrompt: s\n`;
  const path = writeYaml(`maxAgents: 1\nagents:\n${agent("a")}${agent("b")}`);
  expect(() => loadAgents(path)).toThrow(/2 agents configured but maxAgents is 1/);
});

test("loadInstructions concatenates the files that exist and skips the ones that don't", () => {
  const dir = mkdtempSync(join(tmpdir(), "amux-inst-"));
  writeFileSync(join(dir, "AGENTS.md"), "  build with bun test  ");
  writeFileSync(join(dir, "EMPTY.md"), "   ");
  const out = loadInstructions(["AGENTS.md", "EMPTY.md", "MISSING.md"], dir);
  expect(out).toContain("build with bun test");
  expect(out).toContain("AGENTS.md");
  expect(out).not.toContain("EMPTY.md"); // a blank file contributes nothing
  expect(loadInstructions([], dir)).toBe("");
});

// The team picker rewrites agents.yaml on every launch. Anything the user hand-wrote next to the
// agents list has to survive that.
test("saveAgents replaces only the agents block", () => {
  const path = writeYaml(`
theme: nord
maxTurns: 40
permissions:
  shell:
    "git *": allow
mcpServers:
  - name: code-review
    command: crg
agents:
  - id: old
    provider: anthropic
    model: m
    role: r
    systemPrompt: s
`);
  saveAgents([{ id: "new", provider: "openai", model: "gpt-4o", role: "Builder", systemPrompt: "s" }], path);

  const agents = loadAgents(path);
  expect(agents).toHaveLength(1);
  expect(agents[0]!.id).toBe("new");
  expect(loadOptions(path)).toMatchObject({ theme: "nord", maxTurns: 40 });
  expect(loadPermissions(path)).toEqual({ shell: { "git *": "allow" } });
  expect(loadMcpServers(path)).toEqual([{ name: "code-review", command: "crg", args: undefined }]);
});
