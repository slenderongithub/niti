import { dirname, join, normalize } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
// Embedded, not read from disk: this is also the Go TUI's //go:embed source, and a compiled
// niti-core has no repo around it to find the file in. One copy, compiled into both binaries.
import palettes from "../../tui/internal/theme/palettes.json";
import type { Engine } from "../engine.ts";
import type { ServerEvent } from "./events.ts";
import { CATALOG, contextWindow, providersByCategory, splitModelId, type Category } from "../providers/catalog.ts";
import { costOf } from "../providers/pricing.ts";
import { buildFileGraph, trackedFiles } from "../graph/filegraph.ts";
import { listCredentials, setCredential, removeCredential, type AuthCredential } from "../auth/auth-store.ts";
import { saveAgents, setTheme, setAuto } from "../config/config.ts";
import { CommandRegistry } from "../commands/registry.ts";
import type { AgentConfig } from "../agent/agent.ts";
import { makeProvider } from "../providers/factory.ts";
import { summarizeError, scrubSecrets } from "../providers/provider.ts";

export interface ServerHandle {
  url: string;
  token: string;
  port: number;
  stop: () => void;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

// Defense-in-depth, not a fix for a found XSS: every dynamic-content insertion site in web/*.js
// already goes through a hand-rolled esc() escaper (checked, consistently applied). This is the
// backstop for the one call site someone forgets in the future — and it matters more here than on
// a typical page because the dashboard URL itself carries the bearer token as ?token=, so a missed
// escape would be a token-exfiltration path, not just a defacement.
// style-src needs 'unsafe-inline' for graph.html's one inline <style> block; nothing else here uses
// inline script or style.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'";

// A private-by-default local server (127.0.0.1 + a bearer token from the handshake). The Go TUI
// sends the token as a header; the browser dashboard passes it as ?token= (EventSource can't set
// headers). Static dashboard assets are public; every data route is gated.
export function startServer(
  engine: Engine,
  opts: {
    port?: number;
    token?: string;
    webDir?: string;
    commands?: CommandRegistry;
    theme?: string;
    makeProvider?: typeof makeProvider;
  } = {},
): ServerHandle {
  const token = opts.token ?? crypto.randomUUID();
  const webDir = opts.webDir ?? resolveWebDir();
  const commands = opts.commands ?? new CommandRegistry();
  // Same DI seam as Engine's own `makeProvider` option — /complete calls a provider directly,
  // bypassing the engine, so it needs its own injection point for tests to avoid real network calls.
  const makeCompletionProvider = opts.makeProvider ?? makeProvider;
  // Mutable, unlike the rest of `opts` — POST /theme updates this in place so /session reflects a
  // theme changed mid-session (by the TUI carousel or the web dropdown) without a server restart.
  let currentTheme = opts.theme ?? "";

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

  const serveFile = (rel: string): Response => {
    const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const file = join(webDir, safe);
    if (!file.startsWith(webDir) || !existsSync(file)) return json({ error: "not found" }, 404);
    // /dashboard/* is unauthenticated by design (it's the shell that then asks for a token), but
    // web/ also contains *.test.ts next to the runtime files in a source checkout. Those are not
    // assets and there is no reason to hand them to an unauthenticated caller.
    if (/\.(test|spec)\.[jt]sx?$/.test(safe)) return json({ error: "not found" }, 404);
    const ext = file.slice(file.lastIndexOf("."));
    // No cache-control here previously meant a browser was free to serve a stale cached copy of
    // graph.js/app.js/etc. across visits with no way to tell — every edit to web/ ships live from
    // disk on the next request, so a client should never need to guess whether its copy is current.
    return new Response(readFileSync(file), {
      headers: {
        "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        "cache-control": "no-cache",
        // Content types here are decided by extension from a fixed map; nosniff stops a browser
        // second-guessing that and executing something served as octet-stream.
        "x-content-type-options": "nosniff",
        "content-security-policy": CSP,
      },
    });
  };

  const servePalettes = (): Response => json(palettes);

  // buildFileGraph walks the project and reads every source file to extract imports — synchronously,
  // on the event loop. The graph page polls this, so a large repo stalled every other route
  // (including the SSE stream) for the duration, repeatedly, for a tree that changes rarely.
  let graphCache: { at: number; root: string; value: ReturnType<typeof buildFileGraph> } | undefined;
  const GRAPH_TTL_MS = 10_000;
  const fileGraph = (root: string) => {
    const now = Date.now();
    if (graphCache && graphCache.root === root && now - graphCache.at < GRAPH_TTL_MS) return graphCache.value;
    // Same correction the agent-facing project map needs: the walk cannot tell this project
    // from a vendored tree checked out inside it, and would render that tree instead.
    const value = buildFileGraph(root, 400, trackedFiles(root));
    graphCache = { at: now, root, value };
    return value;
  };
  // The watcher tells every SSE client a file changed outside niti (kind: "agent_event", type:
  // "external_change"), and an agent's own write_file/edit publishes "file_edit" — the graph page
  // reacts live to both, so the cache has to drop on both, or its refetch could still be served up
  // to GRAPH_TTL_MS of stale data.
  engine.hub.subscribe((e) => {
    if (e.kind === "agent_event" && (e.event.type === "external_change" || e.event.type === "file_edit")) graphCache = undefined;
  });

  const sse = (fromSeq: number): Response => {
    const enc = new TextEncoder();
    let unsub = () => {};
    let ping: ReturnType<typeof setInterval>;
    let closed = false;
    // Idempotent, and called from every path that can discover a dead client — not just cancel().
    // A browser that closes the body gracefully never fires cancel(), so the hub subscription and
    // the 25s interval both leaked for the life of the process, one pair per reconnect.
    let close = () => {};
    const stream = new ReadableStream({
      start(controller) {
        close = () => {
          if (closed) return;
          closed = true;
          clearInterval(ping);
          unsub();
          try {
            controller.close();
          } catch {
            /* already closed by the runtime */
          }
        };
        const send = (e: ServerEvent) => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`));
          } catch {
            close(); // client went away between checks
          }
          // Backpressure: a client that has fallen ~1MB behind is not keeping up, and buffering
          // for it is how a slow tab turns into unbounded memory. Drop it — it can reconnect and
          // replay from Last-Event-ID.
          if (controller.desiredSize !== null && controller.desiredSize < -1_000_000) close();
        };
        for (const e of engine.hub.replay(fromSeq)) send(e); // backfill so late joiners are consistent
        unsub = engine.hub.subscribe(send);
        ping = setInterval(() => {
          try {
            controller.enqueue(enc.encode(`: ping\n\n`));
          } catch {
            close(); // the ping is also the liveness probe: if it throws, nothing else will notice
          }
        }, 25_000);
      },
      cancel() {
        close();
      },
    },
    // Bytes, not chunks: without this desiredSize counts *messages*, so the backpressure check in
    // send() would be measuring the wrong unit entirely.
    new ByteLengthQueuingStrategy({ highWaterMark: 1 << 20 }));
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  };

  // The desktop app's renderer loads from file:// (no "web siblings" — see project_context.md),
  // which makes every fetch/EventSource call here cross-origin; the TUI never hits this (it isn't a
  // browser) and the browser dashboard never did either (same-origin, served from this same
  // server). CORS headers are the only thing standing between the desktop app and "every request
  // silently fails." `*` rather than echoing the request Origin because the security boundary here
  // has always been the bearer token, not network topology — see tokensMatch below; anyone who
  // already has the token can call this API directly with curl anyway, so a permissive CORS policy
  // grants no meaningfully new access to an attacker who doesn't have it.
  const CORS_HEADERS: Record<string, string> = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
  };
  const withCors = (res: Response): Response => {
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
    return res;
  };

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    idleTimeout: 0, // SSE connections are long-lived
    async fetch(req) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      return withCors(await handle(req));
    },
  });

  async function handle(req: Request): Promise<Response> {
      const u = new URL(req.url);
      const p = u.pathname;
      const method = req.method;

      // --- public: health + static dashboard shell ---
      if (p === "/health") return json({ ok: true, name: "niti", running: engine.running });
      if (p === "/" || p === "/dashboard" || p === "/dashboard/") return serveFile("index.html");
      if (p.startsWith("/dashboard/")) return serveFile(p.slice("/dashboard/".length));
      if (p === "/app.js" || p === "/style.css" || p === "/theme.js" || p === "/avatar.js") return serveFile(p.slice(1));
      if (p === "/palettes.json") return servePalettes();
      // The interactive graph page — public shell like the dashboard; its /graph and /events calls
      // carry the token via ?token=. (Distinct from the gated data route `/graph` below.)
      if (p === "/graph/view" || p === "/graph/view/") return serveFile("graph.html");
      if (p === "/graph.js") return serveFile("graph.js");

      // --- everything below requires the token (header or ?token=) ---
      const bearer = req.headers.get("authorization");
      const provided = bearer?.startsWith("Bearer ") ? bearer.slice(7) : u.searchParams.get("token");
      if (!tokensMatch(provided, token)) return json({ error: "unauthorized" }, 401);

      if (p === "/events" && method === "GET") {
        // EventSource resends the last id it saw as Last-Event-ID on every automatic reconnect.
        // Ignoring it meant browser clients always came back with from=0 and replayed the entire
        // 2000-event buffer, duplicating the whole UI history on every network blip.
        const resume = Number(req.headers.get("last-event-id") ?? u.searchParams.get("from") ?? 0);
        return sse(Number.isFinite(resume) && resume > 0 ? resume : 0);
      }

      if (p === "/session" && method === "POST") {
        engine.emitUsage();
        return json({
          agents: engine.configs,
          tasks: engine.orch.all,
          lastSeq: engine.hub.lastSeq(),
          running: engine.running,
          // Everything the TUI's sidebar reports about the project it's attached to. Static for the
          // life of the process, so it rides on /session rather than being re-sent on every event.
          root: engine.root,
          lsp: engine.lsp?.list() ?? [],
          mcp: engine.mcp?.servers?.() ?? [],
          contextLimits: Object.fromEntries(engine.configs.map((c) => [c.id, contextWindow(c.provider)])),
          theme: currentTheme, // `theme:` from agents.yaml, or whatever POST /theme last set
        });
      }

      // A direct, single-model call independent of the orchestration engine — for editor-side
      // features (inline completion, Cmd+K) that need one fast round-trip and must work whether or
      // not a team is currently running. /prompt is the wrong shape for this: it's single-flight
      // (409 while engine.running) and always launches the full multi-agent orchestrator.
      if (p === "/complete" && method === "POST") {
        const body = (await req.json().catch(() => ({}))) as {
          provider?: string;
          model?: string;
          prompt?: string;
          system?: string;
          baseURL?: string;
        };
        if (!body.provider || !body.model || !body.prompt?.trim()) {
          return json({ error: "expected {provider, model, prompt}" }, 400);
        }
        try {
          const provider = makeCompletionProvider({
            id: "complete",
            provider: body.provider,
            model: body.model,
            role: "completion",
            systemPrompt: body.system ?? "",
            baseURL: body.baseURL,
          });
          // Same redaction scrubSecrets already applies to outbound error text (see its own doc
          // comment) — a completion/edit prompt built from a user's open files is exactly as likely
          // to accidentally carry a live key (a .env snippet, a config file with a token in it) as
          // an error message is, and this is the literal last point before it leaves the process to
          // a third-party provider.
          const reply = await provider.send(scrubSecrets(body.system ?? ""), [{ role: "user", text: scrubSecrets(body.prompt) }], []);
          return json({ text: reply.text });
        } catch (err) {
          return json({ error: summarizeError(err) }, 400);
        }
      }

      // Batch text embedding for editor-side semantic search (niti IDE's codebase index) — same
      // bypass-the-engine reasoning as /complete. Not every provider supports this (see Provider.embed's
      // doc comment), so a provider without it is a clean 400, not a 500.
      if (p === "/embed" && method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { provider?: string; texts?: string[]; baseURL?: string };
        if (!body.provider || !Array.isArray(body.texts) || !body.texts.length) {
          return json({ error: "expected {provider, texts: string[]}" }, 400);
        }
        try {
          const provider = makeCompletionProvider({
            id: "embed",
            provider: body.provider,
            model: "embed", // unused for embeddings — see e.g. GeminiProvider.embed's fixed model id
            role: "embed",
            systemPrompt: "",
            baseURL: body.baseURL,
          });
          if (!provider.embed) return json({ error: `provider '${body.provider}' does not support embeddings` }, 400);
          const embeddings = await provider.embed(body.texts.map(scrubSecrets)); // same redaction as /complete, see its comment
          return json({ embeddings });
        } catch (err) {
          return json({ error: summarizeError(err) }, 400);
        }
      }

      if (p === "/prompt" && method === "POST") {
        const { text, mode } = (await req.json().catch(() => ({}))) as { text?: string; mode?: string };
        if (!text?.trim()) return json({ error: "empty prompt" }, 400);
        if (engine.running) return json({ error: "a task is already running" }, 409);
        // fire-and-forget; progress via SSE
        // POST /prompt has already returned 200 by the time this can fail, so console.error was the
        // *entire* report — and now that the TUI redirects core stderr to a log file, nothing would
        // surface it at all. Publish it, so both front ends show it in the transcript.
        engine.submit(text, { planOnly: mode === "plan" }).catch((err) => {
          engine.bus.publish({
            agentId: "orchestrator",
            type: "error",
            payload: `run failed: ${err instanceof Error ? err.message : err}`,
            time: Date.now(),
          });
        });
        return json({ accepted: true });
      }

      if (p === "/cancel" && method === "POST") {
        engine.cancel();
        return json({ ok: true });
      }

      if (p === "/undo" && method === "POST") return json({ ok: true, message: engine.undo() });

      // Slash commands: one registry, every client. GET to populate a menu/autocomplete, POST to run.
      if (p === "/commands" && method === "GET") return json({ commands: commands.list() });
      if (p.startsWith("/commands/") && method === "POST") {
        // A malformed percent-escape (%zz) makes decodeURIComponent throw, which escaped the
        // handler and got answered with Bun's HTML 500 fallback page — an HTML body to a JSON
        // client, plus a stack trace on stderr, from one bad byte in a URL.
        const name = safeDecode(p.slice("/commands/".length));
        if (name === undefined) return json({ error: "malformed command name" }, 400);
        const { args } = (await req.json().catch(() => ({}))) as { args?: string };
        // Always 200: the command was dispatched, and its own `ok` says how it went. A non-2xx
        // would strand that message in the client's generic error path.
        return json(await commands.run(engine, name, args ?? ""));
      }

      if (p === "/graph" && method === "GET") {
        try {
          return json(fileGraph(engine.root));
        } catch {
          return json({ nodes: [], edges: [] }); // scanning is best-effort; an unreadable tree isn't fatal
        }
      }

      if (p === "/stats" && method === "GET") {
        if (!engine.store) return json({ perDay: [], perModel: [], sessions: 0, inTokens: 0, outTokens: 0, longestSessionMs: 0, totalUsd: 0, costComplete: true });
        const s = engine.store.stats();
        let totalUsd = 0;
        let costComplete = true;
        let inTokens = 0;
        let outTokens = 0;
        const perModel = s.perModel.map((m) => {
          const { usd, priced } = costOf(m.provider, m.model, m.inTokens, m.outTokens);
          totalUsd += usd;
          if (!priced) costComplete = false;
          inTokens += m.inTokens;
          outTokens += m.outTokens;
          return { name: `${m.provider}/${m.model}`, inTokens: m.inTokens, outTokens: m.outTokens, msgs: m.msgs, usd, priced };
        });
        return json({ perDay: s.perDay, perModel, sessions: s.sessions, inTokens, outTokens, longestSessionMs: s.longestSessionMs, totalUsd, costComplete });
      }

      if (p === "/checkpoints" && method === "GET") {
        if (!engine.store) return json({ checkpoints: [] });
        const sessionId = u.searchParams.get("sessionId") ?? undefined;
        const limit = Number(u.searchParams.get("limit") ?? 20);
        return json({ checkpoints: engine.store.listCheckpoints(sessionId, limit) });
      }

      if (p === "/sessions" && method === "GET") {
        if (!engine.store) return json({ sessions: [] });
        const taskId = u.searchParams.get("taskId") ?? undefined;
        const agentId = u.searchParams.get("agentId") ?? undefined;
        return json({ sessions: engine.store.listSessions({ taskId, agentId }) });
      }

      if (p === "/agents" && method === "GET") return json({ agents: engine.configs });
      if (p === "/agents" && method === "POST") {
        const { agents } = (await req.json().catch(() => ({}))) as { agents?: AgentConfig[] };
        if (!Array.isArray(agents) || !agents.length) return json({ error: "expected agents[]" }, 400);
        try {
          saveAgents(agents); // validates first — a malformed body used to be written straight to disk
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
        return json({ ok: true, note: "saved to .niti/agents.yaml — restart the session to apply" });
      }

      if (p === "/theme" && method === "POST") {
        const { theme } = (await req.json().catch(() => ({}))) as { theme?: string };
        if (!theme) return json({ error: "expected theme" }, 400);
        currentTheme = theme;
        setTheme(theme);
        engine.hub.publish({ kind: "theme", theme });
        return json({ ok: true });
      }

      // Approval mode, same shape as POST /theme: flip it on the live engine and persist it, so a
      // choice made in the picker or by /auto survives a restart.
      if (p === "/auto" && method === "POST") {
        const { auto } = (await req.json().catch(() => ({}))) as { auto?: boolean };
        if (typeof auto !== "boolean") return json({ error: "expected { auto: boolean }" }, 400);
        engine.setAuto(auto);
        setAuto(auto);
        return json({ ok: true, auto });
      }

      if (p === "/providers" && method === "GET") {
        const cats: Category[] = ["byok", "local", "login"];
        const byCat = Object.fromEntries(
          cats.map((c) => [c, providersByCategory(c).map((id) => ({ id, label: CATALOG[id]!.label }))]),
        );
        return json({ providers: byCat });
      }
      if (p === "/models" && method === "GET") {
        const prov = u.searchParams.get("provider") ?? "";
        return json({ provider: prov, models: CATALOG[prov]?.models ?? [] });
      }
      if (p === "/model" && method === "POST") {
        const { agentId, provider, model, baseURL } = (await req.json().catch(() => ({}))) as {
          agentId?: string;
          provider?: string;
          model?: string;
          baseURL?: string;
        };
        if (!agentId || !model) return json({ error: "agentId and model required" }, 400);
        const parsed = splitModelId(provider, model);
        const err = engine.switchModel(agentId, parsed.provider, parsed.model, baseURL);
        return err ? json({ error: err }, 400) : json({ ok: true });
      }
      if (p === "/reassign" && method === "POST") {
        const { taskId, agentId } = (await req.json().catch(() => ({}))) as { taskId?: string; agentId?: string };
        if (!taskId || !agentId) return json({ error: "taskId and agentId required" }, 400);
        const err = engine.reassignTask(taskId, agentId);
        return err ? json({ error: err }, 400) : json({ ok: true });
      }

      if (p === "/auth" && method === "GET") {
        return json({ credentials: listCredentials().map(redact) });
      }
      if (p === "/auth" && method === "POST") {
        const cred = (await req.json().catch(() => ({}))) as Partial<AuthCredential> & { provider?: string };
        if (!cred.provider || !CATALOG[cred.provider]) return json({ error: "unknown provider" }, 400);
        const built = buildCredential(cred);
        if (!built) return json({ error: "invalid credential (need key, oauth access, or baseURL)" }, 400);
        // ponytail: stored without a live provider ping (network/credential dependent, untestable in CI).
        // Validation is deferred to first use, which surfaces a clear error there. Upgrade to a cheap
        // models-list ping per client kind if silent bad keys become a real problem.
        setCredential(built);
        return json({ ok: true, note: "stored (verified on first use)" });
      }
      if (p === "/auth" && method === "DELETE") {
        const prov = u.searchParams.get("provider") ?? "";
        removeCredential(prov);
        return json({ ok: true });
      }

      if (p === "/worktree" && method === "GET") {
        return json((await engine.worktreeStatus()) ?? { active: false });
      }
      if (p === "/worktree/merge" && method === "POST") {
        // An optional `files` list selects a partial merge (see engine.mergeWorktreeFiles) — no
        // body, or no `files` key, keeps the original whole-run merge behavior unchanged.
        const { files } = (await req.json().catch(() => ({}))) as { files?: string[] };
        return json(Array.isArray(files) ? await engine.mergeWorktreeFiles(files) : await engine.mergeWorktree());
      }
      if (p === "/worktree/discard" && method === "POST") {
        return json(await engine.discardWorktree());
      }
      if (p === "/worktree/hunks" && method === "GET") {
        const filePath = u.searchParams.get("path");
        if (!filePath) return json({ error: "expected ?path=" }, 400);
        const patch = await engine.worktreeFileHunks(filePath);
        return json({ patch: patch ?? "" });
      }

      if (p.startsWith("/agents/") && p.endsWith("/message") && method === "POST") {
        const agentId = safeDecode(p.slice("/agents/".length, -"/message".length));
        if (agentId === undefined) return json({ error: "malformed agent id" }, 400);
        const { text } = (await req.json().catch(() => ({}))) as { text?: string };
        if (!text?.trim()) return json({ error: "empty message" }, 400);
        const err = engine.messageAgent(agentId, text);
        return err ? json({ error: err }, 409) : json({ ok: true });
      }

      if (p === "/approval" && method === "POST") {
        const { ok, scope, edited } = (await req.json().catch(() => ({}))) as {
          ok?: boolean;
          scope?: "agent" | "path";
          edited?: Record<string, unknown>;
        };
        engine.approvals.answer(Boolean(ok), scope, edited);
        return json({ ok: true });
      }

      return json({ error: `no route ${method} ${p}` }, 404);
  }

  const port = server.port ?? 0;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    port,
    stop: () => server.stop(true),
  };
}

// Where the dashboard's static files are. Four shapes have to work: a repo checkout, a compiled
// binary (import.meta.url points inside /$bunfs/, which contains no web/ — the whole dashboard
// 404'd), an npm install where the assets sit beside the executable one level up (<pkg>/bin/niti-core
// → <pkg>/web), and a locally compiled dev binary sitting at the repo root next to ./web directly.
// fileURLToPath rather than URL.pathname because the latter stays percent-encoded, so any path with
// a space in it 404s too.
export function resolveWebDir(): string {
  const candidates: string[] = [];
  if (process.env.NITI_WEB_DIR) candidates.push(process.env.NITI_WEB_DIR);
  try {
    candidates.push(fileURLToPath(new URL("../../web", import.meta.url)));
  } catch {
    /* not a file: URL (compiled) — the execPath candidate below is the one that matters there */
  }
  candidates.push(join(dirname(process.execPath), "..", "web")); // <pkg>/bin/niti-core → <pkg>/web
  candidates.push(join(dirname(process.execPath), "web")); // repo-root dev build: ./niti-core sits next to ./web
  return candidates.find(existsSync) ?? candidates[candidates.length - 1]!;
}

// Lives in providers/catalog.ts (its only dependency is the catalog); re-exported here because the
// route contract has always named it, and server.test.ts imports it from this module.
export { splitModelId } from "../providers/catalog.ts";

function buildCredential(input: Partial<AuthCredential> & { provider?: string; key?: string; access?: string; baseURL?: string; type?: string }): AuthCredential | undefined {
  const provider = input.provider!;
  if (input.type === "local" || (input.baseURL && !input.key && !input.access)) {
    return input.baseURL ? { provider, type: "local", baseURL: input.baseURL } : undefined;
  }
  if (input.type === "oauth" || input.access) {
    return input.access ? { provider, type: "oauth", access: input.access } : undefined;
  }
  return input.key ? { provider, type: "api", key: input.key } : undefined;
}

// Never send secrets over the wire — just whether one is present.
function redact(c: AuthCredential): { provider: string; type: string } {
  return { provider: c.provider, type: c.type };
}

// decodeURIComponent throws on a malformed escape; every caller here is decoding a path segment
// that came straight off the wire.
function safeDecode(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

// Constant-time comparison for the sole auth gate on every non-public route — a plain `!==` leaks
// how many leading bytes matched via response timing. timingSafeEqual requires equal-length
// buffers; a length mismatch just fails outright (leaking length, not content, which is standard
// practice for a fixed-format random token).
export function tokensMatch(provided: string | null | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
