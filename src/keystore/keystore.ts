import { Entry } from "@napi-rs/keyring";
import { CATALOG } from "../providers/catalog.ts";

const SERVICE = "amux";

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
    const stored = new Entry(SERVICE, provider).getPassword();
    if (stored) return stored;
  } catch {
    // Keychain unavailable (headless Linux, locked) or entry missing → fall through to env.
  }
  return envKey(provider);
}

export function setKey(provider: string, key: string): void {
  new Entry(SERVICE, provider).setPassword(key);
}

// Remove a stored key so logout/rotation actually revokes it. Best effort — a missing entry or an
// unavailable keychain is not an error (there's nothing to revoke there).
export function deleteKey(provider: string): void {
  try {
    new Entry(SERVICE, provider).deletePassword();
  } catch {
    // no entry / keychain unavailable — nothing to remove
  }
}
