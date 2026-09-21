import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { envKey, getKey as keychainKey, setKey as keychainSet, deleteKey as keychainDelete } from "../keystore/keystore.ts";

// Typed, global credential store — the niti equivalent of opencode's auth.json.
// A credential is one of three shapes: a raw API key (BYOK), an OAuth grant
// (e.g. GitHub Copilot's long-lived token), or a local endpoint (Ollama/LM Studio).
export type AuthCredential =
  | { provider: string; type: "api"; key: string }
  | { provider: string; type: "oauth"; access: string; refresh?: string; expires?: number }
  | { provider: string; type: "local"; baseURL: string };

// Global, not per-project (like opencode). Overridable via env so tests never touch a real home.
function authFile(): string {
  return process.env.NITI_AUTH_FILE || join(homedir(), ".config", "niti", "auth.json");
}

interface StoreShape {
  credentials: AuthCredential[];
}

function read(): AuthCredential[] {
  const path = authFile();
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as StoreShape;
    return Array.isArray(data.credentials) ? data.credentials.filter((c) => c && typeof c.provider === "string") : [];
  } catch {
    // A corrupt store shouldn't brick the CLI — treat as empty and let the next write heal it.
    return [];
  }
}

// 0600 file inside a 0700 dir — credentials are secrets, keep them owner-only.
function write(creds: AuthCredential[]): void {
  const path = authFile();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ credentials: creds }, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600); // enforce even if the file pre-existed with looser perms
  } catch {
    // best effort (e.g. Windows) — the mode option above already covers POSIX
  }
}

export function listCredentials(): AuthCredential[] {
  return read();
}

export function getCredential(provider: string): AuthCredential | undefined {
  return read().find((c) => c.provider === provider);
}

// Upsert by provider. API keys are also mirrored into the OS keychain when available so a user
// who later runs without the file (or with `niti keys set`) still resolves. Mirroring is best
// effort and skipped when writing to a test store, so tests never touch the real keychain.
export function setCredential(cred: AuthCredential): void {
  const creds = read().filter((c) => c.provider !== cred.provider);
  creds.push(cred);
  write(creds);
  if (cred.type === "api" && !process.env.NITI_AUTH_FILE) {
    try {
      keychainSet(cred.provider, cred.key);
    } catch {
      // keychain unavailable (headless Linux, locked) — the 0600 file is the source of truth
    }
  }
}

export function removeCredential(provider: string): void {
  const creds = read().filter((c) => c.provider !== provider);
  if (creds.length) write(creds);
  else {
    // last credential gone — drop the file entirely rather than leave an empty shell
    const path = authFile();
    if (existsSync(path)) rmSync(path);
  }
  // Also clear the keychain mirror, or a "logged out" key would still resolve via the fallback
  // below and keep authenticating. Skipped for a test store so tests never touch the real keychain.
  if (!process.env.NITI_AUTH_FILE) keychainDelete(provider);
}

// The value a provider client needs as its API key. Resolution order: env → typed store → keychain.
// An exported variable is the most explicit, most recent statement of intent (and the only way to
// override a saved key for one command), so it wins. A test store (NITI_AUTH_FILE) stays hermetic.
export function resolveApiKey(provider: string): string | undefined {
  if (!process.env.NITI_AUTH_FILE) {
    const fromEnv = envKey(provider);
    if (fromEnv) return fromEnv;
  }
  const cred = getCredential(provider);
  if (cred) {
    if (cred.type === "api") return cred.key;
    if (cred.type === "oauth") return cred.access;
    // local: no real key — the factory substitutes a "local" sentinel for keyOptional providers
    return undefined;
  }
  // A test store (NITI_AUTH_FILE set) is hermetic: don't fall through to the real keychain / env,
  // or a provider absent from the temp store would resolve a real key and make billed calls.
  if (process.env.NITI_AUTH_FILE) return undefined;
  return keychainKey(provider); // keychain first, then env var (see keystore.getKey)
}

// A caller-supplied base URL for local/custom providers stored via `niti auth login`.
export function resolveBaseURL(provider: string): string | undefined {
  const cred = getCredential(provider);
  return cred?.type === "local" ? cred.baseURL : undefined;
}
