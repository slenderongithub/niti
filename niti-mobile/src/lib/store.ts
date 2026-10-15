import { AppState } from "react-native";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { create } from "zustand";
import { applyEvents, emptyState, fromSession, type SessionState } from "../../../niti-app/src/renderer/src/lib/reducer";
import type { ServerEvent, SessionInfo } from "../../../niti-app/src/renderer/src/lib/types";
import { RemoteClient, type RemoteSnapshot, type Session } from "./remote";
import { keychain } from "./secure";

// The app's one store: the relay connection (which Macs and projects exist) and, while one is open,
// a project's session folded by the same reducer the desktop app uses.

const DEFAULT_RELAY = (Constants.expoConfig?.extra?.relay as string | undefined) ?? "";

interface Open {
  mac: string;
  session: string;
  conn: Session;
  project: string;
}

interface Store {
  ready: boolean; // the keychain has been read
  signedIn: boolean;
  relay: string;
  snap: RemoteSnapshot;
  open?: Open;
  state: SessionState;
  opening: boolean;
  error?: string;
  init(): Promise<void>;
  setRelay(url: string): void;
  startSignIn(email: string): Promise<string | undefined>;
  finishSignIn(code: string): Promise<string | undefined>;
  signOut(): Promise<void>;
  openSession(mac: string, session: string): Promise<void>;
  closeSession(): void;
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  command(name: string, args?: string): Promise<{ ok: boolean; message: string }>;
}

let client: RemoteClient | undefined;

export const useStore = create<Store>((set, get) => {
  // The open session stopped working (the Mac's core restarted, its link reconnected, the phone
  // lost the relay): show "reconnecting…" and open it again once the Mac is back, as long as it is
  // still the session on screen. The replay from 0 brings the view up to date.
  const reopen = (mac: string, session: string, conn: Session) => {
    if (get().open?.conn !== conn) return;
    set((s) => ({ state: { ...s.state, connection: "lost" } }));
    const attempt = async () => {
      if (get().open?.conn !== conn) return; // closed, or already reopened
      if (client?.snap.sessions.some((x) => x.mac === mac && x.session === session && x.online && x.allowed)) {
        await get().openSession(mac, session);
        if (get().open?.conn !== conn) return;
      }
      setTimeout(() => void attempt(), 2000);
    };
    setTimeout(() => void attempt(), 300);
  };

  const makeClient = (relay: string) => {
    client?.stop();
    client = new RemoteClient({ relay, name: Device.deviceName ?? "iPhone", store: keychain });
    client.onChange((snap) => set({ snap, signedIn: !!client?.id }));
    return client;
  };

  // iOS suspends sockets in the background: coming back, reconnect and pick the session up again.
  AppState.addEventListener("change", (s) => {
    if (s !== "active" || !client?.id) return;
    client.connect();
    const o = get().open;
    if (o && !o.conn.ready) void get().openSession(o.mac, o.session);
  });

  return {
    ready: false,
    signedIn: false,
    relay: DEFAULT_RELAY,
    snap: { link: "off", devices: [], sessions: [] },
    state: emptyState(),
    opening: false,

    async init() {
      const saved = await keychain.load();
      const c = makeClient(saved?.relay || DEFAULT_RELAY);
      await c.restore();
      set({ ready: true, signedIn: !!c.id, relay: c.relay });
      if (c.id) c.connect();
    },

    setRelay(url) {
      set({ relay: url.trim().replace(/\/$/, "") });
    },

    async startSignIn(email) {
      const c = makeClient(get().relay);
      const r = await c.loginStart(email);
      return r.ok ? undefined : (r.error ?? "couldn't send the code");
    },

    async finishSignIn(code) {
      const r = await client!.loginVerify(code);
      if (!r.ok) return r.error ?? "sign-in failed";
      set({ signedIn: true });
      client!.connect();
      return undefined;
    },

    async signOut() {
      get().closeSession();
      await client?.signOut();
      set({ signedIn: false, snap: { link: "off", devices: [], sessions: [] } });
    },

    async openSession(mac, session) {
      if (!client) return;
      set({ opening: true, error: undefined });
      try {
        const conn = await client.open(mac, session);
        const info = await conn.request<SessionInfo>("POST", "/session");
        if (info.status !== 200) throw new Error("the Mac refused the session");
        // Replay from 0, as the desktop app does: the core's buffer holds the run so far.
        set({ open: { mac, session, conn, project: conn.welcome?.project ?? "" }, state: fromSession(info.body), opening: false });
        conn.subscribe(0, (events) => set((s) => ({ state: applyEvents(s.state, events as ServerEvent[]) })));
        conn.onDead = () => reopen(mac, session, conn);
      } catch (err) {
        set({ opening: false, error: err instanceof Error ? err.message : String(err) });
      }
    },

    closeSession() {
      const conn = get().open?.conn;
      set({ open: undefined, state: emptyState() }); // first, so its drop doesn't count as a lost link
      conn?.drop();
    },

    async call<T>(method: string, path: string, body?: unknown): Promise<T> {
      const o = get().open;
      if (!o?.conn.ready) throw new Error("not connected to the Mac");
      const r = await o.conn.request<T & { error?: string }>(method, path, body);
      if (r.status >= 400 || r.status === 0) throw new Error(r.body?.error ?? `the Mac answered ${r.status}`);
      return r.body;
    },

    command(name, args = "") {
      return get().call<{ ok: boolean; message: string }>("POST", `/commands/${encodeURIComponent(name)}`, { args });
    },
  };
});

export const remoteClient = () => client;
