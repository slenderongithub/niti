import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listCredentials,
  getCredential,
  setCredential,
  removeCredential,
  resolveApiKey,
  resolveBaseURL,
} from "./auth-store.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "niti-auth-"));
  process.env.NITI_AUTH_FILE = join(dir, "auth.json");
});

afterEach(() => {
  delete process.env.NITI_AUTH_FILE;
  rmSync(dir, { recursive: true, force: true });
});

test("empty store returns no credentials", () => {
  expect(listCredentials()).toEqual([]);
  expect(getCredential("openai")).toBeUndefined();
});

test("set + get + resolve an api key", () => {
  setCredential({ provider: "openai", type: "api", key: "sk-test" });
  expect(getCredential("openai")).toEqual({ provider: "openai", type: "api", key: "sk-test" });
  expect(resolveApiKey("openai")).toBe("sk-test");
});

test("upsert replaces the same provider, does not duplicate", () => {
  setCredential({ provider: "openai", type: "api", key: "one" });
  setCredential({ provider: "openai", type: "api", key: "two" });
  const creds = listCredentials();
  expect(creds.length).toBe(1);
  expect(resolveApiKey("openai")).toBe("two");
});

test("oauth credential resolves to its access token", () => {
  setCredential({ provider: "github-copilot", type: "oauth", access: "gho_abc" });
  expect(resolveApiKey("github-copilot")).toBe("gho_abc");
});

test("local credential exposes its baseURL and no api key", () => {
  setCredential({ provider: "ollama", type: "local", baseURL: "http://localhost:11434/v1" });
  expect(resolveBaseURL("ollama")).toBe("http://localhost:11434/v1");
  expect(resolveApiKey("ollama")).toBeUndefined();
});

test("remove deletes a credential and prunes the file when empty", () => {
  setCredential({ provider: "openai", type: "api", key: "sk" });
  setCredential({ provider: "groq", type: "api", key: "gk" });
  removeCredential("openai");
  expect(getCredential("openai")).toBeUndefined();
  expect(resolveApiKey("groq")).toBe("gk");
  removeCredential("groq");
  expect(existsSync(process.env.NITI_AUTH_FILE!)).toBe(false);
});

test("store file is written with 0600 permissions", () => {
  setCredential({ provider: "openai", type: "api", key: "sk" });
  const mode = statSync(process.env.NITI_AUTH_FILE!).mode & 0o777;
  expect(mode).toBe(0o600);
});

test("with a test store, resolveApiKey never falls through to the real keychain/env", () => {
  process.env.OPENAI_API_KEY = "real-env-key-should-not-leak";
  try {
    expect(resolveApiKey("openai")).toBeUndefined(); // absent from temp store → undefined, not the env key
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test("corrupt store is treated as empty, not fatal", () => {
  const { writeFileSync } = require("node:fs");
  writeFileSync(process.env.NITI_AUTH_FILE!, "{ not json");
  expect(listCredentials()).toEqual([]);
});
