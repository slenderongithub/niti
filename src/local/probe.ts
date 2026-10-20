// The model check: a short, hidden test a local model sits once (on its first use as an agent, or on
// demand), so niti knows how to drive it instead of assuming it behaves like a frontier model. Every
// model niti meets differs in ways that decide whether it can build anything: whether it calls tools
// through the API, in which text shape when it doesn't, whether forcing works, whether it can split
// work for a team, which template tokens it leaks, whether it thinks out loud. The findings go on the
// model's manifest; the agent protocol (agent.ts) and the planner read them.
import type { ProviderReply, ToolSpec, Turn } from "../providers/provider.ts";
import { extractTextToolCalls } from "../agent/toolcalls.ts";
import { parsePlanLines } from "../orchestrator/planner.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getInstalled, updateManifest, formatOf, modelDir, type InstalledModel, type ProbeResult } from "./store.ts";
import { LocalProvider, TEMPLATE_TOKENS, type TurnOptions } from "./provider.ts";
import { localRuntime, type LocalRuntime } from "./runtime.ts";

export const PROBE_VERSION = 1;

const WRITE: ToolSpec = {
  name: "write_file",
  description: "Create or overwrite a file with the given content.",
  parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
};
const FINISH: ToolSpec = {
  name: "finish",
  description: "Call this when the task is complete, with a one-sentence summary.",
  parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
};
const TOOLS = [WRITE, FINISH];
const SYSTEM = "You are a coding agent working in a project folder. You act by calling tools. Call one tool per reply.";
const TASK = "Create a file named hello.txt whose content is exactly: hi";

// The openers that start a call in the shapes models are trained on, best first for the template.
export function callOpeners(template: string): string[] {
  const out: string[] = [];
  if (/<tool_call>/.test(template)) out.push('<tool_call>\n{"name": "');
  if (/<function=/.test(template)) out.push("<tool_call>\n<function=");
  if (/\[TOOL_CALLS\]/.test(template)) out.push('[TOOL_CALLS][{"name": "');
  out.push('{"name": "');
  return [...new Set(out)];
}

// Which text shape a reply's call was in, for the record.
function textShape(text: string): string {
  if (/<tool_call>\s*<function=/.test(text)) return "qwen3-coder-xml";
  if (/<tool_call>/.test(text)) return "tool_call-json";
  if (/<function=/.test(text)) return "function-xml";
  if (/<function>/.test(text)) return "function-json";
  if (/\[TOOL_CALLS\]/.test(text)) return "mistral";
  return "json";
}

const wroteHello = (r: { calls: { name: string; input: Record<string, unknown> }[] } | undefined) =>
  !!r && r.calls.some((c) => c.name === "write_file" && String(c.input.path ?? "").endsWith("hello.txt") && /hi/.test(String(c.input.content ?? "")));

const leaked = (texts: string[]) => TEMPLATE_TOKENS.filter((t) => texts.some((x) => x.includes(t)));

export interface ProbeDeps {
  runtime?: LocalRuntime;
  // The template a model ships with, to pick call openers (tests pass one; real models read the
  // manifest's chat template when known, else the generic opener).
  template?: string;
}

// Runs the battery against an installed model. Each step is one short call at temperature 0.2.
export async function probeModel(id: string, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const m = getInstalled(id);
  if (!m) throw new Error(`${id} is not installed`);
  const runtime = deps.runtime ?? localRuntime();
  const provider = new LocalProvider(id, `probe:${id}`, undefined, 600, runtime);
  runtime.onStatus({ model: id, engine: formatOf(m) === "mlx" ? "mlx" : "llama.cpp", state: "checking" });
  const mlx = formatOf(m) === "mlx";
  const texts: string[] = [];
  const notes: string[] = [];
  const ask = async (turns: Turn[], tools: ToolSpec[], turn: TurnOptions = {}, system = SYSTEM): Promise<ProviderReply> => {
    provider.next = { temperature: 0.2, maxTokens: 600, thinking: false, ...turn };
    const r = await provider.send(system, turns, tools);
    texts.push(r.text);
    return r;
  };
  const user = (text: string): Turn[] => [{ role: "user", text }];

  // 1. Left to itself, does it call the tool through the API?
  const first = await ask(user(TASK), TOOLS);
  let toolMode: ProbeResult["toolMode"] = "none";
  let textFormat: string | undefined;
  let prefill: string | undefined;
  if (wroteHello({ calls: first.toolCalls })) {
    toolMode = "native";
  } else {
    // 2. Did it write the call as text niti can read?
    const fromText = extractTextToolCalls(first.text, TOOLS.map((t) => t.name));
    if (wroteHello(fromText)) {
      toolMode = "text";
      textFormat = textShape(first.text);
    }
    // 3. Does forcing work? llama.cpp: grammar. MLX: start the reply in the model's call shape.
    if (!mlx) {
      const forced = await ask(user(TASK), TOOLS, { toolChoice: "required" });
      if (wroteHello({ calls: forced.toolCalls })) toolMode = toolMode === "none" ? "forced" : toolMode === "text" ? "forced" : toolMode;
    } else {
      for (const opener of callOpeners(deps.template ?? "")) {
        const r = await ask(user(TASK), TOOLS, { prefill: opener });
        const parsed = extractTextToolCalls(r.text, TOOLS.map((t) => t.name));
        if (wroteHello(parsed)) {
          prefill = opener;
          if (toolMode === "none" || toolMode === "text") toolMode = "forced";
          textFormat ??= textShape(r.text);
          break;
        }
      }
    }
  }

  // 4. Can it split work for a team, in the one-line-per-teammate form the planner uses?
  const tPlan = Date.now();
  const planReply = await ask(
    user(
      "Two teammates: frontend (owns the UI) and backend (owns the server). Goal: a todo-list web app with an API.\n" +
        "Write exactly one line per teammate, in this form and nothing else:\nfrontend: <their task, naming the files to create>\nbackend: <their task, naming the files to create>",
    ),
    [],
    {},
    "You plan work for a team. Answer only in the form asked for.",
  );
  const planSeconds = (Date.now() - tPlan) / 1000;
  const lines = parsePlanLines(planReply.text, ["frontend", "backend"]);
  // Speed from a call made with the model already loaded (the first one includes loading it).
  const tokensPerSec = planSeconds > 0 && planReply.usage?.outputTokens ? Math.round(planReply.usage.outputTokens / planSeconds) : undefined;
  const planMode: ProbeResult["planMode"] = lines.frontend && lines.backend ? "lines" : "none";
  if (planMode === "none") notes.push("couldn't split work into one line per teammate — niti plans for teams it leads by role instead");

  // Both engines pull a thinking model's reasoning out of the answer (llama.cpp's reasoning-format,
  // mlx-lm's reasoning state); the check itself runs with thinking off, so this is the template's say.
  const thinking: ProbeResult["thinking"] = m.thinking || (first.raw as { openaiReasoning?: unknown } | undefined)?.openaiReasoning ? "separate" : "none";
  const stops = leaked(texts);
  if (stops.length) notes.push(`writes ${stops.join(" ")} past its turn — niti stops it there`);

  let verdict: ProbeResult["verdict"];
  if (toolMode === "native" || toolMode === "forced") {
    verdict = planMode === "none" ? "partial" : "ready";
    notes.unshift(toolMode === "native" ? "calls tools on its own" : mlx ? "calls tools once niti starts the call for it" : "calls tools when niti requires one");
  } else if (toolMode === "text") {
    verdict = "partial";
    notes.unshift(`writes tool calls as text (${textFormat}); niti reads them, but less reliably than real calls`);
  } else {
    verdict = "chat-only";
    notes.unshift("never called a tool, even when forced — fine for questions and reviews, not for building");
  }

  const result: ProbeResult = {
    version: PROBE_VERSION,
    checkedAt: Date.now(),
    engine: mlx ? "mlx" : "llama.cpp",
    toolMode,
    ...(textFormat ? { textFormat } : {}),
    ...(prefill ? { prefill } : {}),
    planMode,
    stops,
    thinking,
    ...(tokensPerSec ? { tokensPerSec } : {}),
    verdict,
    notes,
  };
  updateManifest(id, { probe: result });
  runtime.unregister(`probe:${id}`);
  runtime.onStatus({ model: id, engine: result.engine, state: "ready" });
  return result;
}

// The chat template a model ships with, read from its files (MLX models keep it in the tokenizer
// config or chat_template.jinja). Empty for GGUF, whose forcing needs no opener.
export function templateOf(m: InstalledModel): string {
  if (formatOf(m) !== "mlx") return "";
  const dir = modelDir(m);
  let t = "";
  try {
    const tc = JSON.parse(readFileSync(join(dir, "tokenizer_config.json"), "utf8")) as { chat_template?: unknown };
    t = typeof tc.chat_template === "string" ? tc.chat_template : JSON.stringify(tc.chat_template ?? "");
  } catch {
    // none
  }
  try {
    t += readFileSync(join(dir, "chat_template.jinja"), "utf8");
  } catch {
    // none
  }
  return t;
}

// One check per model at a time, run before the model's first agent request when it has none (or an
// older one). Concurrent first uses wait on the same check.
const running = new Map<string, Promise<ProbeResult>>();
export function ensureProbed(m: InstalledModel, deps: ProbeDeps = {}): Promise<ProbeResult | undefined> {
  if (m.probe && m.probe.version === PROBE_VERSION) return Promise.resolve(m.probe);
  if (process.env.NITI_SKIP_PROBE === "1") return Promise.resolve(undefined);
  let p = running.get(m.id);
  if (!p) {
    p = probeModel(m.id, { template: templateOf(m), ...deps }).finally(() => running.delete(m.id));
    running.set(m.id, p);
  }
  return p.catch(() => undefined); // a check that couldn't run leaves the model on niti's defaults
}
