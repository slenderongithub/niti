// Acceptance checks: what niti looks at before a local agent's task counts as done, in place of the
// model's own word for it. A small model says "done, with media queries" over 1.4 KB of Arial; these
// read the files and run the server instead. Deterministic and model-independent: the same files get
// the same verdict whichever model wrote them.
//
// Two grades. A **must** failure (a linked file that doesn't exist, a page with no styling, placeholder
// copy, the business's name missing, a server that doesn't start) leaves the task unverified once the
// rounds run out. A **quality** failure (no palette of its own, default fonts, no media query, no hover
// states, too little CSS for what was asked) goes back to the agent the same way, but if it is still
// failing at the end the task finishes with the list shown, not hidden.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, extname, join, normalize } from "node:path";
import { wrap } from "../sandbox.ts";

export interface AcceptCheck {
  name: string; // what was checked, in a few words ("linked files exist")
  ok: boolean;
  detail?: string; // what's wrong, naming the file
  grade: "must" | "quality";
}

export interface AcceptResult {
  ok: boolean; // nothing failed
  checks: AcceptCheck[];
}

export interface AcceptInput {
  task: string; // the task text (a local task carries the whole request with it)
  written: string[]; // project-relative paths this run wrote
  sandbox?: boolean;
  signal?: AbortSignal;
}

// A split task's own part: "<line>\n\n(Part of the request: …)" or "<goal>\n\nYour part: …" (planner.ts).
// The whole request decides the look and the name; only the own part decides who builds the server.
export function ownPart(task: string): string {
  const i = task.indexOf("\n\nYour part: ");
  if (i >= 0) return task.slice(i + 13);
  const j = task.indexOf("\n\n(Part of the request: ");
  return j >= 0 ? task.slice(0, j) : task;
}

// The integration task the local planner adds (planner.ts withIntegration) checks the whole project.
export const isIntegration = (task: string) => task.startsWith("Check that the parts your teammates built fit together");

const UI_WORDS = /\b(landing|page|pages|site|website|html|css|style|styles|styling|design|ui|frontend|front-end|stunning|beautiful|layout|portfolio)\b/i;
const RICH_WORDS = /\b(landing|stunning|beautiful|modern|premium|polished|gorgeous|attractive|elegant|professional|sleek|amazing|awesome)\b/i;
const DEPLOY_WORDS = /\b(deploy|deployment|deployable|production|host|hosting|end[- ]to[- ]end|ship)\b/i;
const CODE_FILE = /\.(m?js|cjs|ts|py)$/;
// A server is told by what it does, not its name: a page's own script is often app.js or main.js.
const SERVES = /\.listen\(|createServer\(|express\(\)|Fastify\(|new Hono|Bun\.serve\(|Flask\(|FastAPI\(|uvicorn\.run|app\.run\(|http\.server|socketserver/;
const SKIP_DIRS = new Set(["node_modules", ".git", ".niti", "dist", "build", ".next", "vendor", "__pycache__", ".venv", "venv"]);

const PLACEHOLDERS: [RegExp, string][] = [
  [/lorem ipsum/i, "Lorem ipsum"],
  [/\b(your|company|business|brand|shop|store) name\b/i, "a 'Your/Company Name' placeholder"],
  [/\byour (company|business|brand|logo)\b/i, "'Your Company'"],
  [/\b(menu |product |item |service |feature )?item \d\b|\b(product|service|feature|dish|drink) \d\b/i, "numbered stand-ins (Item 1, Product 2…)"],
  [/\b123[-. ]456[-. ]7890\b|\(?555\)?[-. ]?555[-. ]?\d{4}/, "a fake phone number"],
  [/\b(info|contact|hello)@(example|yourdomain|domain|email)\.com\b|\bexample\.com\b/i, "an example.com address"],
  [/\bTODO\b|\bFIXME\b|\bplaceholder text\b|\[insert [^\]]*\]|\{\{\s*\w+\s*\}\}/, "a TODO or [insert …] left in"],
  [/123 (main|fake|example) st(reet)?/i, "a placeholder street address"],
];

const DEFAULT_FONTS = new Set(["arial", "helvetica", "helvetica neue", "sans-serif", "serif", "monospace", "times", "times new roman", "verdana", "system-ui", "-apple-system", "blinkmacsystemfont", "segoe ui", "roboto", "tahoma", "courier", "courier new", "inherit", "initial", "cursive", "ui-sans-serif", "ui-serif"]);

const read = (root: string, rel: string): string | undefined => {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return undefined;
  }
};

// Project files by extension, bounded: depth 4, 400 files, never into dependency or build folders.
function projectFiles(root: string, exts: string[], max = 400): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || out.length >= max) return;
    let names: string[];
    try {
      names = readdirSync(join(root, dir));
    } catch {
      return;
    }
    for (const n of names) {
      if (SKIP_DIRS.has(n) || n.startsWith(".")) continue;
      const rel = dir ? `${dir}/${n}` : n;
      let st;
      try {
        st = statSync(join(root, rel));
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(rel, depth + 1);
      else if (exts.includes(extname(n).toLowerCase())) out.push(rel);
      if (out.length >= max) return;
    }
  };
  walk("", 0);
  return out;
}

// The business or product the request names: "for Bean There", "called Bean There", "named …", or
// a quoted name. Undefined when it names none — then there is nothing to look for.
export function businessName(task: string): string | undefined {
  const request = task.includes("(Part of the request: ") ? task.slice(task.indexOf("(Part of the request: ")) : task;
  const word = "[A-Z][\\w'’&.-]*";
  const name = `(${word}(?:\\s+(?:${word}|&|and|of|the|de|la)){0,3})`;
  for (const re of [new RegExp(`\\b(?:called|named|brand(?:ed)?(?: as)?)\\s+["“']?${name}`), new RegExp(`["“]${name}["”]`), new RegExp(`\\bfor\\s+${name}`)]) {
    const m = re.exec(request);
    const n = m?.[1]?.replace(/[.,'’]+$/, "").trim();
    if (n && n.length >= 3 && !/^(Mac|macOS|Windows|Linux|Me|It|This|That|The|A|An|My|Our|Your)$/i.test(n)) return n;
  }
  return undefined;
}

const tags = (html: string, tag: string) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "gi"))].map((m) => m[0]);
const attr = (tagText: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tagText)?.slice(1).find((x) => x !== undefined);
const isLocalRef = (u: string) => !!u && !/^(https?:|\/\/|data:|mailto:|tel:|javascript:|#|\{\{|\$\{|blob:)/i.test(u.trim());
const textOf = (html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

interface Page {
  rel: string;
  html: string;
  css: string; // linked local stylesheets plus <style> blocks
  cssFiles: string[];
}

function loadPage(root: string, rel: string): Page {
  const html = read(root, rel) ?? "";
  const dir = dirname(rel);
  const cssFiles: string[] = [];
  let css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  for (const t of tags(html, "link")) {
    if (!/stylesheet/i.test(attr(t, "rel") ?? "")) continue;
    const href = attr(t, "href");
    if (!href || !isLocalRef(href)) continue;
    const f = normalize(join(dir, href.split(/[?#]/)[0]!.replace(/^\//, ""))).replace(/^(\.\/)+/, "");
    cssFiles.push(f);
    css += `\n${read(root, f) ?? ""}`;
  }
  return { rel, html, css, cssFiles };
}

// `withCss`: measure the stylesheet too (once per stylesheet, not once per page that links it).
function pageChecks(root: string, page: Page, task: string, checks: AcceptCheck[], withCss: boolean): void {
  const { rel, html, css } = page;
  // Every local file the page links exists.
  const missing: string[] = [];
  for (const [tag, a] of [["link", "href"], ["script", "src"], ["img", "src"], ["source", "src"], ["a", "href"]] as const) {
    for (const t of tags(html, tag)) {
      const u = attr(t, a);
      if (!u || !isLocalRef(u)) continue;
      const path = u.split(/[?#]/)[0]!;
      if (!path || path.endsWith("/")) continue;
      if (tag === "a" && !/\.(html?|css|js|png|jpe?g|svg|webp|gif|pdf)$/i.test(path)) continue; // a route, not a file
      const f = normalize(join(dirname(rel), path.replace(/^\//, "")));
      if (!existsSync(join(root, f)) && !(path.startsWith("/") && existsSync(join(root, "public", path)))) missing.push(path);
    }
  }
  checks.push({ name: `${rel}: linked files exist`, ok: missing.length === 0, grade: "must", detail: missing.length ? `${rel} links ${[...new Set(missing)].join(", ")}, which ${missing.length > 1 ? "don't" : "doesn't"} exist. Create ${missing.length > 1 ? "them" : "it"}, or fix the link.` : undefined });

  // Real copy, not stand-ins.
  const text = textOf(html);
  const found = PLACEHOLDERS.filter(([re]) => re.test(text) || re.test(html.replace(/<script[\s\S]*?<\/script>/gi, ""))).map(([, what]) => what);
  checks.push({ name: `${rel}: real content, no placeholders`, ok: found.length === 0, grade: "must", detail: found.length ? `${rel} still has ${found.join(", ")}. Write the real thing: names, prices, an address and contact details that fit the request.` : undefined });

  const name = businessName(task);
  if (name) {
    const has = text.toLowerCase().includes(name.toLowerCase());
    checks.push({ name: `${rel}: names ${name}`, ok: has, grade: "must", detail: has ? undefined : `The request is for "${name}", but ${rel} never says "${name}". Use the name in the title, the header and the copy.` });
  }

  const titled = /<title>\s*\S[\s\S]*?<\/title>/i.test(html);
  const lang = /<html[^>]*\blang\s*=/i.test(html);
  const h1 = tags(html, "h1").length;
  const basics = [!titled && "no <title>", !lang && "no lang on <html>", h1 === 0 && "no <h1>", h1 > 1 && `${h1} <h1>s (keep one)`].filter(Boolean) as string[];
  checks.push({ name: `${rel}: title, lang, one <h1>`, ok: basics.length === 0, grade: "quality", detail: basics.length ? `${rel} has ${basics.join(", ")}.` : undefined });

  // Styling: some, then enough for what was asked.
  const styled = css.trim().length > 0 || /\sstyle\s*=/.test(html) || /cdn\.tailwindcss|tailwind/i.test(html);
  checks.push({ name: `${rel}: is styled`, ok: styled, grade: "must", detail: styled ? undefined : `${rel} has no styling at all: no stylesheet linked and no <style>. Write a stylesheet and link it in the <head>.` });
  if (!styled || !withCss || /tailwind/i.test(html)) return; // utility classes: the CSS lives in the markup, nothing to measure
  const rich = RICH_WORDS.test(task);
  const source = page.cssFiles.length ? page.cssFiles.join(", ") : `${rel}'s <style>`;

  const rules = (css.match(/\{/g) ?? []).length;
  const wanted = rich ? 25 : 10;
  checks.push({ name: "enough CSS for the design asked for", ok: rules >= wanted, grade: "quality", detail: rules >= wanted ? undefined : `${source} has ${rules} rules — too little for ${rich ? "a polished landing page" : "a styled page"}. Style every section: header, hero, each content section, cards, buttons, footer.` });

  const colours = new Set((css.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)/gi) ?? []).map((c) => c.toLowerCase()).filter((c) => !/^#(f{3}|f{6}|0{3}|0{6}|333|333333|222|222222|444|444444|666|666666|999|999999|ccc|cccccc|eee|eeeeee|ddd|dddddd)$/.test(c)));
  const vars = (css.match(/--[\w-]+\s*:/g) ?? []).length;
  const palette = colours.size >= 3 || (vars >= 3 && colours.size >= 2);
  checks.push({ name: "a palette of its own", ok: palette, grade: "quality", detail: palette ? undefined : `${source} uses ${colours.size ? `only ${[...colours].slice(0, 3).join(", ")}` : "only black, white and greys"}. Give it a palette that fits the request: 3–5 colours as CSS variables in :root (e.g. --espresso, --cream, --accent), used for backgrounds, text, buttons and borders.` });

  const families = [...css.matchAll(/font-family\s*:\s*([^;}]+)/gi)].flatMap((m) => m[1]!.split(",").map((f) => f.trim().replace(/^["']|["']$/g, "").toLowerCase()));
  const ownFont = families.some((f) => f && !DEFAULT_FONTS.has(f) && !f.startsWith("var("));
  const fontVar = families.some((f) => f.startsWith("var(")) && /--[\w-]*font[\w-]*\s*:\s*["']?(?!arial|helvetica|sans-serif|system-ui)[a-z]/i.test(css);
  const fontLink = /fonts\.googleapis|fonts\.bunny|@font-face|@import url/i.test(html + css);
  const fonted = ownFont || fontVar || fontLink;
  checks.push({ name: "its own fonts", ok: fonted, grade: "quality", detail: fonted ? undefined : `The page uses ${families[0] ? families[0].replace(/^./, (c) => c.toUpperCase()) : "the browser's default font"} — the default look. Load a font pair (e.g. Google Fonts: <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600&family=Inter:wght@400;600&display=swap" rel="stylesheet">) and set them on body and headings.` });

  if (rich || /responsive|mobile/i.test(task)) {
    const media = /@media[^{]*\(\s*(max|min)-width/i.test(css);
    const viewport = /<meta[^>]+name\s*=\s*["']viewport/i.test(html);
    const resp = media && viewport;
    checks.push({ name: "works on a phone", ok: resp, grade: "quality", detail: resp ? undefined : `${[!media && `${source} has no @media query`, !viewport && `${rel} has no <meta name="viewport">`].filter(Boolean).join(" and ")}. Add them so the layout stacks on narrow screens (e.g. @media (max-width: 720px) { … }).` });
    const hover = /:hover/.test(css);
    checks.push({ name: "hover and focus states", ok: hover, grade: "quality", detail: hover ? undefined : `${source} has no :hover styles. Give links, buttons and cards hover and :focus-visible states.` });
  }
}

// Paths the page's scripts fetch, and the routes the server defines, for the integration check.
const fetchPaths = (js: string) => [...js.matchAll(/fetch\(\s*[`'"]([^`'"]+)[`'"]/g)].map((m) => m[1]!).filter((u) => u.startsWith("/") && !u.startsWith("//"));
const routePaths = (src: string) => [
  ...[...src.matchAll(/\b(?:app|router|server|api)\.(?:get|post|put|patch|delete|all|use|route)\(\s*[`'"](\/[^`'"]*)[`'"]/g)].map((m) => m[1]!),
  ...[...src.matchAll(/@(?:app|router|bp|api)\.(?:get|post|put|patch|delete|route)\(\s*['"](\/[^'"]*)['"]/g)].map((m) => m[1]!),
  ...[...src.matchAll(/(?:url|pathname)\s*===?\s*['"`](\/[^'"`]*)['"`]/g)].map((m) => m[1]!),
];
const routeMatches = (route: string, path: string) => new RegExp(`^${route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\:\w+|:\w+|<[^>]+>|\\\{[^}]+\\\}/g, "[^/]+")}/?$`).test(path.split("?")[0]!);

// The server the project runs on, and how to start it: package.json's start script, else a server file.
function startCommand(root: string, written: string[]): { cmd: string; args: string[]; label: string; source: string } | undefined {
  const pkgText = read(root, "package.json");
  let pkg: { scripts?: Record<string, string>; main?: string } | undefined;
  try {
    pkg = pkgText ? JSON.parse(pkgText) : undefined;
  } catch {
    pkg = undefined;
  }
  const candidates = [...new Set([...written.filter((f) => CODE_FILE.test(f)), ...projectFiles(root, [".js", ".mjs", ".cjs", ".py"], 60).filter((f) => !f.includes("/") || /^(src|server|api|backend)\//.test(f))])];
  const listens = candidates.find((f) => SERVES.test(read(root, f) ?? ""));
  if (pkg?.scripts?.start) return { cmd: "npm", args: ["start", "--silent"], label: "npm start", source: listens ?? pkg.main ?? "package.json" };
  if (!listens) return undefined;
  return listens.endsWith(".py") ? { cmd: "python3", args: [listens], label: `python3 ${listens}`, source: listens } : { cmd: "node", args: [listens], label: `node ${listens}`, source: listens };
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

// Start it (inside the sandbox, no network but this Mac), wait for it to answer, ask it the routes
// that matter, stop it.
async function serverChecks(root: string, written: string[], task: string, sandbox: boolean, checks: AcceptCheck[], signal?: AbortSignal): Promise<void> {
  const start = startCommand(root, written);
  const own = ownPart(task);
  const wantsServer = /\b(server|api|backend|endpoint|express|flask|fastapi|package\.json|start script)\b/i.test(own) || DEPLOY_WORDS.test(own);
  if (!start) {
    if (wantsServer && (written.some((f) => CODE_FILE.test(f)) || isIntegration(task))) {
      const has = existsSync(join(root, "package.json"));
      checks.push({ name: "a server that starts", ok: false, grade: "must", detail: `There's no way to start the server: ${has ? "package.json has no \"start\" script" : "no package.json with a \"start\" script"} and no server file that listens on a port. Add one (e.g. "scripts": { "start": "node server.js" }).` });
    }
    return;
  }
  const port = await freePort();
  const src = read(root, start.source) ?? "";
  const literal = [...src.matchAll(/(?:listen\(|PORT\s*\|\|\s*|port\s*[=:]\s*)(\d{4,5})/g)].map((m) => Number(m[1]));
  const ports = [port, ...new Set(literal)].slice(0, 4);
  const w = sandbox ? wrap(root, start.cmd, start.args, false) : { command: start.cmd, args: start.args };
  const child = spawn(w.command, w.args, { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: "production" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let exited: number | null | undefined;
  child.stdout?.on("data", (d) => (out = (out + d).slice(-4000)));
  child.stderr?.on("data", (d) => (out = (out + d).slice(-4000)));
  child.on("exit", (code) => (exited = code));
  child.on("error", (e) => ((out += String(e)), (exited = -1)));
  const stop = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  try {
    let live: number | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && exited === undefined && !live && !signal?.aborted) {
      for (const p of ports) {
        try {
          await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(800) });
          live = p;
          break;
        } catch {
          // not yet
        }
      }
      if (!live) await Bun.sleep(300);
    }
    if (!live) {
      const tail = out.trim().split("\n").slice(-6).join("\n");
      const missingModule = /Cannot find module '([^']+)'|ModuleNotFoundError: No module named '([^']+)'/.exec(out);
      checks.push({
        name: "the server starts",
        ok: false,
        grade: "must",
        detail: `\`${start.label}\` ${exited !== undefined ? `exited (code ${exited})` : "didn't answer on a port within 10 seconds"}${tail ? `:\n${tail}` : "."}` +
          (missingModule ? `\nIts dependencies aren't installed: run \`${start.source.endsWith(".py") ? `pip install ${missingModule[2]}` : "npm install"}\` (the user is asked to approve it), or use only built-in modules.` : `\nIt must listen on process.env.PORT (default 3000).`),
      });
      return;
    }
    checks.push({ name: "the server starts", ok: true, grade: "must" });
    // The site's front page, when there is one to serve.
    const site = ["index.html", "public/index.html"].find((f) => existsSync(join(root, f)));
    if (site) {
      const r = await fetch(`http://127.0.0.1:${live}/`, { signal: AbortSignal.timeout(3000) }).catch(() => undefined);
      const ok = !!r && r.status < 400 && /<html|<!doctype/i.test(await r.text());
      checks.push({ name: "the server serves the site", ok, grade: "must", detail: ok ? undefined : `\`${start.label}\` is up, but GET / answers ${r ? r.status : "nothing"} instead of ${site}. Serve the site's files (e.g. express.static, or read and send ${site}).` });
    }
    // The routes the task names ("a /menu endpoint", "GET /api/orders") answer.
    const named = [...new Set([...task.matchAll(/(?:^|[\s"'`(])(\/(?:api\/)?[a-z][\w-]*(?:\/[\w-]+)*)(?=$|[\s"'`),.])/gi)].map((m) => m[1]!).filter((p) => !/\.\w+$/.test(p)))].slice(0, 6);
    const broken: string[] = [];
    for (const p of named) {
      const r = await fetch(`http://127.0.0.1:${live}${p}`, { signal: AbortSignal.timeout(3000) }).catch(() => undefined);
      if (!r || r.status === 404 || r.status >= 500) broken.push(`${p} → ${r ? r.status : "no answer"}`);
    }
    if (named.length) checks.push({ name: "the routes the task names answer", ok: !broken.length, grade: "must", detail: broken.length ? `GET ${broken.join(", ")}. Add ${broken.length > 1 ? "these routes" : "this route"} to ${start.source}.` : undefined });
  } finally {
    stop();
  }
}

export async function acceptWork(root: string, input: AcceptInput): Promise<AcceptResult> {
  const { task, written } = input;
  const integration = isIntegration(task);
  const checks: AcceptCheck[] = [];

  // Pages: the ones this run wrote, the ones that link a stylesheet it wrote, or every page when
  // checking how the parts fit.
  const htmlAll = projectFiles(root, [".html", ".htm"]);
  const wroteCss = written.filter((f) => /\.css$/i.test(f));
  let pages = written.filter((f) => /\.html?$/i.test(f));
  if (integration) pages = htmlAll;
  else if (wroteCss.length) for (const h of htmlAll) if (!pages.includes(h) && wroteCss.some((c) => loadPage(root, h).cssFiles.includes(c))) pages.push(h);
  if (pages.length && (UI_WORDS.test(task) || integration)) {
    const seenCss = new Set<string>();
    for (const rel of pages.slice(0, 8)) {
      const page = loadPage(root, rel);
      const key = page.cssFiles.join(",") || rel;
      pageChecks(root, page, task, checks, !seenCss.has(key));
      seenCss.add(key);
    }
  } else if (wroteCss.length && !pages.length && UI_WORDS.test(task) && !htmlAll.length) {
    checks.push({ name: "a page uses the stylesheet", ok: false, grade: "quality", detail: `${wroteCss.join(", ")} isn't linked from any page yet. If a teammate writes the page, tell them its name with send_message.` });
  }

  // The server: when this run wrote one (or its package.json), when it's the integration pass, or when
  // the request was for something deployable and this run wrote code.
  const own = ownPart(task);
  const wroteServer = written.some((f) => f === "package.json" || (CODE_FILE.test(f) && SERVES.test(read(root, f) ?? "")));
  if (wroteServer || integration || (/\b(server|api|backend|deploy\w*)\b/i.test(own) && written.some((f) => /\.(m?js|cjs|ts|py|json)$/.test(f)))) {
    await serverChecks(root, written, task, input.sandbox ?? false, checks, input.signal);
  }

  // How the parts meet: what the page fetches, the server routes.
  if (integration || (wroteServer && pages.length)) {
    const code = projectFiles(root, [".js", ".mjs", ".cjs", ".ts", ".py"], 80).map((f) => read(root, f) ?? "");
    const js = code.filter((src) => !SERVES.test(src));
    const inline = htmlAll.map((h) => [...(read(root, h) ?? "").matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n"));
    const fetched = [...new Set([...js, ...inline].flatMap(fetchPaths))];
    const serverSrc = code.filter((src) => SERVES.test(src) || /\b(?:router|app)\.(?:get|post)\(/.test(src)).join("\n");
    const routes = routePaths(serverSrc);
    if (fetched.length && routes.length) {
      const unmatched = fetched.filter((p) => !routes.some((r) => routeMatches(r, p)));
      checks.push({ name: "the page's requests match the server's routes", ok: !unmatched.length, grade: "must", detail: unmatched.length ? `The page fetches ${unmatched.join(", ")}, but the server only has ${[...new Set(routes)].join(", ")}. Make them match.` : undefined });
    }
  }

  // Deployment-ready, when asked for: a way to start it and the steps written down.
  if (DEPLOY_WORDS.test(integration ? task : own)) {
    const readme = projectFiles(root, [".md"], 40).find((f) => /^readme\.md$/i.test(f));
    const text = readme ? (read(root, readme) ?? "") : "";
    const steps = /npm (start|run)|node \S+|python3? \S+|docker (build|run)|bun (run|start)|npx /i.test(text);
    checks.push({ name: "run and deploy steps in the README", ok: steps, grade: "quality", detail: steps ? undefined : `${readme ? `${readme} doesn't say how to run it` : "There's no README.md"}. Write how to install, run (e.g. \`npm install && npm start\`) and deploy it.` });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

// What the agent is told when checks fail: each failure, naming the file, then what to do.
export function acceptMessage(r: AcceptResult): string {
  const failing = r.checks.filter((c) => !c.ok);
  return (
    `[niti checked the work. It isn't done yet:\n${failing.map((c) => `- ${c.detail ?? c.name}`).join("\n")}\n\n` +
    `Fix these with edit or write_file (read_file first to see what's there), then call finish again.]`
  );
}
