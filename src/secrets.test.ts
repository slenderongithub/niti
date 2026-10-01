import { test, expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSecretPath, shellTouchesSecret } from "./secrets.ts";

test("credential files are recognised, templates and ordinary files are not", () => {
  for (const p of [".env", ".env.local", "config/.env.production", "server.pem", "id_rsa", "id_ed25519", ".netrc", ".git-credentials", join(homedir(), ".ssh", "config"), join(homedir(), ".aws", "credentials")]) {
    expect([p, isSecretPath(p, "/proj")]).toEqual([p, true]);
  }
  for (const p of [".env.example", ".env.sample", "id_rsa.pub", "src/env.ts", "README.md", "keys.ts"]) {
    expect([p, isSecretPath(p, "/proj")]).toEqual([p, false]);
  }
});

test("a shell call naming a secret anywhere in its arguments is caught", () => {
  expect(shellTouchesSecret("cat", [".env"], "/proj")).toBe(true);
  expect(shellTouchesSecret("cp", ["~/.ssh/id_rsa", "x"], "/proj")).toBe(true);
  expect(shellTouchesSecret("docker", ["run", "--env-file=.env.local", "img"], "/proj")).toBe(true);
  expect(shellTouchesSecret("cat", ["package.json"], "/proj")).toBe(false);
  expect(shellTouchesSecret("cp", [".env.example", ".env.example.bak"], "/proj")).toBe(false);
});
