import { DurableObject } from "cloudflare:workers";
import { Accounts, type Sql } from "./accounts.ts";
import { Room, newSockMeta, type KV, type PushMessage, type Sock, type SockMeta } from "./room.ts";
import { login } from "./http.ts";

// The relay on Cloudflare: a Worker for sign-in and routing, one Durable Object per account holding
// that account's sockets (hibernating — an idle account costs nothing while its sockets stay open).

interface Env {
  DB: D1Database;
  ROOMS: DurableObjectNamespace<AccountRoom>;
  RESEND_API_KEY: string; // wrangler secret
  MAIL_FROM: string; // e.g. "niti <login@yourdomain>"
  EXPO_ACCESS_TOKEN?: string; // wrangler secret; required once Expo's enhanced push security is on
  LIMITER?: RateLimit; // optional rate-limiting binding, keyed by client IP
}

function d1(db: D1Database): Sql {
  return {
    run: async (q, ...a) => void (await db.prepare(q).bind(...a).run()),
    first: async (q, ...a) => ((await db.prepare(q).bind(...a).first()) ?? undefined) as never,
    all: async (q, ...a) => (await db.prepare(q).bind(...a).all()).results as never,
  };
}

// Tables are created on an isolate's first request (IF NOT EXISTS), so there is no migration step.
let migrated: Promise<void> | undefined;

const accountsFor = (env: Env) =>
  new Accounts(d1(env.DB), async (email, code) => {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: email,
        subject: `${code} is your niti sign-in code`,
        text: `Your niti sign-in code is ${code}.\n\nIt expires in 10 minutes. If you didn't ask for it, ignore this email.`,
      }),
    });
    if (!r.ok) throw new Error(`could not send the email (${r.status})`);
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
    if (env.LIMITER && !(await env.LIMITER.limit({ key: ip })).success) return Response.json({ error: "slow down" }, { status: 429 });
    const accounts = accountsFor(env);
    await (migrated ??= accounts.migrate());
    const res = await login(req, accounts, async (account) => {
      await env.ROOMS.get(env.ROOMS.idFromName(account)).fetch("https://room/devices-changed", { method: "POST" });
    });
    if (res) return res;
    const u = new URL(req.url);
    if (u.pathname === "/v1/connect") {
      if (req.headers.get("upgrade") !== "websocket") return new Response("expected a websocket", { status: 426 });
      const device = await accounts.device(u.searchParams.get("device") ?? "");
      if (!device) return Response.json({ error: "unknown device — sign in again" }, { status: 401 });
      const fwd = new Request(req, { headers: new Headers(req.headers) });
      fwd.headers.set("x-niti-device", JSON.stringify(device));
      return env.ROOMS.get(env.ROOMS.idFromName(device.account)).fetch(fwd);
    }
    if (u.pathname === "/health") return Response.json({ ok: true });
    return Response.json({ error: "not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export class AccountRoom extends DurableObject<Env> {
  private socks = new WeakMap<WebSocket, Sock>(); // one Sock per socket, so per-socket rate state holds

  private wrap(ws: WebSocket): Sock {
    let s = this.socks.get(ws);
    if (!s) {
      s = {
        get meta() {
          return ws.deserializeAttachment() as SockMeta;
        },
        setMeta: (m) => ws.serializeAttachment(m),
        send: (f) => {
          try {
            ws.send(JSON.stringify(f));
          } catch {
            /* closing */
          }
        },
        close: (code, reason) => ws.close(code, reason),
      };
      this.socks.set(ws, s);
    }
    return s;
  }

  // The account this object serves is stored on first connect: an alarm can fire with no socket open.
  private async room(): Promise<Room> {
    const storage = this.ctx.storage;
    const account = (await storage.get<string>("account")) ?? "";
    const kv: KV = {
      get: async (k) => storage.get(k),
      put: (k, v) => storage.put(k, v),
      delete: async (k) => void (await storage.delete(k)),
      list: async (prefix) => storage.list({ prefix }) as never,
    };
    return new Room({
      account,
      accounts: accountsFor(this.env),
      sockets: () => this.ctx.getWebSockets().map((ws) => this.wrap(ws)),
      kv,
      push: (m) => expoPush(m, this.env.EXPO_ACCESS_TOKEN),
      setAlarm: (at) => storage.setAlarm(at),
      now: Date.now,
    });
  }

  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/devices-changed") {
      await (await this.room()).devicesChanged();
      return new Response(null, { status: 204 });
    }
    const device = JSON.parse(req.headers.get("x-niti-device") ?? "null");
    if (!device) return new Response("no device", { status: 400 });
    await this.ctx.storage.put("account", device.account);
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(newSockMeta(device));
    (await this.room()).open(this.wrap(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    await (await this.room()).message(this.wrap(ws), typeof msg === "string" ? msg : new TextDecoder().decode(msg));
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await (await this.room()).close(this.wrap(ws));
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await (await this.room()).close(this.wrap(ws));
  }

  async alarm(): Promise<void> {
    await (await this.room()).alarm();
  }
}

// Expo's push service: one request for up to 100 messages. Best effort — a failed push is not
// worth failing the frame that asked for it.
async function expoPush(messages: PushMessage[], token?: string): Promise<void> {
  for (let i = 0; i < messages.length; i += 100) {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(messages.slice(i, i + 100).map((m) => ({ ...m, sound: "default", priority: m.data.category === "approval" ? "high" : "default" }))),
    }).catch(() => {});
  }
}
