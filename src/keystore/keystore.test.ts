import { test, expect, afterEach } from "bun:test";
import { envKey, envVarName } from "./keystore.ts";

// Only the pure env-fallback logic is tested — the keychain path belongs to @napi-rs/keyring
// and writing to the real OS keychain in a test would prompt or mutate machine state.

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
});

test("envVarName maps known providers", () => {
  expect(envVarName("anthropic")).toBe("ANTHROPIC_API_KEY");
  expect(envVarName("openai")).toBe("OPENAI_API_KEY");
  expect(envVarName("unknown")).toBeUndefined();
});

test("envKey reads the provider's env var when set", () => {
  process.env.OPENAI_API_KEY = "sk-test-123";
  expect(envKey("openai")).toBe("sk-test-123");
});

test("envKey returns undefined when unset or provider unknown", () => {
  expect(envKey("openai")).toBeUndefined();
  expect(envKey("nope")).toBeUndefined();
});
