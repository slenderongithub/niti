// A proxy in front of the repo's fake model (scripts/e2e/fakellm.ts) that makes a run look like a
// real one to the UI: plain-text replies get a long markdown body and arrive as ~4-character deltas
// every 15ms, instead of one chunk. JSON replies (plans, verdicts) and tool calls pass through
// untouched, so the run still behaves exactly like the fake model's. Used by scripts/perf.ts.
//   bun scripts/chunkllm.ts <port> <upstream-port>

const port = Number(process.argv[2]);
const upstream = Number(process.argv[3]);

const BODY = `

## What changed

The page now renders a **heading**, a list of posts and a sidebar. Each post shows its title, score
and comment count, and the layout collapses to one column under \`640px\`.

- \`index.html\` holds the markup and links the stylesheet
- \`style.css\` sets the grid, colours and type scale
- posts are static for now; wiring them to an API is the obvious next step

\`\`\`css
.post { display: grid; grid-template-columns: 48px 1fr; gap: 12px; }
.score { font-variant-numeric: tabular-nums; text-align: center; }
\`\`\`

| file | lines |
| --- | --- |
| index.html | 1 |
| style.css | 1 |

Next I'd add voting and a comment thread view, then tests for both.`;

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const res = await fetch(`http://127.0.0.1:${upstream}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: req.method === "POST" ? await req.text() : undefined });
    if (!res.headers.get("content-type")?.includes("text/event-stream")) return res;
    const text = await res.text();
    const chunks = text.split("\n\n").filter((c) => c.startsWith("data: "));
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(ctl) {
        for (const c of chunks) {
          const raw = c.slice(6);
          if (raw === "[DONE]") {
            ctl.enqueue(enc.encode("data: [DONE]\n\n"));
            continue;
          }
          const j = JSON.parse(raw);
          const content: string | undefined = j.choices?.[0]?.delta?.content;
          if (typeof content !== "string" || /^\s*[[{]/.test(content)) {
            ctl.enqueue(enc.encode(`data: ${raw}\n\n`));
            continue;
          }
          const full = content + BODY;
          for (let i = 0; i < full.length; i += 4) {
            const piece = { ...j, choices: [{ ...j.choices[0], delta: { ...(i === 0 ? j.choices[0].delta : {}), content: full.slice(i, i + 4) } }] };
            ctl.enqueue(enc.encode(`data: ${JSON.stringify(piece)}\n\n`));
            await Bun.sleep(15);
          }
        }
        ctl.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});
console.log(`chunk proxy on ${port} → ${upstream}`);
