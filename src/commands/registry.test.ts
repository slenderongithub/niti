import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRegistry, BUILTIN_COMMANDS, loadCommands } from "./registry.ts";
import { Engine } from "../engine.ts";
import { openDb } from "../store/db.ts";
import { SessionStore } from "../store/session-store.ts";
import type { Provider } from "../providers/provider.ts";

const stub: Provider = { async send() { return { text: "ok", toolCalls: [] }; } };

function engine(store?: SessionStore): Engine {
  return new Engine({
    configs: [{ id: "a", provider: "anthropic", model: "m", role: "r", systemPrompt: "s" }],
    makeProvider: () => stub,
    store,
  });
}

test("view commands are a pure client-side switch", async () => {
  const r = new CommandRegistry(BUILTIN_COMMANDS);
  expect(await r.run(engine(), "graph")).toEqual({ ok: true, message: "", view: "graph" });
});

test("/undo reports what it reverted (or that there's nothing to revert)", async () => {
  const store = new SessionStore(openDb(":memory:"));
  const r = new CommandRegistry(BUILTIN_COMMANDS);
  expect(await r.run(engine(store), "undo")).toEqual({ ok: true, message: "nothing to undo" });
});

test("/model validates its arguments before touching the engine", async () => {
  const r = new CommandRegistry(BUILTIN_COMMANDS);
  expect(await r.run(engine(), "model", "")).toEqual({ ok: false, message: "usage: /model <agentId> <provider/model>" });
  const missing = await r.run(engine(), "model", "nobody anthropic/claude-opus-4-8");
  expect(missing.ok).toBe(false);
  expect(missing.message).toMatch(/no such agent/);
});

test("/sessions lists what the store holds", async () => {
  const store = new SessionStore(openDb(":memory:"));
  store.createSession({ agentId: "architect", kind: "task", provider: "google", model: "gemini", taskId: "t1" });
  const r = new CommandRegistry(BUILTIN_COMMANDS);
  const out = await r.run(engine(store), "sessions");
  expect(out.message).toContain("architect");
  expect(out.message).toContain("google/gemini");
  expect((await r.run(engine(store), "sessions", "t2")).message).toBe("no sessions yet"); // filtered by task
});

test("an unknown command is reported, not thrown", async () => {
  expect(await new CommandRegistry(BUILTIN_COMMANDS).run(engine(), "nope")).toEqual({ ok: false, message: "unknown command: /nope" });
});

test("a .amux/commands/*.md file becomes a command that submits its body", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amux-cmds-"));
  writeFileSync(join(dir, "review.md"), "---\nname: review\ndescription: Review the diff\n---\nReview the changes in $ARGUMENTS and report problems.\n");

  const [cmd] = loadCommands(dir);
  expect(cmd?.name).toBe("review");
  expect(cmd?.description).toBe("Review the diff");

  const e = engine();
  let submitted = "";
  e.submit = async (goal: string) => { submitted = goal; };
  expect((await cmd!.run(e, "src/agent")).ok).toBe(true);
  expect(submitted).toBe("Review the changes in src/agent and report problems.");
});

test("a file without frontmatter still works, named after the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "amux-cmds-"));
  writeFileSync(join(dir, "ship.md"), "Ship it.");
  expect(loadCommands(dir).map((c) => c.name)).toEqual(["ship"]);
  expect(loadCommands("/no/such/dir")).toEqual([]);
});

test("a user command overrides a built-in of the same name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amux-cmds-"));
  writeFileSync(join(dir, "undo.md"), "---\ndescription: mine\n---\nbody\n");
  const r = new CommandRegistry([...BUILTIN_COMMANDS, ...loadCommands(dir)]);
  expect(r.list().find((c) => c.name === "undo")?.description).toBe("mine");
  expect(r.list().filter((c) => c.name === "undo")).toHaveLength(1);
});

test("list() is what a client renders for autocomplete", () => {
  const names = new CommandRegistry(BUILTIN_COMMANDS).list().map((c) => c.name);
  expect(names).toEqual(["panes", "graph", "usage", "cancel", "undo", "model", "sessions"]);
});
