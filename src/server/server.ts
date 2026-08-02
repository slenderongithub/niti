import { join, normalize } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { Engine } from "../engine.ts";
import type { ServerEvent } from "./events.ts";
import { CATALOG, contextWindow, providersByCategory, splitModelId, type Category } from "../providers/catalog.ts";
import { costOf } from "../providers/pricing.ts";
import { buildFileGraph } from "../graph/filegraph.ts";
import { listCredentials, setCredential, removeCredential, type AuthCredential } from "../auth/auth-store.ts";
import { saveAgents, setTheme } from "../config/config.ts";
import { CommandRegistry } from "../commands/registry.ts";
import type { AgentConfig } from "../agent/agent.ts";

// xterm.js's own dist bundles — served straight from node_modules (not vendored into web/) so
// there's exactly one copy, kept in step with package.json by `bun install`. Each is a UMD build
// that self-attaches to `globalThis` when loaded as a plain <script>, matching the rest of web/'s
// no-bundler convention.
const VENDOR_FILES: Record<string, { path: string; type: string }> = {
  "/xterm.js": { path: "@xterm/xterm/lib/xterm.js", type: "text/javascript; charset=utf-8" },
  "/xterm.css": { path: "@xterm/xterm/css/xterm.css", type: "text/css; charset=utf-8" },
  "/xterm-addon-fit.js": { path: "@xterm/addon-fit/lib/addon-fit.js", type: "text/javascript; charset=utf-8" },
};

interface TerminalSocketData {
  pty?: IPty;
}

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

// A private-by-default local server (127.0.0.1 + a bearer token from the handshake). The Go TUI
// sends the token as a header; the browser dashboard passes it as ?token= (EventSource can't set
// headers). Static dashboard assets are public; every data route is gated.
export function startServer(
  engine: Engine,
  opts: { port?: number; token?: string; webDir?: string; commands?: CommandRegistry; theme?: string } = {},
): ServerHandle {
  const token = opts.token ?? crypto.randomUUID();
  const webDir = opts.webDir ?? new URL("../../web", import.meta.url).pathname;
  const commands = opts.commands ?? new CommandRegistry();
  // Mutable, unlike the rest of `opts` — POST /theme updates this in place so /session reflects a
  // theme changed mid-session (by the TUI carousel or the web dropdown) without a server restart.
  let currentTheme = opts.theme ?? "";

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

  const serveFile = (rel: string): Response => {
    const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const file = join(webDir, safe);
    if (!file.startsWith(webDir) || !existsSync(file)) return json({ error: "not found" }, 404);
    const ext = file.slice(file.lastIndexOf("."));
    // No cache-control here previously meant a browser was free to serve a stale cached copy of
    // graph.js/app.js/etc. across visits with no way to tell — every edit to web/ ships live from
    // disk on the next request, so a client should never need to guess whether its copy is current.
    return new Response(readFileSync(file), {
      headers: { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream", "cache-control": "no-cache" },
    });
  };

  const nodeModulesDir = new URL("../../node_modules", import.meta.url).pathname;
  const serveVendor = (urlPath: string): Response => {
    const v = VENDOR_FILES[urlPath];
    if (!v) return json({ error: "not found" }, 404);
    const file = join(nodeModulesDir, v.path);
    if (!existsSync(file)) return json({ error: "not found" }, 404);
    return new Response(readFileSync(file), { headers: { "content-type": v.type } });
  };

  // The 5 theme palettes — single source of truth, also embedded straight into the TUI binary
  // (tui/internal/theme/theme.go's //go:embed) from this same file, so there's exactly one place
  // to add a 6th palette later. Lives under tui/ rather than a repo-root assets/ dir because Go's
  // //go:embed can't reach outside its own module.
  const palettesFile = new URL("../../tui/internal/theme/palettes.json", import.meta.url).pathname;
  const servePalettes = (): Response =>
    existsSync(palettesFile)
      ? new Response(readFileSync(palettesFile), { headers: { "content-type": "application/json" } })
      : json({ error: "not found" }, 404);

  const sse = (fromSeq: number): Response => {
    const enc = new TextEncoder();
    let unsub = () => {};
    let ping: ReturnType<typeof setInterval>;
    const stream = new ReadableStream({
      start(controller) {
        const send = (e: ServerEvent) => {
          try {
            controller.enqueue(enc.encode(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`));
          } catch {
            /* client went away between checks */
          }
        };
        for (const e of engine.hub.replay(fromSeq)) send(e); // backfill so late joiners are consistent
        unsub = engine.hub.subscribe(send);
        ping = setInterval(() => {
          try {
            controller.enqueue(enc.encode(`: ping\n\n`));
          } catch {
            /* ignore */
          }
        }, 25_000);
      },
      cancel() {
        clearInterval(ping);
        unsub();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  };

  const server = Bun.serve<TerminalSocketData>({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    idleTimeout: 0, // SSE connections are long-lived
    async fetch(req) {
      const u = new URL(req.url);
      const p = u.pathname;
      const method = req.method;

      // --- public: health + static dashboard shell ---
      if (p === "/health") return json({ ok: true, name: "amux", running: engine.running });
      if (p === "/" || p === "/dashboard" || p === "/dashboard/") return serveFile("index.html");
      if (p.startsWith("/dashboard/")) return serveFile(p.slice("/dashboard/".length));
      if (p === "/app.js" || p === "/style.css" || p === "/theme.js" || p === "/avatar.js") return serveFile(p.slice(1));
      if (p in VENDOR_FILES) return serveVendor(p);
      if (p === "/palettes.json") return servePalettes();
      // The interactive graph page — public shell like the dashboard; its /graph and /events calls
      // carry the token via ?token=. (Distinct from the gated data route `/graph` below.)
      if (p === "/graph/view" || p === "/graph/view/") return serveFile("graph.html");
      if (p === "/graph.js") return serveFile("graph.js");

      // --- everything below requires the token (header or ?token=) ---
      const bearer = req.headers.get("authorization");
      const provided = bearer?.startsWith("Bearer ") ? bearer.slice(7) : u.searchParams.get("token");
      if (!tokensMatch(provided, token)) return json({ error: "unauthorized" }, 401);

      if (p === "/events" && method === "GET") return sse(Number(u.searchParams.get("from") ?? 0));

      // A real shell in the browser, gated by the same token as every other route — same trust
      // model as the rest of the dashboard, just a bigger blast radius if that token leaks (code
      // execution instead of read access). server.upgrade() takes over the socket; the pty itself
      // is spawned in the `open` handler below, once the WS connection actually exists.
      if (p === "/terminal/ws" && method === "GET") {
        if (server.upgrade(req, { data: {} })) return;
        return json({ error: "expected a WebSocket upgrade" }, 400);
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

      if (p === "/prompt" && method === "POST") {
        const { text, mode } = (await req.json().catch(() => ({}))) as { text?: string; mode?: string };
        if (!text?.trim()) return json({ error: "empty prompt" }, 400);
        if (engine.running) return json({ error: "a task is already running" }, 409);
        // fire-and-forget; progress via SSE
        engine.submit(text, { planOnly: mode === "plan" }).catch((err) => console.error("submit error:", err));
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
        const name = decodeURIComponent(p.slice("/commands/".length));
        const { args } = (await req.json().catch(() => ({}))) as { args?: string };
        // Always 200: the command was dispatched, and its own `ok` says how it went. A non-2xx
        // would strand that message in the client's generic error path.
        return json(await commands.run(engine, name, args ?? ""));
      }

      if (p === "/graph" && method === "GET") {
        try {
          return json(buildFileGraph(engine.root));
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
        saveAgents(agents);
        return json({ ok: true, note: "saved to .amux/agents.yaml — restart the session to apply" });
      }

      if (p === "/theme" && method === "POST") {
        const { theme } = (await req.json().catch(() => ({}))) as { theme?: string };
        if (!theme) return json({ error: "expected theme" }, 400);
        currentTheme = theme;
        setTheme(theme);
        engine.hub.publish({ kind: "theme", theme });
        return json({ ok: true });
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
        return json(await engine.mergeWorktree());
      }

      if (p.startsWith("/agents/") && p.endsWith("/message") && method === "POST") {
        const agentId = decodeURIComponent(p.slice("/agents/".length, -"/message".length));
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
    },
    websocket: {
      // The pty is spawned here (not at upgrade time) so a rejected/dropped upgrade never leaks a
      // process — one socket, one pty, for its whole lifetime.
      //
      // KNOWN BLOCKER (confirmed by direct testing, not theoretical): a node-pty child spawned in
      // any process where Bun.serve() is running gets killed (SIGHUP, or exits immediately) within
      // single-digit milliseconds — reproduces with zero WebSocket code involved (a bare fetch
      // handler is enough), independent of shell, shell args, or env passed to spawn(). This code
      // is therefore not yet functional end-to-end under Bun; the fix is architectural (run the pty
      // in a separate helper process without Bun.serve in it, proxied over IPC) rather than a
      // one-line patch here. Left in place because the WS protocol/route shape above is correct and
      // reusable once that's done — do not spend time re-diagnosing this as a bug in this handler.
      open(ws) {
        const shell = process.env.SHELL || "/bin/bash";
        const term = pty.spawn(shell, [], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: engine.root,
          env: process.env as Record<string, string>,
        });
        ws.data.pty = term;
        term.onData((data) => {
          try {
            ws.send(data);
          } catch {
            /* socket already gone */
          }
        });
        term.onExit(() => {
          try {
            ws.close();
          } catch {
            /* already closed */
          }
        });
      },
      message(ws, raw) {
        const term = ws.data.pty;
        if (!term) return;
        let msg: { type?: string; data?: string; cols?: number; rows?: number };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return; // not our protocol — ignore rather than crash the socket over one bad frame
        }
        if (msg.type === "input" && typeof msg.data === "string") term.write(msg.data);
        if (msg.type === "resize" && msg.cols && msg.rows) term.resize(msg.cols, msg.rows);
      },
      close(ws) {
        ws.data.pty?.kill(); // the one thing that must not leak: the process behind a closed socket
      },
    },
  });

  const port = server.port ?? 0;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    port,
    stop: () => server.stop(true),
  };
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
