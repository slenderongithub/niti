import type { Provider, Turn, ToolSpec, ProviderReply, OnDelta } from "./provider.ts";
import { OpenAIProvider } from "./openai.ts";

// GitHub Copilot's public OAuth client id (same one used by copilot.vim / editor plugins).
const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

// Copilot's chat endpoint is OpenAI-compatible but requires these editor headers or it 400s.
const COPILOT_HEADERS: Record<string, string> = {
  "Editor-Version": "vscode/1.99.0",
  "Editor-Plugin-Version": "copilot-chat/0.26.0",
  "Copilot-Integration-Id": "vscode-chat",
  "User-Agent": "GitHubCopilotChat/0.26.0",
};

const JSON_HEADERS = { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "amux" };

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

export async function startDeviceFlow(): Promise<DeviceCode> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ client_id: CLIENT_ID, scope: "read:user" }),
  });
  if (!res.ok) throw new Error(`device-code request failed: ${res.status}`);
  return (await res.json()) as DeviceCode;
}

// Pure state machine for a poll response — the auth-critical branch, kept testable.
export type PollOutcome = { done: string } | { pending: true } | { slowDown: true } | { error: string };
export function interpretPollResponse(data: Record<string, unknown>): PollOutcome {
  if (typeof data.access_token === "string") return { done: data.access_token };
  if (data.error === "authorization_pending") return { pending: true };
  if (data.error === "slow_down") return { slowDown: true };
  return { error: String(data.error ?? "unknown") };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Poll until the user authorizes; returns the long-lived GitHub OAuth token.
// GitHub's documented floor is 5s; the value arrives in a network response, so a hostile or
// broken one (0, -1, NaN, "fast") must not turn this into an unbounded tight loop against an
// auth endpoint. Clamped into a sane band, with the documented default when it isn't a number.
const MIN_POLL_S = 5;
const MAX_POLL_S = 60;

function pollSeconds(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return MIN_POLL_S;
  return Math.min(Math.max(n, MIN_POLL_S), MAX_POLL_S);
}

export async function pollForToken(deviceCode: string, interval: number): Promise<string> {
  let wait = pollSeconds(interval);
  for (;;) {
    await sleep(wait * 1000);
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const outcome = interpretPollResponse((await res.json()) as Record<string, unknown>);
    if ("done" in outcome) return outcome.done;
    if ("slowDown" in outcome) wait = pollSeconds(wait + 5);
    else if ("error" in outcome) throw new Error(`login failed: ${outcome.error}`);
  }
}

// Exchange the GitHub OAuth token for a short-lived Copilot API token.
export async function fetchCopilotToken(githubToken: string): Promise<{ token: string; expiresAt: number }> {
  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: { Authorization: `token ${githubToken}`, "User-Agent": "amux", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Copilot token exchange failed: ${res.status} (re-run: amux login copilot)`);
  const data = (await res.json()) as { token: string; expires_at?: number };
  return { token: data.token, expiresAt: (data.expires_at ?? 0) * 1000 };
}

// Wraps OpenAIProvider, refreshing the short-lived Copilot token as it expires.
export class CopilotProvider implements Provider {
  private inner?: OpenAIProvider;
  private expiresAt = 0;

  constructor(
    private model: string,
    private githubToken: string,
  ) {}

  private async client(): Promise<OpenAIProvider> {
    if (this.inner && Date.now() < this.expiresAt - 60_000) return this.inner;
    const { token, expiresAt } = await fetchCopilotToken(this.githubToken);
    this.expiresAt = expiresAt || Date.now() + 25 * 60_000;
    this.inner = new OpenAIProvider(this.model, token, "https://api.githubcopilot.com", COPILOT_HEADERS);
    return this.inner;
  }

  async send(sysPrompt: string, turns: Turn[], tools: ToolSpec[], onDelta?: OnDelta): Promise<ProviderReply> {
    return (await this.client()).send(sysPrompt, turns, tools, onDelta);
  }
}
