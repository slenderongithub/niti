import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.ts";
import type { Provider, ProviderReply, Turn } from "./providers/provider.ts";
import type { AgentConfig } from "./agent/agent.ts";
import type { ServerEvent } from "./server/events.ts";

// Interrupting one agent (Engine.interruptAgent): the step in flight is abandoned and the agent
// carries on from the operator's message — its task still finishes, the rest of the run is untouched.

const textOf = (turns: Turn[]) => turns.map((t) => ("text" in t ? t.text : "results" in t ? t.results.map((r) => r.output).join(" ") : "")).join("\n");

function setup(worker: (turns: Turn[], signal?: AbortSignal) => Promise<ProviderReply>, o: { tools?: string[]; interactive?: boolean } = {}) {
  const fake: Provider = {
    async send(sys, turns, _tools, _onDelta, signal) {
      if (sys.includes("LEAD")) {
        const last = turns.at(-1);
        if (last && "text" in last && last.text.includes("orchestrator of a team")) return { text: '[{"description":"do the work","role":"worker"}]', toolCalls: [] };
        return { text: "integrated", toolCalls: [] };
      }
      return worker(turns, signal);
    },
  };
  const configs: AgentConfig[] = [
    { id: "lead", provider: "anthropic", model: "x", role: "Lead", systemPrompt: "LEAD", lead: true, allowedTools: [] },
    { id: "worker", provider: "anthropic", model: "x", role: "Worker", systemPrompt: "WORKER", allowedTools: o.tools ?? [] },
  ];
  const root = mkdtempSync(join(tmpdir(), "niti-int-"));
  const engine = new Engine({ configs, makeProvider: () => fake, root, interactive: o.interactive ?? false, auto: !o.interactive, repoMap: false, verify: false, sandbox: false });
  const events: ServerEvent[] = [];
  engine.hub.subscribe((e) => events.push(e));
  return { engine, events };
}

const until = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
};

const abortable = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), rej(new Error("interrupted"))), { once: true });
  });

test("interrupting a model call: the task carries on from the operator's message and still finishes", async () => {
  let calls = 0;
  let sawMessage = false;
  const { engine, events } = setup(async (turns, signal) => {
    calls++;
    if (textOf(turns).includes("use the other approach")) {
      sawMessage = true;
      return { text: "done the other way", toolCalls: [] };
    }
    await abortable(5000, signal); // a long call the interrupt has to cut short
    return { text: "done the slow way", toolCalls: [] };
  });
  const run = engine.submit("build");
  await until(() => engine.orch.all.some((t) => t.status === "in_progress") && calls > 0);
  const t0 = Date.now();
  expect(engine.interruptAgent("worker", "use the other approach")).toBeUndefined();
  await run;
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(sawMessage).toBe(true);
  expect(engine.orch.all.every((t) => t.status === "done")).toBe(true);
  expect(events.some((e) => e.kind === "agent_event" && e.event.type === "warning" && e.event.payload === "interrupted by the operator")).toBe(true);
});

test("interrupting a shell command kills it, keeps it in the history marked, and goes on", async () => {
  let seen = "";
  const { engine } = setup(
    async (turns) => {
      const all = textOf(turns);
      if (!turns.some((t) => t.role === "tool")) return { text: "", toolCalls: [{ id: "s1", name: "shell", input: { command: "sleep", args: ["10"] } }] };
      seen = all;
      return { text: "ok, stopped", toolCalls: [] };
    },
    { tools: ["shell"] },
  );
  const run = engine.submit("build");
  await until(() => engine.agents.find((a) => a.config.id === "worker")!.busy && engine.orch.all.some((t) => t.status === "in_progress"));
  await Bun.sleep(150); // let the shell start
  const t0 = Date.now();
  expect(engine.interruptAgent("worker", "never mind the sleep")).toBeUndefined();
  await run;
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(seen).toContain("[interrupted by the operator]");
  expect(seen).toContain("never mind the sleep");
  expect(engine.orch.all.every((t) => t.status === "done")).toBe(true);
});

test("interrupting an agent parked on an approval refuses that request, and only that agent's", async () => {
  let seen = "";
  const { engine } = setup(
    async (turns) => {
      if (!turns.some((t) => t.role === "tool")) return { text: "", toolCalls: [{ id: "w1", name: "write_file", input: { path: "a.txt", content: "x" } }] };
      seen = textOf(turns);
      return { text: "fine", toolCalls: [] };
    },
    { tools: ["write_file"], interactive: true },
  );
  const run = engine.submit("build");
  await until(() => engine.pendingApprovals().length === 1);
  expect(engine.interruptAgent("worker", "skip that file")).toBeUndefined();
  await run;
  expect(engine.pendingApprovals()).toHaveLength(0);
  expect(seen).toContain("skip that file");
  expect(engine.orch.all.every((t) => t.status === "done")).toBe(true);
});

test("an idle agent can't be interrupted, and /cancel still stops the whole run", async () => {
  const { engine } = setup(async (_t, signal) => {
    await abortable(5000, signal);
    return { text: "x", toolCalls: [] };
  });
  expect(engine.interruptAgent("worker")).toContain("isn't running");
  expect(engine.interruptAgent("nobody")).toContain("no such agent");
  const run = engine.submit("build");
  await until(() => engine.orch.all.some((t) => t.status === "in_progress"));
  engine.cancel();
  await run;
  expect(engine.orch.all.some((t) => t.status === "failed")).toBe(true); // cancel is not an interrupt
});
