import { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";
import { Accounts, type Mail, type Sql } from "./src/accounts.ts";
import { Room, newSockMeta, type KV, type PushMessage, type Sock, type SockMeta } from "./src/room.ts";
import { login } from "./src/http.ts";

// The relay on Bun: the same room and accounts code the Cloudflare Worker runs, over Bun.serve and
// bun:sqlite. For tests and the end-to-end check — and for anyone who would rather run a relay on
// their own box than on Cloudflare (`bun niti-relay/bun.ts --port 8787`).

export function sqlite(db: Database): Sql {
  return {
    run: async (q, ...a) => void db.query(q).run(...(a as never[])),
    first: async (q, ...a) => (db.query(q).get(...(a as never[])) ?? undefined) as never,
    all: async (q, ...a) => db.query(q).all(...(a as never[])) as never,
  };
}

interface Live {
  room: Room;
  socks: Set<Sock>;
  kv: Map<string, unknown>;
  timer?: ReturnType<typeof setTimeout>;
}

export async function startRelay(o: { port?: number; host?: string; db?: string; mail: Mail; push: (m: PushMessage[]) => Promise<void>; now?: () => number }) {
  const accounts = new Accounts(sqlite(new Database(o.db ?? ":memory:")), o.mail, o.now);
  await accounts.migrate();
  const now = o.now ?? Date.now;
  const rooms = new Map<string, Live>();
  const roomFor = (account: string): Live => {
    let live = rooms.get(account);
    if (live) return live;
    const socks = new Set<Sock>();
    const kv = new Map<string, unknown>();
    const store: KV = {
      get: async (k) => structuredClone(kv.get(k)) as never,
      put: async (k, v) => void kv.set(k, structuredClone(v)),
      delete: async (k) => void kv.delete(k),
      list: async (prefix) => new Map([...kv].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])) as never,
    };
    const l: Live = { socks, kv, room: undefined as never };
    l.room = new Room({
      account,
      accounts,
      sockets: () => [...socks],
      kv: store,
      push: o.push,
      now,
      setAlarm: async (at) => {
        clearTimeout(l.timer);
        l.timer = setTimeout(() => void l.room.alarm(), Math.max(0, at - now()));
      },
    });
    rooms.set(account, l);
    return l;
  };

  type Data = { meta: SockMeta; sock?: Sock };
  const server = Bun.serve<Data>({
    port: o.port ?? 0,
    hostname: o.host ?? "127.0.0.1",
    async fetch(req, srv) {
      const res = await login(req, accounts, async (account) => rooms.get(account)?.room.devicesChanged());
      if (res) return res;
      const u = new URL(req.url);
      if (u.pathname === "/v1/connect") {
        const device = await accounts.device(u.searchParams.get("device") ?? "");
        if (!device) return Response.json({ error: "unknown device — sign in again" }, { status: 401 });
        if (srv.upgrade(req, { data: { meta: newSockMeta(device) } })) return undefined;
        return new Response("expected a websocket", { status: 426 });
      }
      if (u.pathname === "/health") return Response.json({ ok: true });
      return Response.json({ error: "not found" }, { status: 404 });
    },
    websocket: {
      open(ws: ServerWebSocket<Data>) {
        const live = roomFor(ws.data.meta.device.account);
        const sock: Sock = {
          get meta() {
            return ws.data.meta;
          },
          setMeta: (m) => void (ws.data.meta = m),
          send: (f) => void ws.send(JSON.stringify(f)),
          close: (code, reason) => ws.close(code, reason),
        };
        ws.data.sock = sock;
        live.socks.add(sock);
        live.room.open(sock);
      },
      async message(ws: ServerWebSocket<Data>, msg) {
        await roomFor(ws.data.meta.device.account).room.message(ws.data.sock!, String(msg));
      },
      async close(ws: ServerWebSocket<Data>) {
        const live = roomFor(ws.data.meta.device.account);
        live.socks.delete(ws.data.sock!);
        await live.room.close(ws.data.sock!);
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    accounts,
    alarms: async () => {
      for (const l of rooms.values()) await l.room.alarm();
    }, // tests: fire every room's alarm now instead of in three minutes
    stop: () => {
      for (const l of rooms.values()) clearTimeout(l.timer);
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const r = await startRelay({
    port: Number(arg("port") ?? 8787),
    host: arg("host"), // --host=0.0.0.0 to reach it from a phone on the same network
    db: process.env.NITI_RELAY_DB ?? "niti-relay.db",
    mail: async (email, code) => console.log(`sign-in code for ${email}: ${code}`), // no mailer here: read it off the console
    push: async (m) => console.log(`push: ${JSON.stringify(m)}`),
  });
  console.log(`niti relay on ${r.url}`);
}
