// A scripted OpenAI-compatible chat server for end-to-end tests of niti. No network, no cost.
// Behaviour: planner prompts get a 2-task plan; a worker with no tool result yet writes a file;
// after a tool result it finishes; /goal's judge says "not yet" once, then "done"; anything else
// gets a short text answer.
const port = Number(process.argv[2] ?? 47990);
const log: string[] = [];
let judged = 0; // /goal's judge: "not yet" the first time, "done" after that

// A local agent (the action protocol offers `finish`) ends a task by calling it, as a well-behaved
// local model does; anything else ends on text.
function reply(body: any): { text?: string; tool?: { name: string; args: unknown } } {
  const r = script(body);
  const tools: string[] = (body.tools ?? []).map((t: any) => t.function?.name);
  return r.text !== undefined && tools.includes("finish") ? { tool: { name: "finish", args: { summary: r.text } } } : r;
}

function script(body: any): { text?: string; tool?: { name: string; args: unknown } } {
  const msgs: any[] = body.messages ?? [];
  const all = JSON.stringify(msgs);
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  const lastText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
  const hasToolResult = msgs.some((m) => m.role === "tool");
  const tools: string[] = (body.tools ?? []).map((t: any) => t.function?.name);
  // niti's one-time model check (src/local/probe.ts): a model that calls tools and can plan.
  if (lastText.includes("Create a file named hello.txt") && !hasToolResult) return { tool: { name: "write_file", args: { path: "hello.txt", content: "hi" } } };
  if (lastText.includes("Write exactly one line per teammate")) return { text: "frontend: build index.html and styles.css for the todo list\nbackend: build server.js with a /todos API" };
  // The local planner's two stages (planner.ts makeLocalPlan): the kind of message, then a line each.
  if (lastText.endsWith("Your line:")) {
    const goal = lastText.split("User's message: ")[1]?.split("\n")[0] ?? "";
    if (/^(hi|hello)/i.test(goal)) return { text: "chat: Hello! What should we build?" };
    if (goal.trim().endsWith("?")) return { text: `question: ${goal}` };
    return { text: "work" };
  }
  if (lastText.endsWith("Your lines:")) {
    const goal = lastText.split("User's request: ")[1]?.split("\n")[0] ?? "";
    const ids = [...lastText.matchAll(/^  ([\w-]+) — /gm)].map((m) => m[1]!);
    if (goal.includes("CALL:")) return { text: ids.map((id) => (id === "backend" ? `backend: ${goal}` : `${id}: -`)).join("\n") };
    return { text: ids.map((id, i) => `${id}: ${i === 0 ? "create index.html with a heading" : "create style.css"}`).join("\n") };
  }
  if (lastText.includes("talking with the user")) {
    const goal = lastText.split("User's message: ")[1]?.split("\n")[0] ?? "";
    if (/^(hi|hello)/i.test(goal)) return { text: JSON.stringify({ reply: "Hello! What should we build?" }) };
    if (goal.trim().endsWith("?")) return { text: JSON.stringify({ question: goal }) };
    if (goal.includes("CALL:")) return { text: JSON.stringify([{ id: "t1", description: goal, role: "backend" }]) };
    return { text: JSON.stringify([
      { id: "t1", description: "create index.html with a heading" + (goal.includes("SLOW") ? " SLOW" : ""), role: "backend" },
      { id: "t2", description: "create style.css", role: "frontend", dependsOn: ["t1"] },
    ]) };
  }
  if (lastText.includes("NITI-GOAL-JUDGE")) {
    log.push("JUDGE");
    return { text: JSON.stringify(judged++ === 0 ? { done: false, reason: "only half there", next: "finish the styling" } : { done: true, reason: "both files exist" }) };
  }
  const texts = msgs.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
  const directive = texts.match(/CALL:(\{.*?\})END/s);
  if (directive) {
    if (!hasToolResult) {
      const c = JSON.parse(directive[1]!);
      return { tool: { name: c.name, args: c.args } };
    }
    const last = [...msgs].reverse().find((m) => m.role === "tool");
    return { text: `RESULT<<${String(last?.content ?? "").slice(0, 400)}>>` };
  }
  if (tools.includes("write_file") && !hasToolResult) {
    const file = /style\.css/.test(all) ? "style.css" : "index.html";
    return { tool: { name: "write_file", args: { path: file, content: file === "index.html" ? "<h1>reddit replica</h1>\n" : "h1{color:orange}\n" } } };
  }
  if (/VERDICT/.test(lastText)) return { text: "Looks right.\nVERDICT: approve" };
  return { text: "Done. Summary: the files were created." };
}

// A pocket Hugging Face for the local-models path (NITI_HF_URL points here): one tool-capable GGUF
// repo, its file, and its model card. The "weights" are a few KB, so a download is instant.
const HUB_REPO = "fake-org/Tiny-Coder-GGUF";
const WEIGHTS = new TextEncoder().encode("GGUF" + "w".repeat(64 * 1024));
const WEIGHTS_SHA = new Bun.CryptoHasher("sha256").update(WEIGHTS).digest("hex");
const hubModel = (sizes: boolean) => ({
  id: HUB_REPO,
  author: "fake-org",
  downloads: 4200,
  likes: 42,
  trendingScore: 7,
  lastModified: "2026-10-01T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  gated: false,
  tags: ["gguf", "license:apache-2.0"],
  cardData: { license: "apache-2.0", base_model: "fake-org/Tiny-Coder" },
  gguf: { total: 1_000_000_000, architecture: "qwen3", context_length: 32768, chat_template: "{% if tools %}<tool_call>{{ tools }}</tool_call>{% endif %}" },
  siblings: [{ rfilename: "Tiny-Coder-Q4_K_M.gguf", ...(sizes ? { size: WEIGHTS.length, lfs: { sha256: WEIGHTS_SHA, size: WEIGHTS.length } } : {}) }, { rfilename: "README.md" }],
});
// And one MLX repo, for the MLX side of the Models page.
const mlxModel = {
  id: "fake-org/Tiny-Coder-MLX-4bit",
  author: "fake-org",
  downloads: 900,
  likes: 9,
  lastModified: "2026-10-01T00:00:00.000Z",
  gated: false,
  tags: ["mlx", "license:apache-2.0"],
  cardData: { license: "apache-2.0", base_model: "fake-org/Tiny-Coder-Base" },
  config: { model_type: "qwen2", tokenizer_config: { chat_template: "{% if tools %}<tool_call>{{ tools }}</tool_call>{% endif %}" } },
  siblings: ["config.json", "model.safetensors", "tokenizer.json", "tokenizer_config.json"].map((rfilename) => ({ rfilename, size: 64 })),
};

function hub(path: string, filter?: string | null): Response | undefined {
  if (path === "/api/models") return Response.json(filter === "mlx" ? [mlxModel] : [hubModel(false)]);
  if (path === `/api/models/${mlxModel.id}`) return Response.json(mlxModel);
  if (path === `/api/models/${HUB_REPO}`) return Response.json(hubModel(true));
  if (path === `/${HUB_REPO}/resolve/main/Tiny-Coder-Q4_K_M.gguf`) return new Response(WEIGHTS);
  if (path === `/${HUB_REPO}/raw/main/README.md`) return new Response("---\nlicense: apache-2.0\n---\n# Tiny Coder\n\nA scripted model for niti's tests.");
  if (path.startsWith("/api/") || path.includes("/raw/main/") || path.includes("/resolve/main/")) return new Response("not found", { status: 404 });
  return undefined;
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const fromHub = hub(url.pathname, url.searchParams.get("filter"));
    if (fromHub) return fromHub;
    if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "fake" }] });
    // What llama-server answers, for scripts/e2e/fakellama.ts standing in for the local runtime.
    if (url.pathname === "/health") return Response.json({ status: "ok" });
    const key = process.env.NITI_FAKE_API_KEY;
    if (key && req.headers.get("authorization") !== `Bearer ${key}`) return Response.json({ error: { message: "Invalid API Key" } }, { status: 401 });
    if (url.pathname === "/props") return Response.json({ default_generation_settings: { n_ctx: 16384 }, chat_template: "{% if tools %}<tool_call>{{ tools }}</tool_call>{% endif %}" });
    if (!url.pathname.endsWith("/chat/completions")) return new Response("nope", { status: 404 });
    const body = await req.json();
    if (JSON.stringify(body.messages ?? []).includes("SLOW")) await new Promise((r) => setTimeout(r, 1500));
    const r = reply(body);
    if (JSON.stringify(body.messages ?? []).includes("STEER-MARKER")) log.push("SAW-STEER");
    if (body.id_slot !== undefined) log.push(`LOCAL slot=${body.id_slot} temp=${body.temperature} max=${body.max_tokens}`);
    // What niti sends the MLX engine: the served model's fixed name, and a request for usage.
    if (body.model === "default_model") log.push(`MLX model=default_model temp=${body.temperature} usage=${body.stream_options?.include_usage === true} slot=${body.id_slot ?? "none"}`);
    log.push(JSON.stringify({ stream: !!body.stream, tool: r.tool?.name, text: r.text?.slice(0, 40) }));
    void flush(); // on every request too: a check reading the log right after a run sees it whole
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    if (!body.stream) {
      const message = r.tool
        ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: r.tool.name, arguments: JSON.stringify(r.tool.args) } }] }
        : { role: "assistant", content: r.text };
      return Response.json({ id: "x", object: "chat.completion", created: 0, model: body.model, choices: [{ index: 0, message, finish_reason: r.tool ? "tool_calls" : "stop" }], usage });
    }
    const chunks: any[] = [];
    const base = { id: "x", object: "chat.completion.chunk", created: 0, model: body.model };
    if (r.tool) {
      chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: r.tool.name, arguments: "" } }] }, finish_reason: null }] });
      chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(r.tool.args) } }] }, finish_reason: null }] });
      chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: r.text }, finish_reason: null }] });
      chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    chunks.push({ ...base, choices: [], usage });
    const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  },
});
const logFile = `${process.argv[3] ?? "/tmp"}/fakellm.log`;
const flush = () => Bun.write(logFile, log.join("\n"));
setInterval(flush, 300);
console.log(`fake llm on ${port}`);
