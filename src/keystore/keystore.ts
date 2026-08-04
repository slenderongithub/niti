import { CATALOG } from "../providers/catalog.ts";

const SERVICE = "amux";

// @napi-rs/keyring is a native .node binding, resolved at runtime for one platform only. As a
// top-level `import` it took the whole process down with "Cannot find native binding" on any
// binary that wasn't compiled on the machine it runs on — the same failure that node-pty caused,
// and the thing that makes a cross-compiled release impossible. So: loaded on first use, and
// allowed to be absent. Without it, keys come from ~/.config/amux/auth.json and the env vars,
// which is already the documented path for headless boxes.
type EntryCtor = new (service: string, user: string) => {
  getPassword(): string | null;
  setPassword(pw: string): void;
  deletePassword(): boolean;
};
let cached: EntryCtor | null | undefined;
function keychain(): EntryCtor | null {
  if (cached === undefined) {
    try {
      cached = (require("@napi-rs/keyring") as { Entry: EntryCtor }).Entry;
    } catch {
      cached = null; // no binding for this platform, or no keychain daemon
    }
  }
  return cached;
}

export function envVarName(provider: string): string | undefined {
  return CATALOG[provider]?.envVar;
}

// Env-var fallback, kept pure so the precedence logic is testable without touching the keychain.
export function envKey(provider: string): string | undefined {
  const name = envVarName(provider);
  return name ? (process.env[name] ?? undefined) : undefined;
}

// Keychain is primary (durable, encrypted by the OS); env var is the fallback for headless/CI.
export function getKey(provider: string): string | undefined {
  try {
    const stored = new (keychain()!)(SERVICE, provider).getPassword();
    if (stored) return stored;
  } catch {
    // Keychain unavailable (headless Linux, locked, no binding) or entry missing → fall to env.
  }
  return envKey(provider);
}

export function setKey(provider: string, key: string): void {
  const Entry = keychain();
  if (!Entry) throw new Error("no OS keychain available here — set the provider's env var, or use `amux-core auth login`");
  new Entry(SERVICE, provider).setPassword(key);
}

// Remove a stored key so logout/rotation actually revokes it. Best effort — a missing entry or an
// unavailable keychain is not an error (there's nothing to revoke there).
export function deleteKey(provider: string): void {
  try {
    new (keychain()!)(SERVICE, provider).deletePassword();
  } catch {
    // no entry / keychain unavailable — nothing to remove
  }
}
