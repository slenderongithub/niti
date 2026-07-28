import { test, expect } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgents } from "./config.ts";

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
