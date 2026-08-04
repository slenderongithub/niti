import { test, expect } from "bun:test";
import { resolve, parsePermissions, subject, DEFAULT_RULES, AUTO_RULES, type PermissionRules } from "./permissions.ts";

const project: PermissionRules = {
  shell: { "git *": "allow", "git commit *": "ask", "git push --force*": "deny" },
  write_file: { "src/**": "allow", "*": "ask" },
};

test("the most specific pattern wins, not the first that matches", () => {
  const sh = (line: string) => resolve([project], "shell", { command: line.split(" ")[0], args: line.split(" ").slice(1) });
  expect(sh("git status")).toBe("allow");
  expect(sh("git commit -m x")).toBe("ask"); // longer pattern beats "git *"
  expect(sh("git push --force origin main")).toBe("deny");
  expect(sh("npm test")).toBe("ask"); // no rule at all → ask
});

test("path rules keep real glob semantics; a bare '*' still means everything", () => {
  expect(resolve([project], "write_file", { path: "src/deep/a.ts" })).toBe("allow");
  expect(resolve([project], "write_file", { path: "docs/readme.md" })).toBe("ask");
});

test("shell patterns match command lines, not paths — '*' has to cross a slash", () => {
  // Bun.Glob would refuse this (a path '*' never crosses '/'), which is why shell uses wildcards.
  expect(resolve([{ shell: { "rm -rf*": "deny" } }], "shell", { command: "rm", args: ["-rf", "/tmp/x"] })).toBe("deny");
  expect(subject("shell", { command: "rm", args: ["-rf", "/tmp/x"] })).toBe("rm -rf /tmp/x");
  expect(subject("write_file", { path: "a.ts" })).toBe("a.ts");
});

test("an agent's own block overrides the project's", () => {
  const agent: PermissionRules = { shell: { "git commit *": "allow" } };
  const call = { command: "git", args: ["commit", "-m", "x"] };
  expect(resolve([agent, project], "shell", call)).toBe("allow");
  expect(resolve([undefined, project], "shell", call)).toBe("ask");
  // ...but only where it has something to say: unmatched calls fall through to the project layer.
  expect(resolve([agent, project], "shell", { command: "git", args: ["push", "--force"] })).toBe("deny");
});

test("defaults reproduce the old fixed gate: reads free, everything else asks", () => {
  expect(resolve([DEFAULT_RULES], "read_file", { path: "src/a.ts" })).toBe("allow");
  expect(resolve([DEFAULT_RULES], "write_file", { path: "src/a.ts" })).toBe("ask");
  expect(resolve([DEFAULT_RULES], "shell", { command: "ls" })).toBe("ask");
  expect(resolve([DEFAULT_RULES], "mcp__fs__read", {})).toBe("ask");
});

test("--auto allows what isn't denied, and never overrides an explicit project deny", () => {
  const layers = [undefined, project, AUTO_RULES, DEFAULT_RULES];
  expect(resolve(layers, "shell", { command: "npm", args: ["test"] })).toBe("allow");
  expect(resolve(layers, "shell", { command: "git", args: ["push", "--force"] })).toBe("deny");
});

test("an exact-length tie goes to the stricter decision", () => {
  expect(resolve([{ shell: { "a*": "allow", "a?": "deny" } }], "shell", { command: "ab" })).toBe("deny");
});

test("parsePermissions rejects malformed blocks with a pointed message", () => {
  expect(parsePermissions(undefined, "f.yaml")).toBeUndefined();
  expect(parsePermissions({ shell: { "git *": "allow" } }, "f.yaml")).toEqual({ shell: { "git *": "allow" } });
  expect(() => parsePermissions([1], "f.yaml")).toThrow(/must be a mapping/);
  expect(() => parsePermissions({ shell: "allow" }, "f.yaml")).toThrow(/permissions.shell/);
  expect(() => parsePermissions({ shell: { "git *": "maybe" } }, "f.yaml")).toThrow(/allow, ask, deny/);
});

// A deny is worthless if the model can spell its way around it, and an allow is dangerous if the
// model can climb out of it. Both directions resolve to the same file safePath would write to.
test("path subjects are normalized, so ./x and a/../x cannot dodge a rule", () => {
  const deny: PermissionRules = { write_file: { "secret*": "deny" } };
  expect(resolve([deny], "write_file", { path: "secret.txt" })).toBe("deny");
  expect(resolve([deny], "write_file", { path: "./secret.txt" })).toBe("deny");
  expect(resolve([deny], "write_file", { path: "a/../secret.txt" })).toBe("deny");

  // ...and the inverse: an allow scoped to src/** must not cover an escape out of src/.
  const allow: PermissionRules = { write_file: { "src/**": "allow" } };
  expect(resolve([allow], "write_file", { path: "src/api.ts" })).toBe("allow");
  expect(resolve([allow], "write_file", { path: "src/../.amux/agents.yaml" })).not.toBe("allow");

  expect(subject("write_file", { path: "./a/../b.txt" })).toBe("b.txt");
});
