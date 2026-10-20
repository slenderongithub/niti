import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { htmlToMarkdown, isPrivateAddress, webFetch, lookup, webSearch, webToolSpecs, runWebTool, decodeEntities, type WebDeps } from "./web.ts";
import { expandTools } from "./tools.ts";
import { Agent, type AgentConfig } from "../agent/agent.ts";
import { Bus } from "../events/bus.ts";
import { AUTO_RULES } from "../permissions.ts";
import type { Provider, Turn } from "../providers/provider.ts";

const PUBLIC = "93.184.216.34";

function deps(routes: Record<string, (init?: RequestInit) => Response>, dns: Record<string, string[]> = {}): WebDeps & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    resolve: async (host) => dns[host] ?? [PUBLIC],
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      const hit = Object.entries(routes).find(([k]) => url.startsWith(k));
      if (!hit) return new Response("not found", { status: 404 });
      return hit[1](init);
    }) as typeof fetch,
  };
}

const html = (body: string, head = "<title>Docs &amp; Guides</title>") => new Response(`<!doctype html><html><head>${head}<script>evil()</script></head><body>${body}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });

test("private, loopback and link-local addresses are refused; public ones pass", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "not-an-ip"]) expect(isPrivateAddress(ip)).toBe(true);
  for (const ip of [PUBLIC, "8.8.8.8", "2606:4700::1111", "172.32.0.1"]) expect(isPrivateAddress(ip)).toBe(false);
});

test("htmlToMarkdown keeps the main content and drops scripts, menus and footers", () => {
  const { title, markdown } = htmlToMarkdown(
    `<html><head><title>API &mdash; Ref</title><style>.x{}</style></head><body><nav><a href="/">Home</a></nav>
     <main><h1>fetch()</h1><p>Starts a <strong>request</strong>. See <a href="/docs/Response">Response</a>.</p>
     <pre><code class="language-js">const r = await fetch(url);
if (!r.ok) throw r;</code></pre><ul><li>one</li><li>two</li></ul></main><footer>© 2026</footer></body></html>`,
    "https://dev.example/docs/fetch",
  );
  expect(title).toBe("API — Ref");
  expect(markdown).toContain("# fetch()");
  expect(markdown).toContain("Starts a **request**. See [Response](https://dev.example/docs/Response).");
  expect(markdown).toContain("```js\nconst r = await fetch(url);\nif (!r.ok) throw r;\n```");
  expect(markdown).toContain("- one\n- two");
  expect(markdown).not.toContain("Home");
  expect(markdown).not.toContain("2026");
  expect(decodeEntities("&#x27;a&#39; &lt;b&gt; &unknown;")).toBe("'a' <b> &unknown;");
});

test("web_fetch reads a public page, follows a redirect, and caps the length", async () => {
  const d = deps({
    "https://docs.example/old": () => new Response(null, { status: 301, headers: { location: "/new" } }),
    "https://docs.example/new": () => html(`<main><h2>Install</h2><p>${"word ".repeat(5000)}</p></main>`),
  });
  const out = await webFetch("https://docs.example/old", 2000, d);
  expect(out.startsWith("# Docs & Guides\nhttps://docs.example/new")).toBe(true);
  expect(out).toContain("## Install");
  expect(out).not.toContain("evil()");
  expect(out).toContain("more characters");
  expect(out.length).toBeLessThan(2200);
});

test("web_fetch refuses local targets, directly and through a redirect or DNS", async () => {
  const d = deps(
    { "https://evil.example/": () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }) },
    { "rebind.example": ["127.0.0.1"] },
  );
  await expect(webFetch("http://localhost:8080/admin", 1000, deps({}, { localhost: ["127.0.0.1"] }))).rejects.toThrow("private or local");
  await expect(webFetch("https://evil.example/", 1000, d)).rejects.toThrow("private or local");
  await expect(webFetch("https://rebind.example/", 1000, d)).rejects.toThrow("private or local");
  await expect(webFetch("file:///etc/passwd", 1000, d)).rejects.toThrow("only http and https");
  await expect(webFetch("https://user:pw@docs.example/", 1000, d)).rejects.toThrow("credentials");
});

test("web_fetch returns JSON pretty-printed and describes binaries instead of dumping them", async () => {
  const d = deps({
    "https://api.example/x.json": () => Response.json({ a: 1 }),
    "https://cdn.example/a.png": () => new Response("PNG", { headers: { "content-type": "image/png", "content-length": "3" } }),
  });
  expect(await webFetch("https://api.example/x.json", 1000, d)).toContain('"a": 1');
  expect(await webFetch("https://cdn.example/a.png", 1000, d)).toContain("not a text page");
});

test("lookup answers from public registries without a key", async () => {
  const d = deps({
    "https://registry.npmjs.org/zod": () => Response.json({ name: "zod", description: "TypeScript-first schemas", "dist-tags": { latest: "4.1.0" }, time: { created: "", modified: "", "4.0.0": "2026-01-01T00:00:00Z", "4.1.0": "2026-09-01T00:00:00Z" }, versions: { "4.1.0": { license: "MIT", dependencies: {} } } }),
    "https://registry.npmjs.org/@types%2Fnode": () => Response.json({ name: "@types/node", "dist-tags": { latest: "24.0.0" }, time: {}, versions: {} }),
    "https://pypi.org/pypi/requests/json": () => Response.json({ info: { name: "requests", version: "2.33.0", summary: "HTTP for Humans", requires_python: ">=3.9" } }),
    "https://api.github.com/repos/oven-sh/bun/issues/1": () => Response.json({ title: "First", state: "closed", comments: 2, created_at: "2021-01-01", html_url: "https://github.com/oven-sh/bun/issues/1", body: "hello" }),
    "https://api.github.com/repos/oven-sh/bun": () => Response.json({ full_name: "oven-sh/bun", description: "fast", stargazers_count: 1, open_issues_count: 2, default_branch: "main", pushed_at: "2026-10-01", license: { spdx_id: "MIT" }, html_url: "https://github.com/oven-sh/bun" }),
    "https://raw.githubusercontent.com/oven-sh/bun/HEAD/README.md": () => new Response("# Bun"),
    "https://proxy.golang.org/github.com/!burnt!sushi/toml/@latest": () => Response.json({ Version: "v1.5.0", Time: "2026-03-01T00:00:00Z" }),
    "https://en.wikipedia.org/api/rest_v1/page/summary/Rust_(programming_language)": () => Response.json({ title: "Rust", extract: "A language." }),
    "https://api.stackexchange.com/": () => Response.json({ items: [{ title: "How &amp; why", link: "https://so/1", score: 5, accepted_answer_id: 2, body: "<p>Use <code>x</code></p>" }] }),
  });
  expect(await lookup("npm", "zod", d)).toContain("npm zod@4.1.0 (published 2026-09-01)");
  expect(await lookup("npm", "@types/node", d)).toContain("@types/node@24.0.0");
  expect(await lookup("pypi", "requests", d)).toContain("requests 2.33.0");
  expect(await lookup("github", "oven-sh/bun#1", d)).toContain("issue oven-sh/bun#1: First");
  expect(await lookup("github", "oven-sh/bun", d)).toContain("★ 1");
  expect(await lookup("github", "oven-sh/bun/README.md", d)).toContain("# Bun");
  expect(await lookup("go", "github.com/BurntSushi/toml", d)).toContain("v1.5.0");
  expect(await lookup("wikipedia", "Rust (programming language)", d)).toContain("A language.");
  expect(await lookup("stackoverflow", "how why", d)).toContain("## How & why (score 5, has an accepted answer)");
  await expect(lookup("npm", "nope-not-here", d)).rejects.toThrow("not found");
  await expect(lookup("altavista", "x", d)).rejects.toThrow("source must be");
});

test("web_search sends a basic Tavily search and explains a refused key or a spent month", async () => {
  let body: any;
  const ok = deps({ "https://api.tavily.com/search": (init) => ((body = JSON.parse(String(init!.body))), Response.json({ results: [{ title: "Bun docs", url: "https://bun.sh/docs", content: "Bun is fast" }] })) });
  const out = await webSearch("bun test", ok, "tvly-k");
  expect(out).toContain("1. Bun docs\n   https://bun.sh/docs");
  expect(body).toMatchObject({ query: "bun test", search_depth: "basic" });
  await expect(webSearch("x", deps({ "https://api.tavily.com/search": () => new Response("", { status: 401 }) }), "bad")).rejects.toThrow("refused");
  await expect(webSearch("x", deps({ "https://api.tavily.com/search": () => new Response("", { status: 432 }) }), "k")).rejects.toThrow("used up");
  await expect(webSearch("x", ok, undefined)).rejects.toThrow("not set up");
});

test("specs: `web` grants all three, web_search only with a key, and fetch says so without one", () => {
  expect(expandTools(["read_file", "web"])).toEqual(expect.arrayContaining(["web_fetch", "lookup", "web_search"]));
  expect(expandTools(["read_file", "web"])).not.toContain("web");
  expect(webToolSpecs(["web_fetch", "lookup", "web_search"], true).map((s) => s.name)).toEqual(["web_search", "web_fetch", "lookup"]);
  const noKey = webToolSpecs(["web_fetch", "lookup", "web_search"], false);
  expect(noKey.map((s) => s.name)).toEqual(["web_fetch", "lookup"]);
  expect(noKey[0]!.description).toContain("There is no web search here");
  expect(webToolSpecs(["read_file"], true)).toEqual([]);
});

test("runWebTool clamps maxChars", async () => {
  const d = deps({ "https://a.example/": () => new Response("x".repeat(100_000), { headers: { "content-type": "text/plain" } }) });
  expect((await runWebTool("web_fetch", { url: "https://a.example/", maxChars: 10 }, d)).length).toBeLessThan(13_000);
});

test("a web call is asked about even under --auto, and refused when not approved", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-web-"));
  writeFileSync(join(root, "a.txt"), "x");
  const asked: { tool: string; dangerous: boolean }[] = [];
  let n = 0;
  const p: Provider = {
    async send(_s, turns: Turn[]) {
      n++;
      if (n === 1) return { text: "", toolCalls: [{ id: "1", name: "web_fetch", input: { url: "https://docs.example/" } }, { id: "2", name: "read_file", input: { path: "a.txt" } }] };
      const tool = turns.at(-1) as Extract<Turn, { role: "tool" }>;
      return { text: tool.results.map((r) => r.output).join(" | "), toolCalls: [] };
    },
  };
  const cfg: AgentConfig = { id: "w", provider: "anthropic", model: "x", role: "r", systemPrompt: "s", allowedTools: ["read_file", "web"] };
  const r = await new Agent(cfg, p, new Bus(), { root, permissionLayers: [AUTO_RULES], approve: async (tool, _i, dangerous) => (asked.push({ tool, dangerous: !!dangerous }), false) }).runDetailed("x");
  expect(asked.map((a) => a.tool)).toEqual(["web_fetch"]); // read_file waved through by --auto, the fetch asked
  expect(r.text).toContain("not approved");
});
