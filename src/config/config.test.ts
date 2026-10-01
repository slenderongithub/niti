import { test, expect } from "bun:test";
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgents, loadOptions, loadInstructions, loadPermissions, loadMcpServers, saveAgents, setTheme, isHomeDir } from "./config.ts";

function writeYaml(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "niti-cfg-"));
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
  const dir = mkdtempSync(join(tmpdir(), "niti-inst-"));
  writeFileSync(join(dir, "AGENTS.md"), "  build with bun test  ");
  writeFileSync(join(dir, "EMPTY.md"), "   ");
  const out = loadInstructions(["AGENTS.md", "EMPTY.md", "MISSING.md"], dir);
  expect(out).toContain("build with bun test");
  expect(out).toContain("AGENTS.md");
  expect(out).not.toContain("EMPTY.md"); // a blank file contributes nothing
  expect(loadInstructions([], dir)).toBe("");
});

test("loadInstructions can discover the project's own AGENTS.md / .niti.md, without doubling a listed one", () => {
  const dir = mkdtempSync(join(tmpdir(), "niti-inst-"));
  writeFileSync(join(dir, "AGENTS.md"), "agents rules");
  expect(loadInstructions([], dir, true)).toContain("agents rules");
  expect(loadInstructions(["AGENTS.md"], dir, true).match(/agents rules/g)).toHaveLength(1);
  writeFileSync(join(dir, ".niti.md"), "niti rules"); // .niti.md wins the search
  const out = loadInstructions([], dir, true);
  expect(out).toContain("niti rules");
  expect(out).not.toContain("agents rules");
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

test("saving config preserves comments and unrecognised keys", () => {
  // The picker runs on every launch and the theme carousel writes on every keypress — so a
  // parse→stringify round-trip meant a user who documented their roster lost every comment the
  // first time they cycled a colour scheme. This is the file niti tells people to hand-edit.
  const dir = mkdtempSync(join(tmpdir(), "niti-doc-"));
  const path = join(dir, "agents.yaml");
  writeFileSync(
    path,
    [
      "# my team, do not delete",
      "agents:",
      "  - id: a",
      "    provider: anthropic",
      "    model: m",
      "    role: A",
      "    systemPrompt: s",
      "",
      "# keep the shell locked down",
      "permissions:",
      '  shell: { "rm -rf*": deny }',
      "somethingNitiDoesNotKnow: keepme",
      "",
    ].join("\n"),
  );

  saveAgents([{ id: "b", provider: "openai", model: "m2", role: "B", systemPrompt: "s2" }], path);
  const after = readFileSync(path, "utf8");

  expect(after).toContain("# my team, do not delete");
  expect(after).toContain("# keep the shell locked down");
  expect(after).toContain("somethingNitiDoesNotKnow: keepme");
  expect(loadAgents(path).map((a) => a.id)).toEqual(["b"]); // and the roster really was replaced
  expect(loadPermissions(path)).toEqual({ shell: { "rm -rf*": "deny" } });

  setTheme("neon graveyard", path);
  const themed = readFileSync(path, "utf8");
  expect(themed).toContain("# my team, do not delete"); // survives the carousel too
  expect(loadOptions(themed.includes("theme") ? path : path).theme).toBe("neon graveyard");
});

test("an auto-discovered AGENTS.md is capped, a deliberately listed one is not", () => {
  const dir = mkdtempSync(join(tmpdir(), "niti-inst-"));
  writeFileSync(join(dir, "AGENTS.md"), "x".repeat(100_000));
  expect(loadInstructions([], dir, true).length).toBeLessThan(40_000); // resent on every call, nobody opted in
  expect(loadInstructions(["AGENTS.md"], dir, true).length).toBeGreaterThan(100_000);
});

test("isHomeDir sees through a symlinked $HOME", () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), "niti-home-")));
  const link = real + "-link";
  symlinkSync(real, link);
  expect(isHomeDir(real, link)).toBe(true); // cwd is always a real path; $HOME may not be
  expect(isHomeDir(join(real, "sub"), link)).toBe(false);
});

test("an empty agents.yaml does not crash the loaders", () => {
  const path = writeYaml("");
  expect(loadMcpServers(path)).toEqual([]);
  expect(loadOptions(path)).toBeDefined();
});

test("setTheme refuses to overwrite an agents.yaml that is not valid YAML", () => {
  const body = "agents: [\n  - broken: {";
  const path = writeYaml(body);
  expect(() => setTheme("dark", path)).toThrow(/not valid YAML/);
  expect(readFileSync(path, "utf8")).toBe(body);
});


