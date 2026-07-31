import { test, expect } from "bun:test";
import { Engine } from "./engine.ts";
import { openDb } from "./store/db.ts";
import { SessionStore } from "./store/session-store.ts";
import type { Provider, ProviderReply } from "./providers/provider.ts";
import type { AgentConfig } from "./agent/agent.ts";
import type { ServerEvent } from "./server/events.ts";

let backendCalls = 0;
let backendSaw = "";

// Fake provider dispatched by a marker in each agent's system prompt. The frontend, on its task,
// asks the backend for the API shape (ask_agent), then finishes.
const fake: Provider = {
  async send(sys, turns): Promise<ProviderReply> {
    const hasToolResult = turns.some((t) => t.role === "tool");
    const lastUser = [...turns].reverse().find((t) => t.role === "user");
    const lastText = lastUser && "text" in lastUser ? lastUser.text : "";

    if (sys.includes("ORCH")) {
      if (lastText.includes("orchestrator of a team")) return { text: '[{"description":"build the frontend","role":"frontend"}]', toolCalls: [] };
      return { text: "Reviewed: the frontend was built against the backend API.", toolCalls: [] };
    }
    if (sys.includes("BACKEND")) {
      backendCalls++;
      backendSaw = lastText;
      return { text: "REST: GET /products returns JSON", toolCalls: [] };
    }
    // FRONTEND: first turn asks the backend; after the answer comes back, finish.
    if (!hasToolResult) {
      return { text: "", toolCalls: [{ id: "c1", name: "ask_agent", input: { to: "backend", question: "what is the API shape?" } }] };
    }
    return { text: "frontend done, using the API shape from backend", toolCalls: [] };
  },
};

const configs: AgentConfig[] = [
  { id: "orchestrator", provider: "anthropic", model: "x", role: "Orchestrator", systemPrompt: "ORCH", lead: true, allowedTools: [] },
  { id: "frontend", provider: "anthropic", model: "x", role: "Frontend", systemPrompt: "FRONTEND", allowedTools: [] },
  { id: "backend", provider: "anthropic", model: "x", role: "Backend", systemPrompt: "BACKEND", allowedTools: [] },
];

test("ask_agent: frontend talks directly to backend; answer doesn't clobber frontend's task output", async () => {
  backendCalls = 0;
  backendSaw = "";
  const engine = new Engine({ configs, makeProvider: () => fake, interactive: false });
  const messages: { from: string; to: string; kind: string }[] = [];
  engine.hub.subscribe((e: ServerEvent) => {
    if (e.kind === "agent_message") messages.push({ from: e.message.from, to: e.message.to, kind: e.message.kind });
  });

  await engine.submit("build me a store");

  // The direct exchange happened and is visible to the graph (question + answer edges).
  expect(messages).toContainEqual({ from: "frontend", to: "backend", kind: "question" });
  expect(messages).toContainEqual({ from: "backend", to: "frontend", kind: "answer" });

  // The peer was invoked exactly once and saw the question verbatim (no double-delivery).
  expect(backendCalls).toBe(1);
  expect(backendSaw).toBe("what is the API shape?");

  // Critically, the frontend task's stored output is the frontend's own final text — NOT the
  // backend's answer (which would happen if respond() clobbered the shared lastText).
  const t1 = engine.orch.all.find((t) => t.assignedTo === "frontend");
  expect(t1?.output).toBe("frontend done, using the API shape from backend");
  expect(t1?.status).toBe("done");
});

test("a cross-provider exchange leaves a persisted, linked thread behind", async () => {
  backendCalls = 0;
  const store = new SessionStore(openDb(":memory:"));
  const engine = new Engine({ configs, makeProvider: () => fake, interactive: false, store });

  await engine.submit("build me a store");

  // The frontend's task session, and the backend's answering session hanging off it.
  const [frontendSession] = store.listSessions({ agentId: "frontend", kind: "task" });
  expect(frontendSession).toBeDefined();
  const [answering] = store.listSessions({ parentSessionId: frontendSession!.id });
  expect(answering?.kind).toBe("ask");
  expect(answering?.agentId).toBe("backend"); // answered by the *other* provider's agent
  expect(store.loadTurns(answering!.id).at(-1)).toMatchObject({ role: "assistant", text: "REST: GET /products returns JSON" });

  // ...and both halves of the exchange are linked to the asking session, so it reads as one thread.
  const thread = store.listMessages(frontendSession!.id);
  expect(thread.map((m) => `${m.from}->${m.to}:${m.kind}`)).toEqual(["frontend->backend:question", "backend->frontend:answer"]);
  expect(thread[1]?.body).toBe("REST: GET /products returns JSON");
});

test("resume re-runs unfinished tasks with their stored conversation, and leaves finished ones alone", async () => {
  const store = new SessionStore(openDb(":memory:"));
  const single: AgentConfig[] = [{ id: "a", provider: "anthropic", model: "x", role: "A", systemPrompt: "s", lead: true, allowedTools: [] }];
  const calls: string[][] = [];
  const provider: Provider = {
    async send(_sys, turns) {
      calls.push(turns.flatMap((t) => (t.role === "user" ? [t.text] : t.role === "assistant" ? [t.text] : [])));
      return { text: "finished the second half", toolCalls: [] };
    },
  };
  const engine = new Engine({ configs: single, makeProvider: () => provider, store, interactive: false });

  // As if a previous run had been interrupted mid-task, with its conversation already persisted.
  const prior = store.createSession({ agentId: "a", kind: "task", provider: "anthropic", model: "x", taskId: "t1" });
  store.appendMessage(prior, "user", [{ type: "text", content: "the original brief" }]);
  store.appendMessage(prior, "assistant", [{ type: "text", content: "I did the first half" }]);
  engine.orch.load([
    { id: "t1", description: "build the thing", status: "in_progress", assignedTo: "a" },
    { id: "t0", description: "already finished", status: "done", assignedTo: "a" },
  ]);

  await engine.resume();

  // calls[0] is the resumed task (calls[1] is the orchestrator's integrate pass).
  expect(calls[0]).toEqual(["the original brief", "I did the first half", "build the thing"]);
  expect(engine.orch.all.find((t) => t.id === "t1")?.status).toBe("done");
  expect(store.listSessions({ taskId: "t1" })).toHaveLength(2); // the prior session plus this run's
  // The finished task was never re-run: no session was ever created for it.
  expect(store.listSessions({ taskId: "t0" })).toHaveLength(0);
});

test("switchModel rejects a live swap while the target agent is mid-task", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow: Provider = {
    async send(_sys, turns) {
      const lastUser = [...turns].reverse().find((t) => t.role === "user");
      const text = lastUser && "text" in lastUser ? lastUser.text : "";
      if (text.includes("orchestrator of a team")) {
        return { text: '[{"description":"do it","role":"a"}]', toolCalls: [] }; // plan immediately, don't block
      }
      await gate; // only the actual task call blocks
      return { text: "done", toolCalls: [] };
    },
  };
  const single: AgentConfig[] = [{ id: "a", provider: "anthropic", model: "x", role: "A", systemPrompt: "s", lead: true, allowedTools: [] }];
  const engine = new Engine({ configs: single, makeProvider: () => slow, interactive: false });

  const running = engine.submit("do something");
  await new Promise((r) => setTimeout(r, 20)); // let the plan-fallback path start the task's run()

  const err = engine.switchModel("a", "anthropic", "claude-haiku-4-5");
  expect(err).toContain("mid-task");

  release();
  await running;
  expect(engine.switchModel("a", "anthropic", "claude-haiku-4-5")).toBeUndefined(); // fine once idle
});

test("plan mode publishes the DAG and runs nothing", async () => {
  const seen: string[] = [];
  const planner: Provider = {
    async send(_sys, turns) {
      const lastUser = [...turns].reverse().find((t) => t.role === "user");
      const text = lastUser && "text" in lastUser ? lastUser.text : "";
      seen.push(text);
      if (text.includes("orchestrator of a team")) {
        return { text: '[{"description":"write the parser","role":"a"},{"description":"test it","role":"a"}]', toolCalls: [] };
      }
      return { text: "executed", toolCalls: [] };
    },
  };
  const single: AgentConfig[] = [{ id: "a", provider: "anthropic", model: "x", role: "A", systemPrompt: "s", lead: true, allowedTools: [] }];
  const engine = new Engine({ configs: single, makeProvider: () => planner, interactive: false });
  const plans: number[] = [];
  engine.hub.subscribe((e: ServerEvent) => {
    if (e.kind === "orchestration" && e.event.type === "plan") plans.push(e.event.tasks.length);
  });

  await engine.submit("build a parser", { planOnly: true });

  expect(plans).toEqual([2]); // the plan reached the UI
  expect(seen).toHaveLength(1); // the planning call, and nothing else — no task was executed
  expect(engine.orch.all.every((t) => t.status === "pending")).toBe(true);

  // The same goal in build mode does run the tasks the plan produced.
  await engine.submit("build a parser");
  expect(seen.length).toBeGreaterThan(1);
});
