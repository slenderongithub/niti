// Per-model-family steering, appended after TOOL_GUIDANCE.
//
// The harness's tool coaching was byte-identical for every model in a 152-model catalog, which
// treats "how to use these tools" as if it were a property of the tools rather than of the model
// reading about them. It isn't: the same instruction that lands on Claude is ignored by Flash-Lite
// and over-applied by a reasoning model.
//
// WHAT BELONGS HERE, AND WHAT DOES NOT. Only mechanical steering — verbosity, tool-call shape,
// when to stop. Never conventions that two agents have to agree on: how a hand-off is phrased,
// when to escalate, what a review verdict looks like. Those live in TOOL_GUIDANCE and stay shared,
// because agents from different providers talk to each other, and a convention one family follows
// and another doesn't is a coordination bug that looks like a model bug.
//
// Everything below is a starting point, not a finding. Each line exists because it was observed,
// and the right way to change any of it is to move it and re-run scripts/eval — not to reason
// about what a model "probably" needs. Deliberately short: a long addendum competes with the
// project's own instructions for the model's attention, which is the problem, not the fix.

export type Family = "gemini" | "openai" | "anthropic" | "other";

// Keyed off the model id rather than the provider, because the catalog routes many providers
// through one client: OpenRouter, Groq and a custom endpoint all arrive as provider "openai" while
// serving Gemini, Llama or Claude weights. The id is what says which weights are answering.
export function familyOf(provider: string, model: string): Family {
  const m = model.toLowerCase();
  if (m.includes("gemini") || m.includes("gemma")) return "gemini";
  if (m.includes("claude")) return "anthropic";
  if (/\bgpt|^o[134]\b|^o[134]-/.test(m)) return "openai";
  // No hint in the id: fall back to the client the catalog picked, which is right for the
  // first-party providers and a reasonable guess for the rest.
  if (provider === "google") return "gemini";
  if (provider === "anthropic") return "anthropic";
  if (provider === "openai") return "openai";
  return "other";
}

const GUIDANCE: Record<Family, string> = {
  // Observed directly: asked to write styles, Flash-Lite finished the work and then emitted a
  // multi-screen markdown report re-describing every file it had just written — which is output
  // the user pays for, waits through, and has to scroll past to find the result.
  gemini: [
    "- Do the work, then stop. When you are finished, say so in one or two plain sentences.",
    "- Do not write a summary, a feature list or a report of what you just did. The files you wrote are the answer; restating them wastes the user's time and money.",
    "- Do not narrate your intentions before a tool call. Make the call.",
  ].join("\n"),

  // Parallel tool calls are well supported here and the failure mode is under-use, not confusion.
  openai: [
    "- Issue independent tool calls together in one turn rather than one per turn.",
    "- Finish the whole task before you answer. A partial answer with a plan for the rest is not a completed task.",
  ].join("\n"),

  // Long-prose instructions land reliably; the shared guidance is already tuned for this and a
  // second, differently-worded copy would only compete with it.
  anthropic: "",

  other: "",
};

// The block appended to a system prompt, or "" when the family needs no extra steering.
export function steeringFor(provider: string, model: string): string {
  const text = GUIDANCE[familyOf(provider, model)];
  return text ? `\n\nFor this model specifically:\n${text}` : "";
}
