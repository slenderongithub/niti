// Quality briefs: what "done well" means for the common kinds of task, said concretely enough for a
// 7–14B model to act on, and added to a local agent's task when its words call for one. A frontier
// model knows a landing page needs a palette, a font pair and a hero; a small one writes Arial on
// white unless told. Each brief pairs with the acceptance checks (accept.ts) that hold the work to it.
//
// A project overrides one by writing .niti/skills/<name>/SKILL.md (the body replaces the built-in),
// the same folder its own skills live in.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { frontmatter } from "../skills/skills.ts";
import { isIntegration, ownPart } from "./accept.ts";

interface Brief {
  name: string;
  when: RegExp; // the words of a task's own part that call for it
  text: string;
}

export const BRIEFS: Brief[] = [
  {
    name: "web-page",
    when: /\b(landing|page|pages|site|website|html|css|style|styles|styling|design|ui|frontend|front-end|layout|portfolio|hero)\b/i,
    text: `Make the page look designed, not default (niti checks this):
- Palette: 3-5 colours that fit the subject, as CSS variables in :root (a coffee shop: espresso, cream, caramel). Use them for backgrounds, text, buttons and borders; no plain #333 on white.
- Fonts: a pair from Google Fonts linked in <head>: a display font for headings (Playfair Display, Fraunces, DM Serif Display) and a clean one for text (Inter, DM Sans, Outfit).
- Hero: a full-height first section with a gradient or image background, the name in a large <h1>, one line of copy and a clear call-to-action button.
- Sections: each with a heading and generous padding on one spacing scale (8, 16, 24, 48, 96px); cards in a CSS grid.
- Responsive: <meta name="viewport" content="width=device-width, initial-scale=1"> and @media (max-width: 720px) rules that stack the grid.
- States: :hover and :focus-visible on links, buttons and cards, with 150-250ms transitions.
- Content: real copy using the business name: real-sounding items with prices, opening hours, an address. No Lorem ipsum, "Item 1", 123-456-7890 or example.com.
- Files: index.html links styles.css (and script.js, if any) by exactly those names.`,
  },
  {
    name: "server-api",
    when: /\b(server|api|endpoint|endpoints|backend|back-end|express|route|routes)\b/i,
    text: `Build the server so it runs as-is (niti starts it to check):
- Node: server.js with built-in modules only (http, fs, path) unless the task names a framework, so there is nothing to install. Listen on process.env.PORT || 3000.
- Serve the site too: index.html at /, and styles.css, script.js and images with the right content-type. If a teammate makes the pages, serve their files; don't write them.
- JSON routes under /api/ returning real data that fits the request. The page must fetch exactly these paths.
- package.json with "scripts": { "start": "node server.js" }.
- Unknown paths get a 404; a bad request gets an error reply, never a crash.`,
  },
  {
    name: "deploy",
    when: /\b(deploy|deployment|deployable|production|host|hosting|end[- ]to[- ]end|ship|launch)\b/i,
    text: `Make it deployable:
- package.json: a name, "scripts": { "start": "node server.js" }, "engines": { "node": ">=18" }.
- README.md: what it is; how to run it (npm install && npm start, then open http://localhost:3000); how to deploy it (any Node host with start command npm start, e.g. Render, Railway or Fly; a site with no server can go on any static host).
- A Dockerfile only if asked: node:20-alpine, COPY, EXPOSE 3000, CMD ["npm", "start"].`,
  },
  {
    name: "tests",
    when: /\b(test|tests|testing|spec|specs|coverage)\b/i,
    text: `Tests:
- Use the project's runner if it has one (package.json "test", pytest); otherwise node:test.
- One test per behaviour, named for what it checks. Run them with shell. Make them pass by fixing the code, never by weakening a test.`,
  },
  {
    name: "cli",
    when: /\b(cli|command[- ]line|terminal (tool|app)|argv)\b/i,
    text: `Command-line tool:
- --help prints usage; a wrong argument prints usage to stderr and exits non-zero; success exits 0.
- Input from arguments or stdin; results to stdout, errors to stderr.`,
  },
];

// The briefs a task calls for, by its own part (a teammate's slice of a split request isn't handed
// the server brief because the whole request mentions deployment). The integration task gets the
// ones the whole request calls for, since it checks every part.
export function briefsFor(task: string, root?: string): { name: string; text: string }[] {
  const words = isIntegration(task) ? task : ownPart(task);
  return BRIEFS.filter((b) => b.when.test(words)).map((b) => ({ name: b.name, text: override(root, b.name) ?? b.text }));
}

function override(root: string | undefined, name: string): string | undefined {
  if (!root) return undefined;
  const f = join(root, ".niti", "skills", name, "SKILL.md");
  if (!existsSync(f)) return undefined;
  try {
    return frontmatter(readFileSync(f, "utf8")).body || undefined;
  } catch {
    return undefined;
  }
}

// The task as a local agent first reads it: the task, then the briefs it calls for.
export function withBriefs(task: string, root?: string): string {
  const briefs = briefsFor(task, root);
  return briefs.length ? `${task}\n\n${briefs.map((b) => b.text).join("\n\n")}` : task;
}
