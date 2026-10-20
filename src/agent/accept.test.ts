import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acceptWork, acceptMessage, businessName, ownPart } from "./accept.ts";

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "niti-accept-"));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), body);
  }
  return root;
}
const failing = (r: Awaited<ReturnType<typeof acceptWork>>) => r.checks.filter((c) => !c.ok).map((c) => c.name);

const TASK = "make a stunning landing page for Bean There, a coffee shop";
const page = (body: string, head = "") => `<!doctype html><html lang="en"><head><title>Bean There</title><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="styles.css">${head}</head><body>${body}</body></html>`;

const RICH_CSS =
  `:root { --espresso: #3b2416; --cream: #f6efe6; --accent: #c8743a; --sage: #7d8f69; }\n` +
  `body { font-family: 'Inter', sans-serif; background: var(--cream); color: var(--espresso); }\nh1, h2 { font-family: 'Playfair Display', serif; }\n` +
  Array.from({ length: 24 }, (_, i) => `.s${i} { padding: ${i}px; }`).join("\n") +
  `\na:hover, .btn:hover { color: var(--accent); }\n@media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }\n`;

test("the coffee shop that shipped as Arial and #333 fails on every count that matters, saying where", async () => {
  const root = project({ "index.html": page("<h1>Bean There</h1><p>Fresh coffee daily.</p>"), "styles.css": "body { font-family: Arial, sans-serif; color: #333; background: #fff; }\nh1 { color: #333; }" });
  const r = await acceptWork(root, { task: TASK, written: ["index.html", "styles.css"] });
  expect(failing(r)).toEqual(["enough CSS for the design asked for", "a palette of its own", "its own fonts", "works on a phone", "hover and focus states"]);
  expect(r.checks.filter((c) => !c.ok).every((c) => c.grade === "quality")).toBe(true);
  const msg = acceptMessage(r);
  expect(msg).toContain("The page uses Arial");
  expect(msg).toContain("styles.css has no @media query");
});

test("a page with a palette, its own fonts, media queries and hover states passes", async () => {
  const root = project({ "index.html": page("<h1>Bean There</h1><p>Single-origin pour-overs on Elm Street.</p>"), "styles.css": RICH_CSS });
  const r = await acceptWork(root, { task: TASK, written: ["index.html", "styles.css"] });
  expect(failing(r)).toEqual([]);
  expect(r.ok).toBe(true);
});

test("a missing linked file, placeholder copy, the wrong name and no styling are must-fixes", async () => {
  const root = project({ "index.html": `<html><head><script src="app.js"></script></head><body><h1>Coffee Shop</h1><p>Lorem ipsum dolor. Call 123-456-7890.</p><img src="img/hero.jpg"></body></html>` });
  const r = await acceptWork(root, { task: TASK, written: ["index.html"] });
  const must = r.checks.filter((c) => !c.ok && c.grade === "must");
  expect(must.map((c) => c.name)).toEqual(["index.html: linked files exist", "index.html: real content, no placeholders", "index.html: names Bean There", "index.html: is styled"]);
  expect(must[0]!.detail).toContain("app.js, img/hero.jpg");
  expect(must[1]!.detail).toContain("Lorem ipsum");
});

test("the business name is read from the request however it's put", () => {
  expect(businessName("a landing page for Bean There, a coffee shop")).toBe("Bean There");
  expect(businessName('build a site called "Moon & Mug"')).toBe("Moon & Mug");
  expect(businessName("make a coffee shop landing page")).toBeUndefined();
  expect(businessName("create index.html\n\n(Part of the request: a site for Ridge Roasters, deployment ready)")).toBe("Ridge Roasters");
});

test("a server that starts in the sandbox, serves the site and answers the routes the task names passes", async () => {
  const root = project({
    "index.html": page("<h1>Bean There</h1>"),
    "styles.css": RICH_CSS,
    "package.json": JSON.stringify({ scripts: { start: "node server.js" } }),
    "server.js": `const http = require("http"); const fs = require("fs");
http.createServer((req, res) => {
  if (req.url === "/api/menu") { res.setHeader("content-type", "application/json"); return res.end('[{"name":"Flat white"}]'); }
  if (req.url === "/" ) { res.setHeader("content-type", "text/html"); return res.end(fs.readFileSync("index.html")); }
  res.statusCode = 404; res.end();
}).listen(process.env.PORT || 3000);`,
    "README.md": "Run it: `npm start`",
  });
  const r = await acceptWork(root, { task: "build server.js with a /api/menu endpoint and a start script, deployment ready", written: ["server.js", "package.json"], sandbox: true });
  expect(failing(r)).toEqual([]);
  expect(r.checks.map((c) => c.name)).toEqual(["the server starts", "the server serves the site", "the routes the task names answer", "run and deploy steps in the README"]);
}, 20_000);

test("a server that crashes is a must-fix with its own error, and a missing module says how to fix it", async () => {
  const root = project({ "package.json": JSON.stringify({ scripts: { start: "node server.js" } }), "server.js": `const express = require("express-not-installed"); express().listen(process.env.PORT);` });
  const r = await acceptWork(root, { task: "build the API server", written: ["server.js"] });
  const c = r.checks.find((x) => x.name === "the server starts")!;
  expect(c.ok).toBe(false);
  expect(c.detail).toContain("exited");
  expect(c.detail).toContain("npm install");
}, 20_000);

test("integration: the page's requests are matched against the server's routes", async () => {
  const root = project({
    "index.html": page("<h1>Bean There</h1><script src=\"app.js\"></script>"),
    "styles.css": RICH_CSS,
    "app.js": `fetch("/api/menu").then(r => r.json()); fetch("/api/orders", { method: "POST" });`,
    "server.js": `const express = require("express"); const app = express(); app.get("/api/menu", (q, s) => s.json([])); app.listen(process.env.PORT || 3000);`,
  });
  const task = `Check that the parts your teammates built fit together, and fix what doesn't.\n\n(Part of the request: ${TASK})`;
  const r = await acceptWork(root, { task, written: [] });
  const c = r.checks.find((x) => x.name === "the page's requests match the server's routes")!;
  expect(c.ok).toBe(false);
  expect(c.detail).toContain("/api/orders");
}, 20_000);

test("a frontend part of a deployable request isn't asked for the server — that's the backend's part", async () => {
  const task = `create index.html and styles.css\n\n(Part of the request: ${TASK}, end-to-end deployment ready)`;
  expect(ownPart(task)).toBe("create index.html and styles.css");
  const root = project({ "index.html": page("<h1>Bean There</h1><script src=\"script.js\"></script>"), "styles.css": RICH_CSS, "script.js": "console.log(1)" });
  const r = await acceptWork(root, { task, written: ["index.html", "styles.css", "script.js"] });
  expect(r.checks.some((c) => /server|README/.test(c.name))).toBe(false);
  expect(r.ok).toBe(true);
});
