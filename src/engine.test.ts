import { test, expect } from "bun:test";
import { Engine } from "./engine.ts";
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
