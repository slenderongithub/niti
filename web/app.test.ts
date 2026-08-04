import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

// app.js is a plain browser script (no bundler, no framework) — run it against a minimal stub DOM,
// same technique as graph.test.ts. Unlike graph.test.ts's fresh-object-per-lookup stub, elements
// here are cached per id: app.js re-fetches `$(id)` on every render rather than caching the
// reference itself, so a stub that hands back a new object each call would make state invisible
// across calls.
function load() {
  const noop: any = new Proxy(() => noop, { get: () => noop });
  const elements = new Map<string, any>();
  const el = (id: string) => {
    if (!elements.has(id)) {
      const classes = new Set<string>();
      elements.set(id, {
        addEventListener() {},
        getContext: () => noop,
        classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c), toggle() {} },
        style: {}, value: "", textContent: "", innerHTML: "", checked: true, disabled: false,
        clientWidth: 800, clientHeight: 600, scrollTop: 0, scrollHeight: 0,
        getBoundingClientRect: () => ({ left: 0, right: 800, top: 0, bottom: 600 }),
      });
    }
    return elements.get(id);
  };
  const doc = { getElementById: el, querySelectorAll: () => [], addEventListener() {} };
  const calls: { path: string; body: any }[] = [];
  const win = {
    innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
    addEventListener() {}, requestAnimationFrame() {},
    fetch: (path: string, init?: any) => {
      calls.push({ path, body: init?.body ? JSON.parse(init.body) : undefined });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
    EventSource: class { onopen: any; onerror: any; onmessage: any },
    document: doc, location: { search: "?token=t" }, performance,
  };
  const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const exported = new Function(
    "window", "document", "location", "requestAnimationFrame", "fetch", "EventSource", "performance", "URLSearchParams",
    `${src}\nreturn { handle, onAgentEvent, ensureNode, nodes, renderApproval, answerApproval, onOrch,
       openAgentPanel, sendAgentMessage, esc,
       getPending: () => pendingApprovals, getRunning: () => running, setPromptEnabled };`,
  )(win, doc, win.location, win.requestAnimationFrame, win.fetch, win.EventSource, performance, URLSearchParams);
  return { ...exported, elFor: el, calls };
}

// boot() fires immediately at module load and does one async fetch — flush that microtask before
// a test starts driving state itself, so boot()'s tail can't land after (and clobber) the test's
// own calls.
const settled = async () => { await new Promise((r) => setTimeout(r, 0)); };

test("an approval_request event queues requests and renders the diff for the head of the queue", async () => {
  const g = load();
  await settled();

  g.handle({
    kind: "approval_request",
    requests: [
      { agentId: "a", tool: "edit", input: { path: "x.ts", diff: "@@ line 1 @@\n-old\n+new" } },
      { agentId: "b", tool: "shell", input: { command: "ls" } },
    ],
  });

  expect(g.getPending()).toHaveLength(2);
  expect(g.elFor("approval-overlay").classList.contains("hidden")).toBe(false);
  expect(g.elFor("approval-head").textContent).toContain("a wants to run edit on x.ts");
  expect(g.elFor("approval-diff").innerHTML).toContain("minus");
  expect(g.elFor("approval-diff").innerHTML).toContain("plus");
  expect(g.elFor("approval-diff").innerHTML).toContain("-old");
  expect(g.elFor("approval-diff").innerHTML).toContain("+new");
});

test("answering an approval pops the FIFO queue and posts to /approval, mirroring the TUI", async () => {
  const g = load();
  await settled();
  g.handle({
    kind: "approval_request",
    requests: [{ agentId: "a", tool: "shell", input: { command: "ls" } }, { agentId: "b", tool: "shell", input: { command: "pwd" } }],
  });

  g.answerApproval(true, "agent");

  expect(g.getPending()).toHaveLength(1);
  expect(g.getPending()[0].agentId).toBe("b");
  const call = g.calls.find((c: any) => c.path.startsWith("/approval"));
  expect(call?.body).toEqual({ ok: true, scope: "agent" });
});

test("the queue emptying hides the overlay", async () => {
  const g = load();
  await settled();
  g.handle({ kind: "approval_request", requests: [{ agentId: "a", tool: "shell", input: {} }] });
  expect(g.elFor("approval-overlay").classList.contains("hidden")).toBe(false);

  g.answerApproval(false);
  expect(g.getPending()).toHaveLength(0);
  expect(g.elFor("approval-overlay").classList.contains("hidden")).toBe(true);
});

test("streamed deltas accumulate until a newline; other event types append a line immediately", async () => {
  const g = load();
  await settled();
  g.ensureNode("a", "Architect", true);

  g.onAgentEvent({ agentId: "a", type: "delta", payload: "hel" });
  expect(g.nodes.get("a").log).toEqual([]);
  expect(g.nodes.get("a").pending).toBe("hel");

  g.onAgentEvent({ agentId: "a", type: "delta", payload: "lo\nworld" });
  expect(g.nodes.get("a").log).toEqual(["hello"]);
  expect(g.nodes.get("a").pending).toBe("world");

  g.onAgentEvent({ agentId: "a", type: "tool_call", payload: "read_file x.ts" });
  expect(g.nodes.get("a").log).toEqual(["hello", "[tool_call] read_file x.ts"]);
});

test("the mid-task message box is only enabled while the panel's agent is working", async () => {
  const g = load();
  await settled();
  g.ensureNode("a", "Architect", true);
  g.openAgentPanel("a");
  expect(g.elFor("ap-msg-input").disabled).toBe(true); // idle by default

  g.onOrch({ type: "task_started", role: "a", taskId: "t1" });
  expect(g.elFor("ap-msg-input").disabled).toBe(false);
  expect(g.elFor("ap-msg-send").disabled).toBe(false);

  g.onOrch({ type: "task_done", role: "a", taskId: "t1", ok: true, completed: 1, total: 1 });
  expect(g.elFor("ap-msg-input").disabled).toBe(true);
});

test("sendAgentMessage posts to /agents/:id/message and reports the result", async () => {
  const g = load();
  await settled();
  g.ensureNode("a", "Architect", true);
  g.openAgentPanel("a");
  g.onOrch({ type: "task_started", role: "a", taskId: "t1" });

  g.elFor("ap-msg-input").value = "actually use approach B";
  await g.sendAgentMessage();

  const call = g.calls.find((c: any) => c.path.startsWith("/agents/a/message"));
  expect(call?.body).toEqual({ text: "actually use approach B" });
  expect(g.elFor("ap-msg-input").value).toBe(""); // cleared on success
  expect(g.elFor("ap-msg-status").textContent).toBe("sent");
});

test("a session starting disables the prompt bar; ending re-enables it", async () => {
  const g = load();
  await settled();

  g.handle({ kind: "session", state: "started", goal: "build a thing" });
  expect(g.getRunning()).toBe(true);
  expect(g.elFor("prompt-send").disabled).toBe(true);
  expect(g.elFor("prompt-input").disabled).toBe(true);

  g.handle({ kind: "session", state: "ended" });
  expect(g.getRunning()).toBe(false);
  expect(g.elFor("prompt-send").disabled).toBe(false);
});

test("model-supplied task text cannot inject markup into the dashboard", async () => {
  // This page's URL carries the bearer token, so an injected <script> reads it straight out of
  // location.search. Task ids, statuses, roles and descriptions all originate from a model.
  const g = load();
  await settled();

  expect(g.esc('<img src=x onerror=alert(1)>')).not.toContain("<");
  expect(g.esc('" onmouseover="steal()')).not.toContain('"'); // attribute breakout
  expect(g.esc("it's")).not.toContain("'");
  expect(g.esc("plain text")).toBe("plain text");

  g.onOrch({
    type: "plan",
    goal: "g",
    tasks: [{ id: '<script>x</script>', description: '"><img onerror=alert(1)>', role: "r", dependsOn: ['<b>'] }],
  });
  const html = g.elFor("tab-tasks").innerHTML;
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;");
});

test("a cancelled run reports real progress, and review/replan events are surfaced", async () => {
  const g = load();
  await settled();

  // `complete` used to jump to 100% unconditionally — and my first cut of this referenced the
  // wrong variable, which would have thrown instead. Both are pinned here.
  g.onOrch({ type: "complete", completed: 1, total: 4 });
  expect(g.elFor("bar").style.width).toBe("25%");

  // Review and replan carry the reviewer, task and verdict; the dashboard used to drop them.
  g.onOrch({ type: "review", reviewer: "qa", taskId: "t1", phase: "changes_requested" });
  expect(g.nodes.has("qa")).toBe(true);
  // "orchestrator" is a NON_AGENT_ID, so ensureNode returns null for it — this must not throw.
  g.onOrch({ type: "replan", role: "orchestrator", taskId: "t1", action: "retry", reason: "too vague" });
  g.onOrch({ type: "review", reviewer: "orchestrator", taskId: "t1", phase: "approved" });
});
