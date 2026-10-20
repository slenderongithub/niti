// What to do with a tool call that isn't quite one. Small models — and now and then a large one —
// send arguments that are almost JSON, name a tool that doesn't exist, leave out a required field,
// or write the call into their reply as text instead of through the API. Each used to fail silently
// (empty arguments, a finished-looking reply); now each is either repaired or answered with an error
// that says exactly what to fix, which a model can act on and an empty object never told it.
import type { ToolCall, ToolSpec } from "../providers/provider.ts";

// JSON as models get it wrong: wrapped in a code fence, trailing commas, Python literals, single
// quotes around keys and strings. Only repairs that cannot change what a well-formed value means.
export function repairJson(raw: string): Record<string, unknown> | undefined {
  const attempts: string[] = [];
  let s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  attempts.push(s);
  s = s.replace(/,\s*([}\]])/g, "$1");
  attempts.push(s);
  s = s.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null");
  attempts.push(s);
  if (!s.includes('"') && s.includes("'")) attempts.push(s.replace(/'/g, '"'));
  // A model that stopped one brace short.
  const open = (s.match(/{/g) ?? []).length - (s.match(/}/g) ?? []).length;
  if (open > 0 && open < 4) attempts.push(s + "}".repeat(open));
  for (const a of attempts) {
    try {
      const v = JSON.parse(a);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // next
    }
  }
  return undefined;
}

// The provider-side parse: arguments as sent, repaired if need be, or the reason they were unusable.
export function parseToolArgs(raw: string | undefined): { input: Record<string, unknown>; error?: string } {
  if (!raw || !raw.trim()) return { input: {} };
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return { input: v as Record<string, unknown> };
    return { input: {}, error: "arguments must be a JSON object" };
  } catch (err) {
    const repaired = repairJson(raw);
    if (repaired) return { input: repaired };
    return { input: {}, error: `arguments were not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length]![b.length]!;
}

export function closestTool(name: string, names: string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const n of names) {
    const d = distance(name.toLowerCase(), n.toLowerCase());
    if (d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best && bestD <= Math.max(2, Math.floor(name.length / 3)) ? best : undefined;
}

export function unknownToolMessage(name: string, names: string[]): string {
  const near = closestTool(name, names);
  return `error: there is no tool named '${name}'.${near ? ` Did you mean '${near}'?` : ""} The tools you have: ${names.join(", ")}.`;
}

// Required fields present, and no value of the wrong shape. Not a full JSON Schema validator:
// enough to turn "Cannot read properties of undefined" into "missing 'path'". Lenient where the
// tools already are — "12" for a number, 12 or true for a string are coerced downstream
// (toSandboxCall), and models send them all the time — strict where nothing can coerce: an object
// or array where a scalar belongs, or the other way round.
export function checkArgs(spec: ToolSpec, input: Record<string, unknown>): string | undefined {
  const schema = spec.parameters as { properties?: Record<string, { type?: string }>; required?: string[] };
  const missing = (schema.required ?? []).filter((k) => input[k] === undefined || input[k] === null);
  if (missing.length) {
    return `error: ${spec.name} needs ${missing.map((k) => `'${k}'`).join(", ")} — call it again with ${missing.length > 1 ? "them" : "it"} set.`;
  }
  for (const [k, v] of Object.entries(input)) {
    const want = schema.properties?.[k]?.type;
    if (!want || v === undefined || v === null) continue;
    const got = Array.isArray(v) ? "array" : typeof v;
    const scalar = (t: string) => t === "string" || t === "number" || t === "integer" || t === "boolean";
    const numeric = got === "number" || (got === "string" && (v as string).trim() !== "" && Number.isFinite(Number(v)));
    const ok =
      want === got ||
      (want === "integer" && numeric && Number.isInteger(Number(v))) ||
      (want === "number" && numeric) ||
      (want === "string" && (got === "number" || got === "boolean")) ||
      (want === "boolean" && (got === "string" && /^(true|false)$/i.test(v as string))) ||
      (!scalar(want) && want !== "array" && want !== "object");
    if (!ok) return `error: ${spec.name}: '${k}' must be ${want === "array" || want === "integer" ? `an ${want}` : `a ${want}`}, got ${got}.`;
  }
  return undefined;
}

// Calls a model wrote into its reply as text: Hermes/Qwen `<tool_call>{json}</tool_call>`,
// Qwen2.5-Coder's `<function>{json}</function>`,
// Qwen3-Coder's `<function=name><parameter=k>v</parameter></function>`, and a reply that is nothing
// but a JSON `{name, arguments}` object (fenced or not). Only names in `names` count, so prose that
// merely shows an example of some other API never becomes a call. `rest` is the reply without them.
export function extractTextToolCalls(text: string, names: string[]): { calls: ToolCall[]; rest: string } | undefined {
  const known = new Set(names);
  const calls: ToolCall[] = [];
  let rest = text;
  const add = (name: string, input: Record<string, unknown> | undefined) => {
    if (!known.has(name) || !input) return false;
    calls.push({ id: `text-${crypto.randomUUID().slice(0, 8)}`, name, input });
    return true;
  };
  const fromObject = (o: Record<string, unknown> | undefined): boolean => {
    if (!o || typeof o.name !== "string") return false;
    const args = o.arguments ?? o.parameters ?? o.input ?? {};
    const input = typeof args === "string" ? repairJson(args) : (args as Record<string, unknown>);
    return add(o.name, input);
  };

  rest = rest.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (m, body: string) => (fromObject(repairJson(body)) ? "" : m));
  // Qwen2.5-Coder (seen through mlx-lm, whose parser expects <tool_call>): the JSON call wrapped
  // in a bare <function> tag.
  rest = rest.replace(/<function>\s*([\s\S]*?)\s*<\/function>/g, (m, body: string) => (fromObject(repairJson(body)) ? "" : m));
  rest = rest.replace(/<function=([\w.-]+)>([\s\S]*?)<\/function>/g, (m, name: string, body: string) => {
    const input: Record<string, unknown> = {};
    for (const p of body.matchAll(/<parameter=([\w.-]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) {
      const v = p[2]!;
      try {
        input[p[1]!] = /^[[{]/.test(v.trim()) || /^(true|false|null|-?\d+(\.\d+)?)$/.test(v.trim()) ? JSON.parse(v) : v;
      } catch {
        input[p[1]!] = v;
      }
    }
    return add(name, input) ? "" : m;
  });
  if (calls.length === 0) {
    // A JSON call after a sentence ("Let's start.\n\n{"name": "read_file", "arguments": …}"), or
    // several: each balanced {…} that parses and names a known tool with arguments is a call.
    // Only a call that stands on its own lines (or in a fence), never one quoted mid-sentence:
    // "The API takes {…} as its body" is prose about JSON, not a call.
    const own = (start: number, end: number) => /(^|\n)\s*(```(json)?\s*)?$/.test(rest.slice(0, start)) && /^\s*(```\s*)?(\n|$)/.test(rest.slice(end));
    for (const span of jsonObjects(rest).reverse()) {
      if (!own(span.start, span.end)) continue;
      const o = repairJson(span.text);
      if (o && typeof o.name === "string" && known.has(o.name) && ("arguments" in o || "parameters" in o) && fromObject(o)) {
        rest = rest.slice(0, span.start) + rest.slice(span.end);
      }
    }
    calls.reverse(); // found back to front, so the text's offsets stayed valid
    rest = rest.replace(/```(?:json)?\s*```/g, "");
  }
  if (calls.length === 0) {
    // The whole reply is one JSON call (optionally fenced): nothing else in it to misread.
    const whole = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    if (whole.startsWith("{") && whole.endsWith("}") && fromObject(repairJson(whole))) rest = "";
  }
  if (calls.length === 0) return undefined;
  return { calls, rest: rest.replace(/<\/?tool_call>/g, "").trim() };
}

// Every top-level {…} in a text (braces inside JSON strings don't count), with its offsets.
function jsonObjects(text: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"' && depth > 0) inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" && depth > 0 && --depth === 0) out.push({ start, end: i + 1, text: text.slice(start, i + 1) });
  }
  return out;
}

// Thinking a model wrote inline (`<think>…</think>`, or only the closing tag when the chat template
// opened it), separated from the answer. llama-server does this itself with --reasoning-format;
// Ollama, LM Studio and some hosted endpoints don't. `bareClose` (a closing tag with no opening one)
// only for runtimes on this Mac: from anyone else a stray "</think>" is far likelier to be code.
export function splitThinking(text: string, bareClose = false): { thinking: string; answer: string } {
  const open = /^\s*<think>/.exec(text);
  if (open) {
    const close = text.indexOf("</think>", open[0].length);
    if (close < 0) return { thinking: text.slice(open[0].length), answer: "" };
    return { thinking: text.slice(open[0].length, close).trim(), answer: text.slice(close + 8).replace(/^\s+/, "") };
  }
  const close = bareClose ? text.indexOf("</think>") : -1;
  if (close >= 0 && !text.slice(0, close).includes("<think>")) {
    return { thinking: text.slice(0, close).trim(), answer: text.slice(close + 8).replace(/^\s+/, "") };
  }
  return { thinking: "", answer: text };
}

// Files a model pasted into its reply instead of writing them: each fenced block that is clearly
// labelled with a file name — on the line just before it ("**index.html**", "Create `styles.css`:"),
// or in a comment on its own first line (<!-- index.html -->, /* styles.css */, // app.js, # main.py)
// — becomes a write_file call. Unlabelled blocks are left alone: guessing a path would overwrite the
// wrong file.
const FILE = /(?:^|[\s`*"'(])((?:[\w.-]+\/)*[\w.-]+\.(?:html?|css|scss|js|mjs|cjs|jsx|ts|tsx|json|py|md|txt|ya?ml|toml|sh|go|rs|java|rb|php|svelte|vue|sql|env\.example))(?=$|[\s`*"'):,])/i;
export function salvageFiles(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const seen = new Set<string>();
  const re = /```[\w+-]*[^\n]*\n([\s\S]*?)```/g;
  for (const m of text.matchAll(re)) {
    const body = m[1]!;
    const before = text.slice(0, m.index).trimEnd().split("\n").at(-1) ?? "";
    const firstLine = body.split("\n")[0] ?? "";
    const fromComment = /^\s*(?:<!--|\/\*|\/\/|#)\s*(.+?)\s*(?:-->|\*\/)?\s*$/.exec(firstLine)?.[1];
    const path = (fromComment && FILE.exec(` ${fromComment}`)?.[1]) || FILE.exec(` ${before}`)?.[1];
    if (!path || seen.has(path) || body.trim().length < 20) continue;
    seen.add(path);
    calls.push({ id: `salvaged-${crypto.randomUUID().slice(0, 8)}`, name: "write_file", input: { path, content: body.endsWith("\n") ? body : `${body}\n` } });
  }
  return calls;
}
