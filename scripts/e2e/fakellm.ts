// A scripted OpenAI-compatible chat server for end-to-end tests of niti. No network, no cost.
// Behaviour: planner prompts get a 2-task plan; a worker with no tool result yet writes a file;
// after a tool result it finishes; anything else gets a short text answer.
const port = Number(process.argv[2] ?? 47990);
const log: string[] = [];

function reply(body: any): { text?: string; tool?: { name: string; args: unknown } } {
  const msgs: any[] = body.messages ?? [];
  const all = JSON.stringify(msgs);
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  const lastText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
  const hasToolResult = msgs.some((m) => m.role === "tool");
  const tools: string[] = (body.tools ?? []).map((t: any) => t.function?.name);
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

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "fake" }] });
    if (!url.pathname.endsWith("/chat/completions")) return new Response("nope", { status: 404 });
    const body = await req.json();
    if (JSON.stringify(body.messages ?? []).includes("SLOW")) await new Promise((r) => setTimeout(r, 1500));
    const r = reply(body);
    if (JSON.stringify(body.messages ?? []).includes("STEER-MARKER")) log.push("SAW-STEER");
    log.push(JSON.stringify({ stream: !!body.stream, tool: r.tool?.name, text: r.text?.slice(0, 40) }));
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
setInterval(() => Bun.write(`${process.argv[3] ?? "/tmp"}/fakellm.log`, log.join("\n")), 300);
console.log(`fake llm on ${port}`);
