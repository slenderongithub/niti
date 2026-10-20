// How the harness talks to a model, by the kind of model it is. Frontier models in the cloud read a
// long prompt, juggle twenty tools, batch calls and hold a 100k-token conversation together; a 4–30B
// model on a laptop does none of that reliably. What other harnesses and the measurements say
// (Cline's compact prompt, Pi's four tools, BFCL and the tool-count studies, RULER on effective
// context, llama.cpp's own notes) comes down to: fewer words, fewer tools, one call at a time, compact
// early, catch malformed and repeated calls in the harness rather than hoping the model recovers.
//
// The standard profile is byte-for-byte what every agent got before profiles existed. Everything in
// the local one is a starting point, and the way to change it is scripts/eval with a local model
// (--provider local), not reasoning about what a small model probably needs.
import { CATALOG } from "../providers/catalog.ts";
import { TOOL_GUIDANCE } from "../tools/tools.ts";
import type { RepoMapOptions } from "./repomap.ts";

export type ProfileName = "standard" | "local";

export interface Profile {
  name: ProfileName;
  guidance: string; // appended to the system prompt after the project map
  instructionsMax: number; // characters of skills + AGENTS.md kept in the system prompt
  repoMap: RepoMapOptions & { hint: boolean }; // hint: the header mentions the repo_map tool
  warnRatio: number; // "context n% full" heads-up
  compactRatio: number; // auto-compact past this fraction of the window
  maxResultChars: number; // one tool result's ceiling, however much room is left
  maskHighWater: number; // characters of old tool output before a masking pass
  dropTools: string[]; // built-in tools left out of the list
  mcpBlanket: boolean; // whether `mcp` in allowedTools grants every MCP tool
  forks: boolean; // spawn_fork offered
  repeatGuard?: { nudge: number; stop: number }; // identical calls before a nudge / before stopping
  textToolCalls: boolean; // read a tool call the model wrote as text instead of through the API
  jsonAsks: boolean; // constrain planner / judge / integrate replies to JSON
}

export const STANDARD: Profile = {
  name: "standard",
  guidance: TOOL_GUIDANCE,
  instructionsMax: Infinity,
  repoMap: { hint: true },
  warnRatio: 0.85,
  compactRatio: 0.95,
  maxResultChars: 60_000,
  maskHighWater: 30_000,
  dropTools: [],
  mcpBlanket: true,
  forks: true,
  textToolCalls: false,
  jsonAsks: false,
};

// Short, imperative, one idea per line: the same conventions as TOOL_GUIDANCE (stay in the project,
// find before reading, read before editing, verify, never weaken a check), in a quarter of the words.
// No batching advice — llama-server runs one call per turn unless asked — and no forks.
export const LOCAL_GUIDANCE = `

Working habits:
- Stay inside the project. Use paths relative to it. Never use '..' or an absolute path unless the user named that path.
- Find before you read: 'grep' finds where something is, 'glob' finds a file by name. Don't guess paths.
- Read a file before you change it. To change part of a file use 'edit', copying oldString exactly from what 'read_file' showed, without the line numbers. Use 'write_file' only for a new file.
- Make one tool call at a time and look at its result before the next.
- After changing code, run the project's tests or checks with 'shell' before you say you are done.
- Never edit, skip or delete a test or a check to make it pass. Fix the code instead.
- When the task is done, answer in one or two plain sentences without a tool call.`;

export const LOCAL: Profile = {
  name: "local",
  guidance: LOCAL_GUIDANCE,
  instructionsMax: 6_000,
  repoMap: { maxFiles: 12, maxChars: 1_500, hint: false },
  // Small models degrade well before their window is full (RULER: most fall off long before the
  // advertised length), and compaction itself needs room to run.
  warnRatio: 0.65,
  compactRatio: 0.75,
  maxResultChars: 16_000,
  maskHighWater: 12_000,
  dropTools: ["list_dir", "repo_map", "hover"],
  mcpBlanket: false,
  forks: false,
  repeatGuard: { nudge: 3, stop: 5 },
  textToolCalls: true,
  jsonAsks: true,
};

// An explicit `profile:` wins. Otherwise the models served on this Mac — niti's own runtime, Ollama,
// LM Studio — get the local profile. A `custom` endpoint stays standard even on a loopback address:
// it is as often a tunnel to a hosted 400B model as a small one, so it says `profile: local` itself.
export function profileFor(cfg: { provider: string; profile?: ProfileName }): Profile {
  if (cfg.profile) return cfg.profile === "local" ? LOCAL : STANDARD;
  return CATALOG[cfg.provider]?.category === "local" ? LOCAL : STANDARD;
}

// Skills and project instructions, cut to the profile's budget with a pointer to the rest. A 30k
// AGENTS.md is a quarter of a cloud model's attention and most of a 16k local window.
export function capInstructions(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  return `${text.slice(0, cut > max * 0.6 ? cut : max)}\n\n[… the project instructions continue in the file named above — read it with read_file when the task needs it]`;
}
