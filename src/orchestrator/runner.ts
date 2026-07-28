import type { Agent } from "../agent/agent.ts";
import type { Bus } from "../events/bus.ts";
import type { Orchestrator } from "./orchestrator.ts";
import { summarizeError } from "../providers/provider.ts";

// Extract the first JSON array of strings from a model response. Tolerant of prose around the JSON.
export function parseTaskList(raw: string): string[] {
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const v = JSON.parse(m[0]);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function decompose(lead: Agent, prompt: string): Promise<string[]> {
  const raw = await lead.ask(
    `Break this project request into a short list of independent subtasks (2-5), each doable by one engineer. ` +
      `Return ONLY a JSON array of strings, nothing else.\n\nRequest: ${prompt}`,
  );
  const tasks = parseTaskList(raw);
  return tasks.length ? tasks : [prompt]; // fallback: whole prompt as one task
}

const MAX_ATTEMPTS = 3; // failover retries before a task is marked failed

// Each agent loops: claim → execute → complete, until all work is finished. Runs concurrently.
// On quota exhaustion the task is requeued so another agent can take it. A worker keeps polling
// while other agents hold in-progress tasks, so a failover never orphans its task.
async function worker(agent: Agent, orch: Orchestrator, bus: Bus): Promise<void> {
  const id = agent.config.id;
  for (;;) {
    const task = orch.claimTask(id);
    if (!task) {
      if (!orch.hasUnfinished()) return;
      await new Promise((r) => setTimeout(r, 30)); // ponytail: naive poll wait, fine for a handful of agents
      continue;
    }
    bus.publish({ agentId: id, type: "thought", payload: `claimed ${task.id}: ${task.description}`, time: Date.now() });
    const outcome = await agent.run(task.description);
    if (outcome === "exhausted" && (task.attempts ?? 0) < MAX_ATTEMPTS) {
      orch.requeue(task, id);
      bus.publish({ agentId: id, type: "failover", payload: `${id} exhausted — ${task.id} reassigned`, time: Date.now() });
    } else {
      orch.complete(task, outcome === "done");
    }
  }
}

// Full v1 core loop: lead decomposes → tasks queued → all agents drain the queue concurrently.
export async function runProject(
  prompt: string,
  agents: Agent[],
  orch: Orchestrator,
  bus: Bus,
): Promise<void> {
  const lead = agents.find((a) => a.config.lead) ?? agents[0];
  if (!lead) throw new Error("no agents configured");

  bus.publish({ agentId: lead.config.id, type: "thought", payload: `decomposing: ${prompt}`, time: Date.now() });
  let descs: string[];
  try {
    descs = await decompose(lead, prompt);
  } catch (err) {
    // A down/mis-keyed lead provider shouldn't crash the run — fall back to the whole prompt as one task.
    bus.publish({ agentId: lead.config.id, type: "error", payload: `decompose failed: ${summarizeError(err)}`, time: Date.now() });
    descs = [prompt];
  }
  for (const desc of descs) {
    const t = orch.addTask(desc);
    bus.publish({ agentId: lead.config.id, type: "thought", payload: `queued ${t.id}: ${desc}`, time: Date.now() });
  }

  await Promise.allSettled(agents.map((a) => worker(a, orch, bus)));
}

// Exposed for testing the concurrency/claim path without a decomposition call.
export { worker as runWorker };
