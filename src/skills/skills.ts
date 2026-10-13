import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

// Claude-Code-style skills: each .niti/skills/<name>/SKILL.md has YAML frontmatter (name, description).
// We surface the descriptions in the system prompt; the agent reads the full file (via read_file) on demand.
interface Skill {
  name: string;
  description: string;
  path: string;
}

// A skill's (or a custom command's — see commands/registry.ts) YAML frontmatter and the text after it.
// Either line ending: a file saved on Windows has \r\n, and a \n-only match read it as having no
// frontmatter at all — no name, no description, and a command whose prompt began with the YAML.
// parse() throws on malformed YAML; callers skip that one file.
export function frontmatter(raw: string): { fm: Record<string, unknown>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  return { fm: (m ? (parse(m[1]!) ?? {}) : {}) as Record<string, unknown>, body: (m ? raw.slice(m[0].length) : raw).trim() };
}

export function loadSkills(dir = ".niti/skills"): Skill[] {
  if (!existsSync(dir)) return [];
  const skills: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name, "SKILL.md");
    if (!existsSync(path)) continue;
    // Same posture as .niti/commands/*.md: one hand-edited file with a stray `[` must cost you
    // that skill, not the whole engine. parse() throws on malformed YAML and this runs during
    // startup, so it used to surface as a bare YAMLParseError with no filename.
    try {
      const { fm } = frontmatter(readFileSync(path, "utf8"));
      skills.push({
        name: typeof fm.name === "string" ? fm.name : entry.name,
        description: typeof fm.description === "string" ? fm.description : "",
        path,
      });
    } catch (err) {
      console.error(`niti: skipping ${path}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return skills;
}

export function skillsPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description} (read ${s.path} for full instructions)`);
  return `\n\nAvailable skills — read the file when a task calls for it:\n${lines.join("\n")}`;
}
