// The fake model zoo: scripted local models that each fail the way a real one did, so the local
// harness can be tested against every behaviour niti has met without downloading anything. The fake
// engines (fakellama.ts, fakemlx.ts) pick a persona from the model's name — zoo/<persona>-GGUF or
// zoo/<persona>-MLX-4bit — and fakellm.ts answers with it.
//
// Every persona is a competent builder underneath (it knows what to write for the coffee-shop goal);
// what differs is the *form* it answers in, and whether it can plan. Under a forced turn it does what
// the engine would make it do: llama.cpp's grammar (tool_choice "required") yields a real call, and a
// reply started with an MLX prefill is continued as that call. Only `chatty` can't be forced, like a
// model whose template has no tools.

export const PERSONAS = [
  "native", // calls tools through the API — the good case
  "jsonline", // writes the call as a JSON line after a sentence
  "qwen3xml", // Qwen3-Coder's <tool_call><function=…><parameter=…> text
  "fence", // pastes files into the reply as labelled code blocks, says "Done" in prose
  "prosefirst", // opens every task with a plan in prose; acts when made to
  "empty", // replies with nothing when it should call finish
  "leaker", // leaks chat-template tokens past its turn
  "thinker", // puts <think>…</think> in front of what it says
  "badplanner", // can't route or split work in the asked-for form
  "todo", // rewrites its checklist before doing anything
  "lazy", // ships Arial on white first, styles properly once told what's missing
  "chatty", // never calls a tool, even when forced: chat only
  "needsforce", // describes the call in prose unless the engine makes it call (Qwen2.5-Coder on MLX)
  "badjson", // writes calls as JSON with the file's quotes unescaped and its lines as real newlines
  "overreach", // writes every file of the request, its teammates' too (Qwen2.5-Coder as backend)
  "wanderer", // explores with shell syntax as arguments, then deletes its teammate's page as a "stub" (Ornith)
] as const;
export type Persona = (typeof PERSONAS)[number];

type Reply = { text?: string; tool?: { name: string; args: Record<string, unknown> } };
type Action = { name: string; args: Record<string, unknown> };

const NAME = "Bean There";

const GOOD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${NAME} — Coffee Roasters</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@600&family=Inter:wght@400;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="nav"><a class="logo" href="#">${NAME}</a><nav><a href="#menu">Menu</a><a href="#visit">Visit</a></nav></header>
  <section class="hero"><h1>${NAME}</h1><p>Small-batch roasts, poured slow on Elm Street.</p><a class="btn" href="#menu">See the menu</a></section>
  <section id="menu" class="menu"><h2>Menu</h2><div class="grid" id="menu-items"></div></section>
  <section id="visit" class="visit"><h2>Visit</h2><p>14 Elm Street, Portland · Open 7am–6pm daily · hello@beanthere.coffee</p></section>
  <footer>© ${NAME}</footer>
  <script src="script.js"></script>
</body>
</html>
`;

const GOOD_CSS =
  `:root { --espresso: #3b2416; --cream: #f6efe6; --caramel: #c8743a; --sage: #7d8f69; --space: 24px; }\n` +
  `* { box-sizing: border-box; }\nbody { margin: 0; font-family: 'Inter', sans-serif; background: var(--cream); color: var(--espresso); }\n` +
  `h1, h2, .logo { font-family: 'Fraunces', serif; }\n.nav { display: flex; justify-content: space-between; padding: var(--space); }\n` +
  `.nav a { color: var(--espresso); margin-left: 16px; text-decoration: none; }\n.nav a:hover, .nav a:focus-visible { color: var(--caramel); }\n` +
  `.hero { min-height: 100vh; display: grid; place-content: center; text-align: center; background: linear-gradient(160deg, var(--espresso), #6b3f22); color: var(--cream); }\n` +
  `.hero h1 { font-size: 4rem; margin: 0; }\n.hero p { font-size: 1.25rem; }\n` +
  `.btn { display: inline-block; padding: 12px 28px; border-radius: 999px; background: var(--caramel); color: var(--cream); text-decoration: none; transition: transform 200ms; }\n` +
  `.btn:hover, .btn:focus-visible { transform: translateY(-2px); }\n.menu, .visit { padding: 96px var(--space); }\n` +
  `.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space); }\n.card { background: #fff; border-radius: 16px; padding: var(--space); border: 1px solid var(--sage); }\n` +
  `.card:hover { box-shadow: 0 8px 24px rgba(59, 36, 22, 0.15); }\n.card h3 { margin: 0 0 8px; }\n.card .price { color: var(--caramel); font-weight: 600; }\n` +
  `.visit p { font-size: 1.1rem; }\nfooter { padding: var(--space); text-align: center; background: var(--espresso); color: var(--cream); }\n` +
  `h2 { font-size: 2.25rem; margin: 0 0 32px; }\nsection { scroll-margin-top: 80px; }\n.logo { font-size: 1.5rem; color: var(--espresso); }\n` +
  `nav { display: flex; align-items: center; }\n.menu h2, .visit h2 { color: var(--espresso); }\nfooter a { color: var(--caramel); }\n` +
  `@media (max-width: 720px) { .grid { grid-template-columns: 1fr; } .hero h1 { font-size: 2.5rem; } }\n`;

const LAZY_CSS = `body { font-family: Arial, sans-serif; color: #333; background: #fff; }\nh1 { color: #333; }\n`;

const GOOD_JS = `fetch("/api/menu").then((r) => r.json()).then((items) => {\n  document.getElementById("menu-items").innerHTML = items.map((i) => \`<div class="card"><h3>\${i.name}</h3><p class="price">$\${i.price}</p></div>\`).join("");\n});\n`;

const SERVER = `const http = require("http");
const fs = require("fs");
const path = require("path");
const MENU = [{ name: "Flat white", price: 4.5 }, { name: "Cortado", price: 4 }, { name: "Cold brew", price: 5 }];
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
http.createServer((req, res) => {
  if (req.url === "/api/menu") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(MENU)); }
  const file = req.url === "/" ? "index.html" : req.url.slice(1);
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) { res.statusCode = 404; return res.end("not found"); }
    res.setHeader("content-type", TYPES[path.extname(file)] || "application/octet-stream");
    res.end(data);
  });
}).listen(process.env.PORT || 3000);
`;
const PACKAGE = JSON.stringify({ name: "bean-there", version: "1.0.0", scripts: { start: "node server.js" }, engines: { node: ">=18" } }, null, 2) + "\n";
const README = `# ${NAME}\n\nRun it: \`npm install && npm start\`, then open http://localhost:3000.\n\nDeploy: any Node host with the start command \`npm start\` (Render, Railway, Fly).\n`;

const FRONT = ["index.html", "styles.css", "script.js"];
const BACK = ["server.js", "package.json", "README.md"];

function content(file: string, persona: Persona, attempt: number): string {
  if (file === "index.html") return GOOD_HTML;
  if (file === "styles.css") return persona === "lazy" && attempt === 0 ? LAZY_CSS : GOOD_CSS;
  if (file === "script.js") return GOOD_JS;
  if (file === "server.js") return SERVER;
  if (file === "package.json") return PACKAGE;
  if (file === "README.md") return README;
  return "hi";
}

const textOf = (m: any): string => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((p: any) => p.text ?? "").join("") : "");

// The task's own part, as the planner wrote it (see src/agent/accept.ts ownPart).
function own(task: string): string {
  const i = task.indexOf("\n\nYour part: ");
  if (i >= 0) return task.slice(i + 13);
  const j = task.indexOf("\n\n(Part of the request: ");
  return (j >= 0 ? task.slice(0, j) : task).replace(/\n\nTeammates' files: .*$/m, "");
}

function filesFor(task: string): string[] {
  const part = own(task).toLowerCase();
  const front = /index\.html|styles?\.css|page|pages|html|look|frontend|ui\b|landing/.test(part);
  const back = /server|package\.json|api|backend|deploy|start script|readme/.test(part);
  if (front && !back) return FRONT;
  if (back && !front) return BACK;
  return [...FRONT, ...BACK];
}

// What a competent builder does next in this conversation.
function nextAction(msgs: any[], persona: Persona, tools: string[]): Action {
  const task = textOf(msgs.find((m) => m.role === "user"));
  const calls = msgs.filter((m) => m.role === "assistant").flatMap((m) => (m.tool_calls ?? []).map((c: any) => ({ name: c.function?.name as string, args: safeJson(c.function?.arguments) })));
  if (task.includes("Create a file named hello.txt")) return calls.length ? { name: "finish", args: { summary: "wrote hello.txt" } } : { name: "write_file", args: { path: "hello.txt", content: "hi" } };
  if (task.startsWith("Check that the parts your teammates built fit together")) {
    return calls.some((c) => c.name === "read_file") ? { name: "finish", args: { summary: "The page, its stylesheet and script, and the server fit together." } } : { name: "read_file", args: { path: "index.html" } };
  }
  if (/VERDICT/.test(task)) return { name: "finish", args: { summary: "Looks right.\nVERDICT: approve" } };
  // It writes its checklist, then wants to write it again — for as long as niti offers the tool.
  if (persona === "todo" && tools.includes("todo") && !calls.some((c) => c.name === "write_file")) {
    return { name: "todo", args: { items: filesFor(task).map((f) => ({ text: `write ${f}`, status: "pending" })) } };
  }
  // Explores first (with shell syntax niti refuses), then tries to remove a teammate's page.
  if (persona === "wanderer" && !calls.some((c) => c.name === "write_file")) {
    if (!calls.some((c) => c.name === "shell")) return { name: "shell", args: { command: "ls", args: ["-la", "&&", "pwd"] } };
    const theirs = /Teammates' files: \w+ owns ([\w.]+)/.exec(task)?.[1];
    if (theirs && !calls.some((c) => c.name === "shell" && (c.args.command === "rm"))) return { name: "shell", args: { command: "rm", args: [theirs] } };
  }
  // Since niti last checked the work, write again what it named, then finish again.
  const lastCheck = msgs.map((m, i) => (m.role === "user" && textOf(m).includes("niti checked the work") ? i : -1)).filter((i) => i >= 0).at(-1);
  const plan = persona === "overreach" && !task.includes("Create a file named") ? [...FRONT, ...BACK] : filesFor(task);
  if (lastCheck !== undefined) {
    const said = textOf(msgs[lastCheck]);
    const named = plan.filter((f) => said.includes(f));
    const redo = named.length ? named : plan;
    const since = msgs.slice(lastCheck).filter((m) => m.role === "assistant").flatMap((m) => (m.tool_calls ?? []).map((c: any) => safeJson(c.function?.arguments).path));
    const left = redo.filter((f) => !since.includes(f));
    if (left.length) return { name: "write_file", args: { path: left[0]!, content: content(left[0]!, persona, 1) } };
    return { name: "finish", args: { summary: `Fixed ${redo.join(", ")}.` } };
  }
  const written = calls.filter((c) => c.name === "write_file").map((c) => String(c.args.path));
  const left = plan.filter((f) => !written.includes(f));
  if (left.length) return { name: "write_file", args: { path: left[0]!, content: content(left[0]!, persona, 0) } };
  return { name: "finish", args: { summary: `Built ${plan.join(", ")} for ${NAME}.` } };
}

function safeJson(s: unknown): Record<string, any> {
  try {
    return typeof s === "string" ? JSON.parse(s) : ((s as Record<string, any>) ?? {});
  } catch {
    return {};
  }
}

const LEAK = "<|im_end|>\n<|im_start|>user\nand now?";
const lang = (f: string) => ({ html: "html", css: "css", js: "javascript", json: "json", md: "markdown" })[f.split(".").pop() ?? ""] ?? "";

// An action in the persona's own form.
function dress(a: Action, persona: Persona, firstTurn: boolean): Reply {
  switch (persona) {
    case "jsonline":
      return { text: `I'll do that now.\n${JSON.stringify({ name: a.name, arguments: a.args })}` };
    case "qwen3xml":
      return { text: `<tool_call>\n<function=${a.name}>\n${Object.entries(a.args).map(([k, v]) => `<parameter=${k}>\n${typeof v === "string" ? v : JSON.stringify(v)}\n</parameter>`).join("\n")}\n</function>\n</tool_call>` };
    case "fence":
      if (a.name === "write_file") return { text: `Here is \`${a.args.path}\`:\n\n\`\`\`${lang(String(a.args.path))}\n${a.args.content}\`\`\`` };
      if (a.name === "finish") return { text: `Done. ${a.args.summary}` };
      return { text: `I would now ${a.name.replace("_", " ")} ${JSON.stringify(a.args)}.` }; // can't read on its own; forcing makes it
    case "prosefirst":
      return firstTurn ? { text: "Here's my plan:\n1. Write the markup with a hero, menu and visit section.\n2. Style it with a warm palette.\n3. Wire up the menu from the API.\nLet me know if that works!" } : { tool: a };
    case "empty":
      return a.name === "finish" ? { text: "" } : { tool: a };
    case "badjson":
      return { text: `{\n  "name": "${a.name}",\n  "arguments": {\n${Object.entries(a.args).map(([k, v]) => `    "${k}": ${typeof v === "string" ? `"${v}"` : JSON.stringify(v)}`).join(",\n")}\n  }\n}` };
    case "needsforce":
      return { text: `I'll ${a.name === "write_file" ? `write ${a.args.path}` : a.name === "finish" ? "wrap up" : a.name.replace("_", " ")} next.` };
    case "chatty":
      return { text: `To do this, you could ${a.name === "write_file" ? `create ${a.args.path}` : "check the files"} yourself. Happy to explain more!` };
    default:
      return { tool: a };
  }
}

// The rest of a call whose start niti wrote for the model (an MLX prefill), in the same shape.
function continuePrefill(prefill: string, a: Action): string {
  const json = `{"name": "${a.name}", "arguments": ${JSON.stringify(a.args)}}`;
  const full = [`<tool_call>\n${json}\n</tool_call>`, `[TOOL_CALLS][${json}]`, json].find((f) => f.startsWith(prefill)) ?? json;
  return full.slice(Math.min(prefill.length, full.length));
}

export function zooReply(persona: Persona, body: any): Reply {
  const msgs: any[] = body.messages ?? [];
  const last = msgs.at(-1);
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  const lastText = textOf(lastUser);
  const thinkingOn = body.chat_template_kwargs?.enable_thinking !== false;
  const wrap = (text: string) => {
    let t = text;
    if (persona === "thinker" && thinkingOn) t = `<think>The user wants this. Let me work it out step by step.</think>\n${t}`;
    if (persona === "leaker") t = `${t}${LEAK}`;
    return t;
  };

  // The model check's planning question, the local planner's two stages, and the integrate summary.
  if (lastText.includes("Write exactly one line per teammate")) {
    return { text: wrap(persona === "badplanner" ? "Sure! The frontend should probably do the UI part and the backend the server part." : "frontend: build index.html and styles.css for the todo list\nbackend: build server.js with a /todos API") };
  }
  if (lastText.endsWith("Your line:")) {
    const goal = lastText.split("User's message: ")[1]?.split("\n")[0] ?? "";
    if (persona === "badplanner") return { text: wrap("Absolutely, I'd love to help with that!") };
    if (/^(hi|hello)\b/i.test(goal)) return { text: wrap("chat: Hello! What should we build?") };
    return { text: wrap("work") };
  }
  if (lastText.endsWith("Your lines:")) {
    if (persona === "badplanner") return { text: wrap("First, someone should design the page. Then the server can be built, and we deploy it.") };
    const ids = [...lastText.matchAll(/^ {2}([\w-]+) — /gm)].map((m) => m[1]!);
    return { text: wrap(ids.map((id) => (/front|ui|design/i.test(id) ? `${id}: create index.html, styles.css and script.js for the landing page` : /back|server|api/i.test(id) ? `${id}: create server.js, package.json with a start script, and README.md with run and deploy steps` : `${id}: -`)).join("\n")) };
  }
  if (lastText.includes("review the finished work")) return { text: JSON.stringify({ summary: [`Built the ${NAME} site and its server.`], next: [] }) };

  const tools: string[] = (body.tools ?? []).map((t: any) => t.function?.name);
  if (!tools.length) return { text: wrap("Done.") };

  const action = nextAction(msgs, persona, tools);
  // Forced turns: llama.cpp's grammar, or an MLX reply niti started for the model.
  const prefill = last?.role === "assistant" ? textOf(last) : undefined;
  if (persona !== "chatty") {
    if (body.tool_choice === "required") return { tool: action };
    if (prefill) {
      // An engine that doesn't continue a started reply writes the whole call again, pretty-printed.
      if (process.env.NITI_FAKE_FRESH_PREFILL === "1") return { text: JSON.stringify({ name: action.name, arguments: action.args }, null, 2) };
      return { text: continuePrefill(prefill, action) };
    }
  }
  const firstTurn = !msgs.some((m) => m.role === "assistant");
  const r = dress(action, persona, firstTurn);
  return r.text !== undefined ? { text: wrap(r.text) } : r;
}

// The persona a fake engine was started for, from its model id or folder.
export function personaOf(idOrPath: string): Persona | undefined {
  const m = /zoo(?:\/|__)([a-z0-9]+)-(?:GGUF|MLX)/i.exec(idOrPath);
  return m && (PERSONAS as readonly string[]).includes(m[1]!) ? (m[1] as Persona) : undefined;
}
