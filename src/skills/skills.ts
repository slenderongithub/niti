import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

// Claude-Code-style skills: each .amux/skills/<name>/SKILL.md has YAML frontmatter (name, description).
// We surface the descriptions in the system prompt; the agent reads the full file (via read_file) on demand.
export interface Skill {
  name: string;
  description: string;
  path: string;
}

export function loadSkills(dir = ".amux/skills"): Skill[] {
  if (!existsSync(dir)) return [];
  const skills: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name, "SKILL.md");
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf8");
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    const fm = (m ? (parse(m[1]!) ?? {}) : {}) as Record<string, unknown>;
    skills.push({
      name: typeof fm.name === "string" ? fm.name : entry.name,
      description: typeof fm.description === "string" ? fm.description : "",
      path,
    });
  }
  return skills;
}

export function skillsPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description} (read ${s.path} for full instructions)`);
  return `\n\nAvailable skills — read the file when a task calls for it:\n${lines.join("\n")}`;
}
