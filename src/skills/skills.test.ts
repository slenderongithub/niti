import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills, skillsPrompt } from "./skills.ts";

function makeSkillsDir(): string {
  const root = mkdtempSync(join(tmpdir(), "amux-skills-"));
  const dir = join(root, "skills");
  mkdirSync(join(dir, "testing"), { recursive: true });
  writeFileSync(
    join(dir, "testing", "SKILL.md"),
    "---\nname: testing\ndescription: How to write tests here\n---\nFull instructions…",
  );
  mkdirSync(join(dir, "nofm"), { recursive: true });
  writeFileSync(join(dir, "nofm", "SKILL.md"), "no frontmatter body");
  return dir;
}

test("loads skills, parsing frontmatter and falling back to the dir name", () => {
  const dir = makeSkillsDir();
  const skills = loadSkills(dir);
  const testing = skills.find((s) => s.name === "testing")!;
  expect(testing.description).toBe("How to write tests here");
  const nofm = skills.find((s) => s.name === "nofm")!;
  expect(nofm.description).toBe(""); // no frontmatter → empty description, name from dir
});

test("loadSkills returns [] when the dir is absent; skillsPrompt is empty then", () => {
  expect(loadSkills("/does/not/exist")).toEqual([]);
  expect(skillsPrompt([])).toBe("");
});

test("skillsPrompt lists each skill with its file path", () => {
  const text = skillsPrompt([{ name: "testing", description: "d", path: ".amux/skills/testing/SKILL.md" }]);
  expect(text).toContain("testing: d");
  expect(text).toContain(".amux/skills/testing/SKILL.md");
});
