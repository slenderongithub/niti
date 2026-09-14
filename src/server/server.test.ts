import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Engine } from "../engine.ts";
import { startServer, splitModelId, tokensMatch, type ServerHandle } from "./server.ts";
import type { Provider, ProviderReply } from "../providers/provider.ts";
import type { AgentConfig } from "../agent/agent.ts";

// A scripted provider: returns a DAG plan to the orchestrator, an integrate summary on review,
// and plain "done" text for task work. No network.
const fake: Provider = {
  async send(_sys, turns): Promise<ProviderReply> {
    const last = turns[turns.length - 1];
    const text = last && "text" in last ? last.text : "";
    if (text.includes("orchestrator of a team")) {
      return {
        text: JSON.stringify([
          { id: "a", description: "design the UI", role: "frontend", handoffTo: ["backend"] },
          { id: "b", description: "build the API", role: "backend", dependsOn: ["a"] },
        ]),
        toolCalls: [],
      };
    }
    if (text.includes("review the finished project")) {
      return { text: "UI feeds the frontend; backend serves the API.", toolCalls: [] };
    }
    return { text: "done working on it", toolCalls: [] };
  },
};

const configs: AgentConfig[] = [
  { id: "orchestrator", provider: "anthropic", model: "x", role: "Orchestrator", systemPrompt: "lead", lead: true, allowedTools: [] },
  { id: "frontend", provider: "anthropic", model: "x", role: "Frontend", systemPrompt: "fe", allowedTools: [] },
  { id: "backend", provider: "anthropic", model: "x", role: "Backend", systemPrompt: "be", allowedTools: [] },
];

function setup(): { engine: Engine; h: ServerHandle } {
  const engine = new Engine({ configs, makeProvider: () => fake, interactive: false });
  return { engine, h: startServer(engine) };
}

let handles: ServerHandle[] = [];
afterEach(() => {
  for (const h of handles) h.stop();
  handles = [];
});
function track(h: ServerHandle): ServerHandle {
  handles.push(h);
  return h;
}

const timeout = (ms: number) => new Promise<{ done: true }>((r) => setTimeout(() => r({ done: true }), ms));

test("splitModelId parses provider/model only when the head is a known provider", () => {
  expect(splitModelId(undefined, "anthropic/claude-opus-4-8")).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
  expect(splitModelId(undefined, "some-random-model")).toEqual({ provider: "", model: "some-random-model" });
  expect(splitModelId("openai", "gpt-4o")).toEqual({ provider: "openai", model: "gpt-4o" });
});

test("tokensMatch: equal tokens match, unequal/absent/wrong-length don't", () => {
  expect(tokensMatch("abc123", "abc123")).toBe(true);
  expect(tokensMatch("abc124", "abc123")).toBe(false);
  expect(tokensMatch("abc12", "abc123")).toBe(false); // different length
  expect(tokensMatch(null, "abc123")).toBe(false);
  expect(tokensMatch(undefined, "abc123")).toBe(false);
  expect(tokensMatch("", "abc123")).toBe(false);
});

test("health is public; data routes require the token", async () => {
  const { h } = setup();
  track(h);
  expect((await (await fetch(`${h.url}/health`)).json())).toMatchObject({ ok: true });
  expect((await fetch(`${h.url}/session`, { method: "POST" })).status).toBe(401);
  const ok = await fetch(`${h.url}/session`, { method: "POST", headers: { authorization: `Bearer ${h.token}` } });
  expect(ok.status).toBe(200);
  expect((await ok.json()).agents.length).toBe(3);
});

test("static dashboard assets carry a Content-Security-Policy header", async () => {
  const { h } = setup();
  track(h);
  const res = await fetch(`${h.url}/dashboard`);
  const csp = res.headers.get("content-security-policy");
  expect(csp).toBeTruthy();
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
});

test("commands are listed and dispatched over HTTP — one registry for every client", async () => {
  const { h } = setup();
  track(h);
  const list = await (await fetch(`${h.url}/commands?token=${h.token}`)).json();
  expect(list.commands.map((c: { name: string }) => c.name)).toContain("undo");

  const run = async (name: string, args = "") =>
    (await fetch(`${h.url}/commands/${name}?token=${h.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) })).json();

  expect(await run("usage")).toMatchObject({ ok: true, view: "usage" }); // client-side view switch
  expect(await run("cancel")).toMatchObject({ ok: true });
  // A command that fails still answers 200 with ok:false — the message belongs to the caller, not
  // to an HTTP error path.
  expect(await run("bogus")).toMatchObject({ ok: false, message: "unknown command: /bogus" });
});

test("sessions are listable once a store is wired (empty without one)", async () => {
  const { h } = setup();
  track(h);
  expect(await (await fetch(`${h.url}/sessions?token=${h.token}`)).json()).toEqual({ sessions: [] });
});

test("worktree routes are gated by the token and report idle when no run is isolated", async () => {
  const { h } = setup();
  track(h);
  expect((await fetch(`${h.url}/worktree`)).status).toBe(401);
  expect(await (await fetch(`${h.url}/worktree?token=${h.token}`)).json()).toEqual({ active: false });
  expect(await (await fetch(`${h.url}/worktree/merge?token=${h.token}`, { method: "POST" })).json()).toEqual({ ok: false, message: "no active worktree" });
});

test("providers and models routes serve the catalog", async () => {
  const { h } = setup();
  track(h);
  const provs = await (await fetch(`${h.url}/providers?token=${h.token}`)).json();
  expect(provs.providers.byok.some((p: any) => p.id === "anthropic")).toBe(true);
  const models = await (await fetch(`${h.url}/models?provider=anthropic&token=${h.token}`)).json();
  expect(models.models.length).toBeGreaterThan(0);
});

test("live model switch works through the engine's provider factory", async () => {
  const { h } = setup();
  track(h);
  const res = await fetch(`${h.url}/model?token=${h.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "frontend", provider: "anthropic", model: "claude-haiku-4-5" }),
  });
  expect((await res.json())).toMatchObject({ ok: true });
});

test("mid-task agent messaging: 400 on an empty body, 409 for an idle agent (nothing to interrupt)", async () => {
  const { h } = setup();
  track(h);
  const send = (agentId: string, body: unknown) =>
    fetch(`${h.url}/agents/${agentId}/message?token=${h.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  expect((await send("frontend", { text: "" })).status).toBe(400);
  const idle = await send("frontend", { text: "actually use approach B" });
  expect(idle.status).toBe(409);
  expect((await idle.json()).error).toContain("isn't running");
});

test("auth store round-trips through the API (redacted on read)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "niti-srv-"));
  process.env.NITI_AUTH_FILE = join(dir, "auth.json");
  try {
    const { h } = setup();
    track(h);
    const post = await fetch(`${h.url}/auth?token=${h.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", type: "api", key: "sk-secret" }),
    });
    expect((await post.json())).toMatchObject({ ok: true });
    const list = await (await fetch(`${h.url}/auth?token=${h.token}`)).json();
    expect(list.credentials).toEqual([{ provider: "openai", type: "api" }]); // key redacted
  } finally {
    delete process.env.NITI_AUTH_FILE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serves the self-contained dashboard shell without a token", async () => {
  const { h } = setup();
  track(h);
  const page = await fetch(`${h.url}/dashboard`);
  expect(page.headers.get("content-type")).toContain("text/html");
  const html = await page.text();
  expect(html).toContain('src="/app.js"');
  const js = await fetch(`${h.url}/app.js`);
  expect(js.headers.get("content-type")).toContain("javascript");
  expect((await fetch(`${h.url}/style.css`)).headers.get("content-type")).toContain("css");
});

test("the interactive graph page is public; its /graph data stays gated", async () => {
  const { h } = setup();
  track(h);
  const page = await fetch(`${h.url}/graph/view`); // no token — the shell is public
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(await page.text()).toContain('src="/graph.js"');
  expect((await fetch(`${h.url}/graph.js`)).headers.get("content-type")).toContain("javascript");
  // The data route it calls is still token-gated.
  expect((await fetch(`${h.url}/graph`)).status).toBe(401);
  expect((await fetch(`${h.url}/graph?token=${h.token}`)).status).toBe(200);
});

test("a submitted goal streams orchestration + agent-message events over SSE", async () => {
  const { engine, h } = setup();
  track(h);
  await engine.submit("build me a clothing website for gen-z"); // run to completion → hub buffered

  const res = await fetch(`${h.url}/events?from=0&token=${h.token}`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (let i = 0; i < 8; i++) {
    const r = await Promise.race([reader.read(), timeout(500)]);
    if ("done" in r && r.done) break;
    if ((r as ReadableStreamReadResult<Uint8Array>).value) buf += dec.decode((r as ReadableStreamReadResult<Uint8Array>).value);
    if (buf.includes('"complete"')) break;
  }
  await reader.cancel();

  expect(buf).toContain('"kind":"orchestration"');
  expect(buf).toContain('"kind":"agent_message"'); // the frontend→backend hand-off artifact
  expect(buf).toContain('"type":"complete"');
  // the DAG really ran and both tasks finished
  expect(engine.orch.all.every((t) => t.status === "done")).toBe(true);
});

test("/graph's cache drops on a file_edit event, not just external_change — an agent's own write is not served stale", async () => {
  const root = mkdtempSync(join(tmpdir(), "niti-graph-cache-"));
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  const engine = new Engine({ configs, makeProvider: () => fake, interactive: false, root });
  const h = startServer(engine);
  track(h);

  const before = await (await fetch(`${h.url}/graph?token=${h.token}`)).json();
  expect(before.nodes).toHaveLength(1); // just a.ts

  // A new file lands on disk (as an agent's write_file would produce) — GRAPH_TTL_MS is 10s, so
  // without dropping the cache on file_edit, the next fetch would still return the stale 1-node graph.
  writeFileSync(join(root, "b.ts"), "export const b = 2;\n");
  engine.bus.publish({ agentId: "frontend", type: "file_edit", payload: "wrote b.ts", time: Date.now() });

  const after = await (await fetch(`${h.url}/graph?token=${h.token}`)).json();
  expect(after.nodes).toHaveLength(2); // a.ts and b.ts — cache was invalidated, not served stale
});
