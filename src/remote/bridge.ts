import { basename } from "node:path";
import { unwatchFile, watchFile } from "node:fs";
import pkg from "../../package.json";
import type { Engine } from "../engine.ts";
import type { ServerEvent } from "../server/events.ts";
import type { GoalStatus } from "../goal.ts";
import { authMessage, Channel, PROTOCOL, pairingCode, sealStatus, sign, type ChannelMessage, type DeviceInfo, type Hello, type PushCategory, type ServerFrame } from "./protocol.ts";
import { DEFAULT_RELAY, keysFor, loadIdentity, macId, macName, mtime, newIdentity, remoteFile, saveIdentity, sessionFor, type RemoteIdentity } from "./identity.ts";

// Remote control, on the Mac's side. The core keeps one outbound WebSocket to the relay; phones the
// Mac has allowed open an end-to-end encrypted channel through it and drive this core's own HTTP API
// (a loopback fetch with the local token — which never leaves the Mac), restricted to an allowlist:
// a phone can watch, prompt, steer, interrupt, approve, pause and merge, but never touch credentials,
// turn auto-approve on, change the team, or let another device in.

export interface RemoteState {
  signedIn: boolean;
  email?: string;
  relay?: string;
  enabled: boolean; // this project takes part (agents.yaml `remote: false` opts it out)
  link: "up" | "connecting" | "off";
  phones: { id: string; name: string; online: boolean }[]; // allowed phones
}

const ROUTES: [string, RegExp][] = [
  ["POST", /^\/(session|prompt|cancel|approval|model|reassign)$/],
  ["POST", /^\/agents\/[^/]+\/(message|interrupt)$/],
  ["POST", /^\/worktree\/(merge|discard)$/],
  ["POST", /^\/commands\/[^/]+$/],
  ["GET", /^\/(files|file|stats|sessions|checkpoints|commands|agents|models|worktree|worktree\/hunks)$/],
];
// Commands a phone can't run: these would raise its own privileges or let another device in.
const BLOCKED_COMMANDS = new Set(["auto", "manual", "remote"]);
// What a phone may change in a tool call before approving it: the content of a file write, never
// the path, the command, or its arguments.
const EDITABLE: Record<string, string[]> = { write_file: ["content"], edit: ["new_string", "new_text", "content"] };
const MAX_FILE = 256 * 1024;
const MAX_TEXT = 20_000; // a diff or file body in an approval, as the phone gets it
const FLUSH_MS = 120;
const STATUS_EVERY_MS = 30_000;

export class RemoteBridge {
  private id?: RemoteIdentity;
  private idMtime = 0;
  private ws?: WebSocket;
  private link: RemoteState["link"] = "off";
  private stopped = true;
  private backoff = 1000;
  private retry?: ReturnType<typeof setTimeout>;
  private devices: DeviceInfo[] = [];
  private online = new Set<string>();
  private channels = new Map<string, { ch: Channel; name: string; sub: boolean }>();
  private asking = new Set<string>(); // phones with an allow request on screen
  private denied = new Set<string>(); // refused this boot (not saved: an esc that denied by accident shouldn't be forever)
  private queue: ServerEvent[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private statusTimer?: ReturnType<typeof setInterval>;
  private seenApprovals = new Set<number>();
  private lastGoal?: GoalStatus | null;
  private pendingLogin?: { email: string; relay: string };
  private unsub?: () => void;

  constructor(
    private engine: Engine,
    private server: { url: string; token: string },
    private o: { enabled: boolean; file?: string },
  ) {}

  private get file(): string {
    return this.o.file ?? remoteFile();
  }

  private get session(): string {
    return sessionFor(macId(this.id!), this.engine.root);
  }

  start(): void {
    this.id = loadIdentity(this.file);
    this.idMtime = mtime(this.file);
    // Another niti on this Mac allowed a phone, signed in, or signed out: follow it.
    watchFile(this.file, { interval: 1500 }, () => this.reloadIdentity());
    this.unsub ??= this.engine.hub.subscribe((e) => {
      try {
        this.onHub(e);
      } catch (err) {
        console.error(`niti: remote: ${err instanceof Error ? err.message : err}`); // a subscriber must never throw into publish()
      }
    });
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.statusTimer);
    unwatchFile(this.file);
    this.ws?.close(1000, "bye");
    this.ws = undefined;
    this.setLink("off");
  }

  state(): RemoteState {
    return {
      signedIn: !!this.id,
      email: this.id?.email,
      relay: this.id?.relay,
      enabled: this.o.enabled,
      link: this.link,
      phones: (this.id?.phones ?? []).map((p) => ({ id: p.id, name: p.name, online: this.online.has(p.id) })),
    };
  }

  // ---- sign-in (/remote login, /remote code) ----

  async loginStart(email: string, relay = this.id?.relay || DEFAULT_RELAY): Promise<string> {
    if (!relay) return "no relay is configured yet — deploy niti-relay, then /remote login <email> --relay https://your-relay";
    const r = await relayPost(relay, "/v1/login/start", { email });
    if (!r.ok) return r.error ?? "could not send the code";
    this.pendingLogin = { email, relay };
    return `a code is on its way to ${email} — then /remote code <the 6 digits>`;
  }

  async loginVerify(code: string): Promise<{ ok: boolean; message: string }> {
    const p = this.pendingLogin;
    if (!p) return { ok: false, message: "start with /remote login <email>" };
    const keys = keysFor(this.file);
    const r = await relayPost(p.relay, "/v1/login/verify", { email: p.email, code, device: { name: macName(), kind: "mac", signPub: keys.signPub } });
    if (!r.ok) return { ok: false, message: r.error ?? "sign-in failed" };
    const prev = loadIdentity(this.file);
    // Same Mac, same relay, same account: keep the phones it already allowed.
    const id = prev && prev.relay === p.relay && prev.email === p.email ? { ...prev, keys } : newIdentity(p.relay, p.email, keys);
    saveIdentity(id, this.file);
    this.pendingLogin = undefined;
    this.reloadIdentity();
    return { ok: true, message: `signed in as ${p.email} — open the niti app on your phone and sign in with the same email${this.o.enabled ? "" : " (this project has remote control off: /remote on)"}` };
  }

  logout(): string {
    if (!this.id) return "not signed in";
    this.send({ t: "revoke", device: macId(this.id) });
    saveIdentity(undefined, this.file);
    this.reloadIdentity();
    return "signed out — phones can no longer reach this Mac";
  }

  revoke(name: string): string {
    const phone = this.id?.phones.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? this.devices.find((d) => d.kind === "phone" && d.name.toLowerCase() === name.toLowerCase());
    if (!phone || !this.id) return `no phone called ${name} — /remote devices lists them`;
    this.send({ t: "revoke", device: phone.id });
    this.id.phones = this.id.phones.filter((p) => p.id !== phone.id);
    saveIdentity(this.id, this.file);
    this.channels.delete(phone.id);
    this.sendAllow();
    this.publish();
    return `${phone.name} is signed out — it has to sign in again, and be allowed again, to come back`;
  }

  setEnabled(on: boolean): void {
    this.o.enabled = on;
    if (on) this.connect();
    else {
      this.ws?.close(1000, "remote off for this project");
      this.ws = undefined;
      this.setLink("off");
    }
  }

  describe(): string {
    const s = this.state();
    if (!s.signedIn) return "remote control is off — /remote login <email> to control this Mac from your phone";
    const phones = s.phones.length ? s.phones.map((p) => `${p.online ? "●" : "○"} ${p.name}`).join("\n          ") : "none yet — sign in on the niti app with the same email";
    return [`account   ${s.email}`, `relay     ${s.relay} (${s.enabled ? s.link : "off for this project — /remote on"})`, `phones    ${phones}`].join("\n");
  }

  // ---- the relay connection ----

  private connect(): void {
    this.stopped = false;
    clearTimeout(this.retry);
    if (!this.id || !this.o.enabled || this.ws) return this.setLink(this.ws ? this.link : "off");
    this.setLink("connecting");
    const ws = new WebSocket(`${this.id.relay.replace(/^http/, "ws")}/v1/connect?device=${macId(this.id)}`);
    this.ws = ws;
    ws.onmessage = (e) => {
      try {
        this.onFrame(JSON.parse(String(e.data)) as ServerFrame);
      } catch (err) {
        console.error(`niti: remote: ${err instanceof Error ? err.message : err}`);
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.channels.clear();
      this.online.clear();
      clearInterval(this.statusTimer);
      if (e.code === 4001) {
        // This Mac was signed out (from a phone, or another device): forget the identity.
        console.error("niti: remote: this Mac was signed out of its niti account");
        saveIdentity(undefined, this.file);
        this.reloadIdentity();
        return;
      }
      if (e.code === 4002) console.error(`niti: remote: ${e.reason}`);
      this.setLink(this.stopped || !this.id || !this.o.enabled ? "off" : "connecting");
      if (this.stopped || !this.id || !this.o.enabled) return;
      this.retry = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 60_000);
    };
  }

  private send(f: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(f));
  }

  private onFrame(f: ServerFrame): void {
    const id = this.id;
    if (!id) return;
    switch (f.t) {
      case "challenge":
        return this.send({ t: "auth", v: PROTOCOL, sig: sign(id.keys.signSecret, authMessage(f.nonce, macId(id))), session: this.session });
      case "ready":
        this.backoff = 1000;
        this.devices = f.devices;
        this.online = new Set(f.phonesOnline);
        this.setLink("up");
        this.prunePhones();
        this.sendAllow();
        this.askNewPhones();
        this.sendStatus();
        clearInterval(this.statusTimer);
        this.statusTimer = setInterval(() => this.engine.goal.active && this.sendStatus(), STATUS_EVERY_MS);
        return;
      case "devices":
        this.devices = f.devices;
        this.prunePhones();
        this.askNewPhones();
        return this.publish();
      case "phones":
        this.online = new Set(f.online);
        for (const p of this.channels.keys()) if (!this.online.has(p)) this.channels.delete(p);
        return this.publish();
      case "from":
        if (f.device) void this.onPhone(f.device, f.data);
        return;
      case "error":
        console.error(`niti: remote: ${f.message}`);
        return;
    }
  }

  // A phone signed out of the account is gone from the allowed list too.
  private prunePhones(): void {
    if (!this.id) return;
    const live = new Set(this.devices.map((d) => d.id));
    const kept = this.id.phones.filter((p) => live.has(p.id));
    if (kept.length !== this.id.phones.length) {
      this.id.phones = kept;
      saveIdentity(this.id, this.file);
    }
  }

  // A phone on the account this Mac hasn't decided about: ask, once, with the code both screens show.
  private askNewPhones(): void {
    const id = this.id;
    if (!id) return;
    for (const d of this.devices) {
      if (d.kind !== "phone" || id.phones.some((p) => p.id === d.id) || this.denied.has(d.id) || this.asking.has(d.id)) continue;
      this.asking.add(d.id);
      const code = pairingCode(id.keys.signPub, d.signPub);
      // forceAsk: an "always allow" grant must never let the next phone in unasked.
      void this.engine.approvals.request("remote", "allow_device", { phone: d.name, code, device: d.id }, true).then((ok) => {
        this.asking.delete(d.id);
        const now = loadIdentity(this.file); // another niti on this Mac may have decided first
        if (!now) return;
        this.id = now;
        if (ok && !now.phones.some((p) => p.id === d.id)) {
          now.phones.push({ id: d.id, name: d.name, signPub: d.signPub, allowedAt: Date.now() });
          saveIdentity(now, this.file);
          this.idMtime = mtime(this.file);
        } else if (!ok) this.denied.add(d.id);
        this.sendAllow();
        this.publish();
      });
    }
  }

  private sendAllow(): void {
    if (!this.id) return;
    this.send({ t: "allow", phones: this.id.phones.map((p) => p.id), denied: [...this.denied] });
  }

  private reloadIdentity(): void {
    const t = mtime(this.file);
    if (t === this.idMtime && this.id) return;
    this.idMtime = t;
    const before = this.id;
    this.id = loadIdentity(this.file);
    // Answered elsewhere: settle our copy of any allow request for a phone now on the list.
    for (const r of this.engine.pendingApprovals()) {
      if (r.agentId === "remote" && this.id?.phones.some((p) => p.id === r.input.device)) this.engine.approvals.answer(true, undefined, undefined, r.id);
    }
    const sameAccount = before && this.id && macId(before) === macId(this.id) && before.relay === this.id.relay;
    if (!sameAccount) {
      this.ws?.close(1000, "identity changed");
      this.ws = undefined;
      if (this.id && this.o.enabled) this.connect();
      else this.setLink("off");
    }
    this.publish();
  }

  // ---- a phone's channel ----

  private async onPhone(phoneId: string, data: string): Promise<void> {
    const id = this.id;
    const phone = id?.phones.find((p) => p.id === phoneId);
    if (!id || !phone) return; // not allowed (the relay checks too)
    if (data.startsWith("{")) {
      let hello: Hello;
      try {
        hello = JSON.parse(data) as Hello;
      } catch {
        return;
      }
      if (hello.h !== "hello") return;
      const ch = new Channel(`${macId(id)}:${this.session}:${phoneId}`, "b", id.keys.signSecret, phone.signPub);
      const answer = ch.accept(hello);
      if (!answer) return;
      this.channels.set(phoneId, { ch, name: phone.name, sub: false });
      this.send({ t: "to", device: phoneId, data: JSON.stringify(answer) });
      this.seal(phoneId, { k: "welcome", mac: macId(id), project: basename(this.engine.root), bootId: this.engine.bootId, statusKey: id.statusKey, version: pkg.version });
      return;
    }
    const c = this.channels.get(phoneId);
    const msg = c?.ch.unseal(data);
    if (!c || !msg) return;
    if (msg.k === "sub") return this.subscribe(phoneId, msg.from);
    if (msg.k === "req") {
      const { status, body } = await this.request(c.name, msg.method, msg.path, msg.body);
      this.seal(phoneId, { k: "res", id: msg.id, status, body });
    }
  }

  private seal(phoneId: string, msg: ChannelMessage): void {
    const c = this.channels.get(phoneId);
    if (c) this.send({ t: "to", device: phoneId, data: c.ch.seal(msg) });
  }

  // One API call from a phone: through the allowlist, then this core's own server.
  async request(device: string, method: string, rawPath: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const path = String(rawPath).split("?")[0]!;
    if (!ROUTES.some(([m, re]) => m === method && re.test(path))) return { status: 403, body: { error: `${method} ${path} isn't available from a phone` } };
    if (path.startsWith("/commands/")) {
      const name = decodeURIComponent(path.slice("/commands/".length));
      if (BLOCKED_COMMANDS.has(name)) return { status: 403, body: { error: `/${name} can only be run on the Mac` } };
    }
    if (path === "/approval") {
      const a = (body ?? {}) as { id?: number; edited?: Record<string, unknown> };
      const req = this.engine.pendingApprovals().find((r) => r.id === a.id);
      if (req?.agentId === "remote" || (a.id === undefined && this.engine.pendingApprovals()[0]?.agentId === "remote")) return { status: 403, body: { error: "a new device can only be allowed on the Mac" } };
      if (a.edited && !(req && Object.keys(a.edited).every((k) => EDITABLE[req.tool]?.includes(k)))) delete a.edited;
    }
    const res = await fetch(this.server.url + rawPath, {
      method,
      headers: { authorization: `Bearer ${this.server.token}`, "content-type": "application/json", "x-niti-origin": `remote; device=${encodeURIComponent(device)}` },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    if (path === "/file" && text.length > MAX_FILE) return { status: 413, body: { error: "too large to view on a phone" } };
    let out: unknown;
    try {
      out = JSON.parse(text);
    } catch {
      out = { error: text.slice(0, 500) };
    }
    if (res.ok && method === "POST" && path !== "/session") this.note(device, path, body);
    return { status: res.status, body: out };
  }

  // Remote actions show on the Mac too, so whoever is at it isn't surprised by them.
  private note(device: string, path: string, body: unknown): void {
    const b = (body ?? {}) as Record<string, unknown>;
    const what =
      path === "/approval" ? `${b.ok ? "approved" : "denied"} a request` :
      path === "/prompt" ? `sent "${String(b.text ?? "").slice(0, 60)}"` :
      path === "/cancel" ? "stopped the run" :
      path.startsWith("/commands/") ? `ran /${decodeURIComponent(path.slice(10))} ${String(b.args ?? "")}`.trim() :
      path.endsWith("/interrupt") ? `interrupted ${decodeURIComponent(path.split("/")[2]!)}` :
      path.endsWith("/message") ? `messaged ${decodeURIComponent(path.split("/")[2]!)}` :
      path.slice(1);
    this.engine.bus.publish({ agentId: "orchestrator", type: "thought", payload: `📱 ${device}: ${what}`, time: Date.now() });
  }

  private subscribe(phoneId: string, from: number): void {
    const c = this.channels.get(phoneId);
    if (!c) return;
    c.sub = true;
    const missed = this.engine.hub.missedSince(from);
    const backlog: ServerEvent[] = missed > 0 ? [{ kind: "resync", missed, seq: from, time: Date.now() }] : [];
    backlog.push(...this.engine.hub.replay(from));
    for (let i = 0; i < backlog.length; i += 200) this.seal(phoneId, { k: "events", events: backlog.slice(i, i + 200).map(forPhone) });
    if (!backlog.length) this.seal(phoneId, { k: "events", events: [] }); // "caught up"
  }

  // ---- events out, and what they trigger ----

  private onHub(e: ServerEvent): void {
    this.pushFor(e);
    if (e.kind === "goal") this.sendStatus();
    if (![...this.channels.values()].some((c) => c.sub)) return;
    this.queue.push(e);
    this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    this.flushTimer = undefined;
    const batch = coalesce(this.queue.splice(0)).map(forPhone);
    for (const [phoneId, c] of this.channels) if (c.sub) this.seal(phoneId, { k: "events", events: batch });
  }

  private pushFor(e: ServerEvent): void {
    if (this.link !== "up") return;
    if (e.kind === "approval_request") {
      for (const r of e.requests) {
        if (this.seenApprovals.has(r.id) || r.agentId === "remote") continue;
        this.seenApprovals.add(r.id);
        this.push("approval", r.dangerous ? "Approval needed (risky)" : "Approval needed", `${r.agentId} wants to ${TOOL_VERBS[r.tool] ?? `use ${r.tool}`}`, "approval");
      }
      return;
    }
    if (e.kind === "goal") {
      const was = this.lastGoal;
      const g = e.status;
      this.lastGoal = g;
      if (!g || !was || was.state !== "running" || g.state === "running") return;
      if (g.state === "paused" && !g.error) return; // a person paused it; they know
      this.push("goal", `Goal ${g.state}`, `${g.objective.slice(0, 80)}: ${g.reason}`);
      return;
    }
    if (e.kind === "agent_event" && e.event.type === "error" && e.event.agentId === "orchestrator") this.push("error", "niti hit an error", e.event.payload.slice(0, 160));
  }

  // `route` is the screen the phone opens when the notification is tapped (niti-mobile's router).
  private push(category: PushCategory, title: string, body: string, sheet?: "approval"): void {
    const route = `/session/${macId(this.id!)}/${this.session}${sheet ? `?sheet=${sheet}` : ""}`;
    this.send({ t: "push", category, title: `${title} · ${basename(this.engine.root)}`, body, route });
  }

  private sendStatus(): void {
    if (!this.id || this.link !== "up") return;
    const g = this.engine.goal.status;
    const status = {
      project: basename(this.engine.root),
      running: this.engine.running,
      approvals: this.engine.pendingApprovals().filter((r) => r.agentId !== "remote").length,
      goal: g ? { objective: g.objective, state: g.state, reason: g.reason, round: g.round, maxRounds: g.maxRounds } : null,
      at: Date.now(),
    };
    this.send({ t: "status", blob: sealStatus(this.id.statusKey, status), offlineAlert: this.engine.goal.active });
  }

  private setLink(link: RemoteState["link"]): void {
    if (link === this.link) return;
    this.link = link;
    this.publish();
  }

  private publish(): void {
    this.engine.hub.publish({ kind: "remote", remote: this.state() });
  }
}

const TOOL_VERBS: Record<string, string> = { write_file: "write a file", edit: "edit a file", shell: "run a command", delete_file: "delete a file" };

// Streamed text arrives a few characters per event; a phone gets one event per agent per flush.
function coalesce(events: ServerEvent[]): ServerEvent[] {
  const out: ServerEvent[] = [];
  for (const e of events) {
    const prev = out.at(-1);
    if (e.kind === "agent_event" && e.event.type === "delta" && prev?.kind === "agent_event" && prev.event.type === "delta" && prev.event.agentId === e.event.agentId) {
      out[out.length - 1] = { ...e, event: { ...e.event, payload: prev.event.payload + e.event.payload } };
    } else out.push(e);
  }
  return out;
}

// What a phone needs, and no more: long diffs and file bodies in an approval are cut, and a request
// to allow a new device isn't shown at all — only the Mac can answer it.
function forPhone(e: ServerEvent): ServerEvent {
  if (e.kind !== "approval_request") return e;
  const cut = (v: unknown) => (typeof v === "string" && v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}\n… (${v.length - MAX_TEXT} more characters — open it on the Mac)` : v);
  return { ...e, requests: e.requests.filter((r) => r.agentId !== "remote").map((r) => ({ ...r, input: Object.fromEntries(Object.entries(r.input).map(([k, v]) => [k, cut(v)])) })) };
}

async function relayPost(relay: string, path: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(relay.replace(/\/$/, "") + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    return (await res.json().catch(() => ({ ok: false, error: `the relay answered ${res.status}` }))) as { ok: boolean; error?: string };
  } catch (err) {
    return { ok: false, error: `couldn't reach the relay at ${relay}: ${err instanceof Error ? err.message : err}` };
  }
}
