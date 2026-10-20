// The web, for agents: read a page (web_fetch), look a fact up in a public registry (lookup), and —
// once the user has saved a Tavily key — search (web_search). The first two need no account. They run
// in the core, not the shell sandbox, and every call is approved by the user, --auto or not (see
// NETWORK_TOOLS in agent.ts): fetching is how data leaves this Mac as much as how it arrives.
//
// web_fetch only reaches public addresses. A model told by a README to fetch http://169.254.169.254
// or http://localhost:8080/admin is the textbook way an agent gets turned against the machine it
// runs on; names are resolved first and private, loopback and link-local answers refused — on every
// redirect hop too.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ToolSpec } from "../providers/provider.ts";
import { getCredential, resolveApiKey } from "../auth/auth-store.ts";

export const WEB_TOOLS = new Set(["web_fetch", "lookup", "web_search"]);
// `web` in allowedTools grants all three (web_search still only once a key is saved).
export const WEB_ALIAS = "web";

const DEFAULT_MAX = 12_000;
const MAX_BYTES = 3 * 1024 * 1024;
const UA = "niti (+https://github.com/slenderbuilds/niti)";

export interface WebDeps {
  fetch: typeof fetch;
  resolve: (host: string) => Promise<string[]>; // host → its addresses
}

const defaultDeps: WebDeps = {
  fetch,
  resolve: async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address),
};

// ---- the Tavily key ----------------------------------------------------------------------------

// Saved with the other credentials (auth.json / the keychain), under "tavily". Never sent to a phone:
// /auth answers are redacted, and the bridge doesn't forward /auth at all.
export function tavilyKey(): string | undefined {
  const k = resolveApiKey("tavily");
  if (k) return k;
  if (process.env.NITI_AUTH_FILE) return undefined; // a test store is hermetic
  return process.env.TAVILY_API_KEY || undefined;
}

// Cheap enough to ask every turn (a file read, no keychain call): whether to offer web_search.
export function webSearchConfigured(): boolean {
  return getCredential("tavily") !== undefined || (!process.env.NITI_AUTH_FILE && !!process.env.TAVILY_API_KEY);
}

// ---- address checks ----------------------------------------------------------------------------

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::1" || s === "::") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith("ff");
  }
  return true; // not an address at all: refuse rather than guess
}

async function checkUrl(raw: string, deps: WebDeps): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`not a URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`only http and https URLs can be fetched, not ${u.protocol}`);
  if (u.username || u.password) throw new Error("URLs with credentials in them are not fetched");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : await deps.resolve(host).catch(() => {
    throw new Error(`could not resolve ${host}`);
  });
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new Error(`${host} is a private or local address — web_fetch only reaches the public internet`);
  return u;
}

// ---- HTML → readable markdown --------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, ""));

// What a reader would keep of a page: its main content as markdown, without the scripts, menus,
// footers and cookie banners that are most of a modern page's bytes. Readability-style, by tag:
// the page's <main> or <article> when it has one, else the body with its chrome removed.
export function htmlToMarkdown(html: string, base?: string): { title: string; markdown: string } {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").trim();
  let h = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|head|select|button)\b[\s\S]*?<\/\1>/gi, "");
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(h)?.[1] ?? /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(h)?.[1];
  h = main ?? /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(h)?.[1] ?? h;
  h = h.replace(/<(nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, "");
  h = h.replace(/<[^>]+(?:role=["'](?:navigation|banner|contentinfo)["']|aria-hidden=["']true["'])[^>]*>[\s\S]*?<\/[a-z0-9]+>/gi, "");
  // Code blocks keep their whitespace: set aside before the rest is reflowed.
  const blocks: string[] = [];
  h = h.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, body: string) => {
    const lang = /class=["'][^"']*language-([\w+-]+)/i.exec(body)?.[1] ?? "";
    blocks.push("```" + lang + "\n" + stripTags(body.replace(/<br\s*\/?>/gi, "\n")).replace(/\n+$/, "") + "\n```");
    return `\n\n\u0000${blocks.length - 1}\u0000\n\n`;
  });
  const abs = (href: string) => {
    try {
      return base ? new URL(href, base).toString() : href;
    } catch {
      return href;
    }
  };
  h = h
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${stripTags(t).trim()}\n\n`)
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, t: string) => {
      const text = stripTags(t).trim();
      if (!text) return "";
      return href.startsWith("#") || href.startsWith("javascript:") ? text : `[${text}](${abs(decodeEntities(href))})`;
    })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, t: string) => "`" + stripTags(t) + "`")
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/li>/gi, "")
    .replace(/<\/(p|div|section|tr|ul|ol|table|blockquote|dl|dt|dd)>/gi, "\n\n")
    .replace(/<img\b[^>]*alt=["']([^"']+)["'][^>]*>/gi, "[image: $1]");
  let text = stripTags(h)
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  text = text.replace(/\u0000(\d+)\u0000/g, (_, i: string) => blocks[Number(i)] ?? "");
  return { title, markdown: text };
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n\n[… ${text.length - max} more characters — call again with a larger maxChars, or fetch a more specific page]`;
}

// ---- web_fetch -----------------------------------------------------------------------------------

export async function webFetch(url: string, maxChars = DEFAULT_MAX, deps: WebDeps = defaultDeps): Promise<string> {
  let u = await checkUrl(url, deps);
  let res: Response | undefined;
  for (let hop = 0; hop < 6; hop++) {
    res = await deps.fetch(u, { redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { "user-agent": UA, accept: "text/html,text/plain,application/json,text/markdown;q=0.9,*/*;q=0.5" } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      u = await checkUrl(new URL(res.headers.get("location")!, u).toString(), deps);
      continue;
    }
    break;
  }
  if (!res) throw new Error("no response");
  if (res.status >= 300 && res.status < 400) throw new Error("too many redirects");
  if (!res.ok) throw new Error(`${u} answered HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (/^(image|audio|video|font)\/|application\/(octet-stream|zip|pdf|x-)/.test(type)) {
    return `${u}\n${type}, ${res.headers.get("content-length") ?? "unknown"} bytes — not a text page, nothing to read.`;
  }
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const body = new TextDecoder().decode(Buffer.concat(chunks));
  if (/html|xml/.test(type) || /^\s*<(!doctype|html)/i.test(body)) {
    const { title, markdown } = htmlToMarkdown(body, u.toString());
    return cap(`# ${title || u}\n${u}\n\n${markdown}`, maxChars);
  }
  if (/json/.test(type)) {
    try {
      return cap(`${u}\n\n${JSON.stringify(JSON.parse(body), null, 2)}`, maxChars);
    } catch {
      // fall through to plain text
    }
  }
  return cap(`${u}\n\n${body}`, maxChars);
}

// ---- lookup --------------------------------------------------------------------------------------

export const LOOKUP_SOURCES = ["npm", "pypi", "crates", "go", "github", "stackoverflow", "wikipedia"] as const;
type Source = (typeof LOOKUP_SOURCES)[number];

async function getJson(url: string, deps: WebDeps, headers: Record<string, string> = {}): Promise<any> {
  const res = await deps.fetch(url, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": UA, accept: "application/json", ...headers } });
  if (res.status === 404) throw new Error("not found");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const day = (s?: string) => (s ? s.slice(0, 10) : "?");
const enc = encodeURIComponent;

export async function lookup(source: string, query: string, deps: WebDeps = defaultDeps): Promise<string> {
  const q = query.trim();
  if (!q) throw new Error("query is empty");
  if (!(LOOKUP_SOURCES as readonly string[]).includes(source)) throw new Error(`source must be one of ${LOOKUP_SOURCES.join(", ")}`);
  try {
    switch (source as Source) {
      case "npm": {
        const name = q.startsWith("@") ? `@${enc(q.slice(1))}` : enc(q);
        const p = await getJson(`https://registry.npmjs.org/${name}`, deps);
        const latest = p["dist-tags"]?.latest;
        const v = p.versions?.[latest] ?? {};
        const recent = Object.keys(p.time ?? {}).filter((k) => k !== "created" && k !== "modified").slice(-5);
        return [
          `npm ${p.name}@${latest} (published ${day(p.time?.[latest])})`,
          p.description,
          `license: ${v.license ?? p.license ?? "?"} · node: ${v.engines?.node ?? "any"}`,
          p.homepage ? `homepage: ${p.homepage}` : "",
          typeof p.repository?.url === "string" ? `repository: ${p.repository.url.replace(/^git\+/, "")}` : "",
          `dependencies: ${Object.keys(v.dependencies ?? {}).join(", ") || "none"}`,
          `recent versions: ${recent.join(", ")}`,
        ].filter(Boolean).join("\n");
      }
      case "pypi": {
        const p = await getJson(`https://pypi.org/pypi/${enc(q)}/json`, deps);
        const i = p.info ?? {};
        const urls = Object.entries(i.project_urls ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n");
        return [`pypi ${i.name} ${i.version}`, i.summary, `requires python: ${i.requires_python || "any"} · license: ${i.license_expression || i.license || "?"}`, urls, `requires: ${(i.requires_dist ?? []).slice(0, 15).join(", ") || "none"}`].filter(Boolean).join("\n");
      }
      case "crates": {
        const p = await getJson(`https://crates.io/api/v1/crates/${enc(q)}`, deps);
        const c = p.crate ?? {};
        return [`crate ${c.name} ${c.max_stable_version ?? c.newest_version} (updated ${day(c.updated_at)})`, c.description, c.repository ? `repository: ${c.repository}` : "", c.documentation ? `docs: ${c.documentation}` : "", `downloads: ${c.downloads}`].filter(Boolean).join("\n");
      }
      case "go": {
        // The module proxy's case encoding: each capital becomes "!" and its lower case.
        const mod = q.replace(/[A-Z]/g, (m) => `!${m.toLowerCase()}`);
        const p = await getJson(`https://proxy.golang.org/${mod}/@latest`, deps);
        return `go module ${q} ${p.Version} (published ${day(p.Time)})\ndocs: https://pkg.go.dev/${q}`;
      }
      case "github": {
        const issue = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(q);
        if (issue) {
          const i = await getJson(`https://api.github.com/repos/${issue[1]}/issues/${issue[2]}`, deps, { accept: "application/vnd.github+json" });
          return cap(`${i.pull_request ? "PR" : "issue"} ${q}: ${i.title}\n${i.state}${i.state_reason ? ` (${i.state_reason})` : ""} · ${i.comments} comments · opened ${day(i.created_at)} · ${i.html_url}\n\n${i.body ?? ""}`, DEFAULT_MAX);
        }
        const file = /^([\w.-]+\/[\w.-]+)\/(.+)$/.exec(q);
        if (file) {
          const res = await deps.fetch(`https://raw.githubusercontent.com/${file[1]}/HEAD/${file[2]!.split("/").map(enc).join("/")}`, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": UA } });
          if (!res.ok) throw new Error(res.status === 404 ? "not found" : `HTTP ${res.status}`);
          return cap(`${q} (default branch)\n\n${await res.text()}`, DEFAULT_MAX);
        }
        const r = await getJson(`https://api.github.com/repos/${q}`, deps, { accept: "application/vnd.github+json" });
        return [`github ${r.full_name}${r.archived ? " (archived)" : ""}`, r.description, `★ ${r.stargazers_count} · ${r.open_issues_count} open issues · default branch ${r.default_branch} · last push ${day(r.pushed_at)}`, `license: ${r.license?.spdx_id ?? "none"} · language: ${r.language ?? "?"}`, r.homepage ? `homepage: ${r.homepage}` : "", r.html_url].filter(Boolean).join("\n");
      }
      case "stackoverflow": {
        const p = await getJson(`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&site=stackoverflow&pagesize=3&filter=withbody&q=${enc(q)}`, deps);
        const items = (p.items ?? []) as { title: string; link: string; score: number; is_answered: boolean; accepted_answer_id?: number; body?: string }[];
        if (!items.length) return `no Stack Overflow questions match "${q}"`;
        return cap(items.map((it) => `## ${decodeEntities(it.title)} (score ${it.score}${it.accepted_answer_id ? ", has an accepted answer" : ""})\n${it.link}\n\n${htmlToMarkdown(`<body>${it.body ?? ""}</body>`).markdown.slice(0, 1500)}`).join("\n\n"), DEFAULT_MAX);
      }
      case "wikipedia": {
        const p = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${enc(q.replace(/ /g, "_"))}`, deps);
        return `${p.title}${p.description ? ` — ${p.description}` : ""}\n${p.content_urls?.desktop?.page ?? ""}\n\n${p.extract ?? ""}`;
      }
    }
  } catch (err) {
    throw new Error(`${source} lookup of '${q}' failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  throw new Error("unreachable");
}

// ---- web_search (Tavily) -------------------------------------------------------------------------

export async function webSearch(query: string, deps: WebDeps = defaultDeps, key = tavilyKey()): Promise<string> {
  if (!key) throw new Error("web search is not set up — the user can add a free Tavily key in Settings → Web search");
  const q = query.trim();
  if (!q) throw new Error("query is empty");
  const res = await deps.fetch("https://api.tavily.com/search", {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "user-agent": UA },
    // Basic depth: one credit of the free plan's 1,000 a month.
    body: JSON.stringify({ query: q, search_depth: "basic", max_results: 6, include_answer: false }),
  });
  if (res.status === 401 || res.status === 403) throw new Error("the saved Tavily key was refused — check it in Settings → Web search");
  if (res.status === 429 || res.status === 432 || res.status === 433) throw new Error("this month's free Tavily searches are used up (they reset at the start of next month)");
  if (!res.ok) throw new Error(`Tavily answered HTTP ${res.status}`);
  const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  const results = data.results ?? [];
  if (!results.length) return `no results for "${q}"`;
  return results.map((r, i) => `${i + 1}. ${r.title ?? r.url}\n   ${r.url}\n   ${(r.content ?? "").replace(/\s+/g, " ").slice(0, 400)}`).join("\n\n");
}

// Validates a key with the cheapest real request there is (one basic search). Used by the
// Settings "Test" button; the result is the error to show, or undefined when the key works.
export async function testTavilyKey(key: string, deps: WebDeps = defaultDeps): Promise<string | undefined> {
  try {
    await webSearch("niti test", deps, key);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ---- tool specs and dispatch ---------------------------------------------------------------------

export function webToolSpecs(allowed: string[], searchReady = webSearchConfigured()): ToolSpec[] {
  const has = (n: string) => allowed.includes(n) || allowed.includes(WEB_ALIAS);
  const specs: ToolSpec[] = [];
  if (has("web_search") && searchReady) {
    specs.push({
      name: "web_search",
      description: "Search the web and get the top results, each with its URL and a short extract. Use it to find pages, then read the useful ones with web_fetch. Each search is approved by the user and uses one of their free monthly searches, so make each query count.",
      parameters: { type: "object", properties: { query: { type: "string", description: "what to search for, as you would type it into a search engine" } }, required: ["query"] },
    });
  }
  if (has("web_fetch")) {
    specs.push({
      name: "web_fetch",
      description:
        "Read a web page over HTTP(S): returns its main text as markdown, without scripts, menus or styling. For documentation, changelogs, API references, a URL the user gave you" +
        (has("web_search") && searchReady ? ", or one found with web_search." : " or one from lookup. There is no web search here: fetch URLs you know, don't guess at them.") +
        " Public addresses only; each fetch is approved by the user.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" }, maxChars: { type: "integer", description: `characters to return (default ${DEFAULT_MAX})` } },
        required: ["url"],
      },
    });
  }
  if (has("lookup")) {
    specs.push({
      name: "lookup",
      description:
        "Look something up, no account needed: a package's latest version and details (npm, pypi, crates, go), a GitHub repo ('owner/repo'), issue or PR ('owner/repo#123') or file ('owner/repo/path/to/file'), Stack Overflow questions and answers (stackoverflow), or a topic's summary (wikipedia). Faster and more reliable than fetching the website.",
      parameters: {
        type: "object",
        properties: { source: { type: "string", enum: [...LOOKUP_SOURCES] }, query: { type: "string", description: "a package name, repo, issue, file, question or topic" } },
        required: ["source", "query"],
      },
    });
  }
  return specs;
}

export async function runWebTool(name: string, input: Record<string, unknown>, deps: WebDeps = defaultDeps): Promise<string> {
  switch (name) {
    case "web_fetch": {
      const max = Number(input.maxChars);
      return webFetch(String(input.url ?? ""), Number.isFinite(max) && max > 500 ? Math.min(max, 60_000) : DEFAULT_MAX, deps);
    }
    case "lookup":
      return lookup(String(input.source ?? ""), String(input.query ?? ""), deps);
    case "web_search":
      return webSearch(String(input.query ?? ""), deps);
  }
  throw new Error(`unknown web tool ${name}`);
}
