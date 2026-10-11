# niti improvement research — Round 3 (Exa, deeper pass) and comparison with Rounds 1–2

**Date:** 2026-10-11 · **niti:** 0.4.7, `main` @ 53df9ba
**Method:** 33 Exa `web_search_exa` queries, aimed at what rounds 1–2 did not cover: vendor docs and
model reports (Anthropic, OpenAI, Google, DeepSeek, Moonshot, MiniMax, Meta), 2026 papers on edit
formats, trajectory reduction, routing, tool-output compression, LSP vs grep, skills and security.
Every finding was checked against the code; file:line references are to `main` @ 53df9ba.
**Companions:** [Round 1](./2026-10-round1-web-search.md) · [Round 2](./2026-10-round2-exa.md) ·
[Merged plan (all three rounds)](./2026-10-merged.md).
**Caveat:** as before, most sources are 2026 preprints, vendor posts or tool READMEs with
self-reported numbers on benchmarks that differ from each other. The tool-output compressors in
§R3-4 are open-source READMEs, not papers. Nothing here should ship without a `scripts/eval` run.

## Result of the comparison

| | Count |
|---|---|
| Round 1–2 ideas strengthened by round 3 | 7 |
| Refined (same idea, different way to build it) | 4 |
| New ideas only round 3 surfaced | 6 |
| Things niti already does that round 3 validates | 7 |

The biggest changes: round 1's reasoning bug has a second half (§R3-0); round 1's "avoid compressing
tool output" splits into "never compress file reads" and "filtering test and build logs is fine"
(§R3-4); round 2's "edit guard per model" becomes "edit format per model" (§R3-7); routing inside a
single task (§N10) is the strongest new cost lever.

## Round 3 against Rounds 1–2, idea by idea

### R3-0 Reasoning dropped between tool calls — **strengthened, and a second half found**
- R1: `src/providers/openai.ts:56-80` never sends `reasoning_content` / `reasoning_details` back.
  Still true at 53df9ba.
- R3 evidence: MiniMax's ablation of keeping vs dropping prior reasoning (M2 report + blog):
  SWE-bench Verified 69.4 vs 67.2, τ²-bench 87 vs 64, BrowseComp 44.0 vs 31.4, GAIA 75.7 vs 67.9.
  The M2 report says the most common cause is that "the OpenAI Chat Completion API does not support
  passing reasoning content back".
- **New half:** DeepSeek V3.2's rule is that reasoning is "discarded only when a new user message is
  introduced". The report warns that frameworks which "simulate tool interactions via user messages"
  lose the benefit. niti adds mid-task **user** turns all the time: verification failures
  (`agent.ts:560`), stall nudges (`:598`), inbox (`:846`), notes board (`:868`) and the todo
  checklist (`:883`). Anthropic merges consecutive user messages, so Claude is unaffected. On the
  OpenAI-compatible path, each of these is a new user message, so DeepSeek-style templates wipe the
  reasoning, even after the replay bug is fixed.
- **niti:** (a) store `reasoning_content` / `reasoning_details` in `raw` and replay them; (b) in
  `openai.ts`, when a harness-injected user turn directly follows tool results, append its text to
  the last `tool` message instead of sending a separate `user` message. Gemini is already correct:
  `gemini.ts:36-40` replays raw parts, and Gemini 3 needs that, since it rejects function calls that
  are missing their `thoughtSignature` with a 400.

### R3-1 Eval on cost per solved task — **strengthened**
- Paritok cost study (real Claude Code / Codex sessions): "turn count, not compression rate, sets the
  bill". A strong single-shot compression benchmark "must not be cited as a cost-saving argument".
- Anthropic published a separate post on infrastructure noise in agentic coding evals, the same
  warning as round 2's N2.
- **niti:** unchanged from R2. Add **turns per solved task** and, for multi-agent runs, **critical
  steps** (Kimi's metric: main-agent steps plus the slowest sub-agent per parallel stage).

### R3-2 Longer cache lifetimes — **strengthened, extended to OpenAI**
- R1/R2: Anthropic `ttl: "1h"`. `anthropic.ts:5` still sends a bare `{type: "ephemeral"}` (5 min).
- R3: OpenAI `prompt_cache_retention: "24h"` exists for gpt-5 / 5.1 / 5.2 / 5.4 / 5.5 / gpt-4.1. It
  is the default for non-ZDR orgs on models that support it, and the only option on 5.5. GPT-5.6+
  switch to *explicit* breakpoints with 1.25× cache writes and a 30-minute TTL set through
  `prompt_cache_options.ttl`, so that path will need breakpoints like `anthropic.ts`. niti sends
  `prompt_cache_key` already (`openai.ts:95`).
- **Found while checking:** the OpenAI catalog entry lists only `gpt-4o`, `gpt-4o-mini`, `o3-mini`,
  `o1` (`catalog.ts:112-116`). None of those support extended retention, and they're two
  generations old.

### R3-3 Compaction and observation masking — **strengthened (niti's design validated again)**
- JetBrains, *The Complexity Trap* (SWE-agent + OpenHands, 5 model configs): observation masking
  halves cost vs. no management and matches LLM summarisation on solve rate. Summary calls were up to
  7.2% of cost and cache poorly. A masking-then-summary hybrid cut another 7% / 11%.
- DeepSeek V3.2 (BrowseComp, triggered at 80% of the window): "Discard-all" (drop all tool history)
  scored 67.6 vs 60.2 for Summary, with far fewer steps.
- Anthropic (Mar 2026): Opus 4.5 "largely removed" context anxiety, so their harness dropped
  context resets and relies on plain compaction.
- AgentDiet (FSE 2026): a cheap model rewrites **one** step, two steps back, and only when it is over
  500 tokens. Result: −40–60% input tokens, −21–36% total cost, same solve rate. Because only one
  recent step changes, the cache before it survives.
- DTOC (DeepSWE): *reversible* hiding of tool outputs beat disable-only, but results depend on the
  model (better on Sonnet 4.6 / GPT-5.4; more tokens on Opus 4.8 / Gemini 3.5 Flash; single runs).
- **niti:** batched masking (`context.ts:171-204`) plus a summary at the window limit is the
  configuration this evidence favours. The threshold (`COMPACT_RATIO = 0.95`, `agent.ts:50`) stays a
  cost experiment. AgentDiet-style single-step reduction is a later experiment (§Merged T3).

### R3-4 "Avoid compressing tool output" — **refined: split by output type**
- R1: aggressive compression raised the bill 6.8% and broke edit anchors.
- R3 agrees for **file reads**. Paritok: reading compressed files makes the agent fetch the original
  bytes again to edit, and per-turn savings are about 2%.
- R3 points the other way for **command output**. Rule-based filters for test runners, builds,
  linters and installs (trs, cartoon, RTK, aibrain-compress; READMEs, not papers) report 55–99% cuts
  on test runs by keeping failures, `file:line`, error text and the summary line, while keeping the
  raw log on disk. AgentDiet's own example of waste is exactly this: 1,714 of 1,995 tokens were
  passing-test lines.
- **niti:** shell output is only middle-truncated at 60K chars (`context.ts:118,139`). Add a small
  filter for known runners (pytest / jest / vitest / go test / cargo / tsc / eslint) that keeps
  failures + summary, writes the full log under `.niti/` and prints the path. Never apply it to
  `read_file` or `grep`.

### R3-5 Load tools on demand — **round 2's verdict holds**
- Paritok: tool-schema filtering was the only lever that was reproducibly positive, removing
  21K–57K tokens per turn. That's because Claude Code's schema set is large.
- Anthropic: `defer_loading` keeps deferred tools out of the cached prefix entirely, so it doesn't
  break the cache.
- **niti:** the built-in toolset is small (`tools.ts:777-855`), so this matters only for users with
  many MCP servers. Use provider-native deferral, never client-side swapping (R2).

### R3-6 Multi-agent topology — **strengthened, with one more metric**
- Kimi K2.5 Agent Swarm: BrowseComp 60.6 → 78.4, WideSearch item-F1 72.7 → 79.0, 3–4.5× faster.
  These are wide-search tasks, not coding.
- The two failure modes Kimi trains against also appear in prompted harnesses: **serial collapse**
  (the orchestrator stops delegating) and **spurious parallelism** (spawning sub-agents that don't
  shorten the critical path).
- Subagents vs Skills (2026): running a reusable procedure as a sub-agent beats loading it into the
  main context only when it has a clear input/output contract.
- **niti:** keep R2's planner rule. Report critical steps, not total steps, in `/stats`.

### R3-7 Edit syntax guard → **edit format per model — refined**
- R1: guarded edit interface. R2: per model tier.
- R3: format choice is as big a lever as model choice.
  - *Hashline* (16 models, 180 tasks × 3 runs): `read` tags each line with a 2-char content hash;
    edits reference `line:hash` instead of reproducing text. It beat patch on 14 of 16 models and
    matched or beat `str_replace` on most. Grok Code Fast 1 went 6.7% → 68.3%, and Grok 4 Fast used
    61% fewer output tokens. Stale reads are rejected rather than mis-applied.
  - *Format × Model* (4,013 runs): there is no universal format. Doubao: 94% JSON Patch vs 27% full
    file. DeepSeek V4: 66% unified diff vs 35% full file.
  - *Diff-XYZ* (JetBrains): search/replace is best for generation on large models.
  - *To Diff or Not to Diff* (ACL 2026): line numbers in diffs hurt, and edits shaped as whole
    functions or blocks work best.
  - Codex-style `apply_patch` failed 46–51% on non-OpenAI models.
- **niti:** `edit` is `str_replace` with recovery: it strips pasted line numbers (`tools.ts:469-525`)
  and hints at the nearest lines on a miss (`:592`). `read_file` already prints line numbers
  (`:238`), so hashline is one step away. Add a hashline edit mode, enabled per model tier through
  `steering.ts`, and let the eval decide. Keep `str_replace` as the default for Claude / GPT. Never
  give `apply_patch` to non-OpenAI models.

### R3-8 Learning playbook — **strengthened caveat**
- SkillsBench (7,308 trajectories): curated skills +16.2 pp; **self-generated skills −1.3 pp**;
  focused skills beat comprehensive ones (comprehensive: −2.9 pp). Software engineering was the
  domain with the smallest gain (+4.5 pp).
- **niti:** round 2's "lessons only from verified outcomes" is now essential, not optional. Also
  keep entries short. Skills are already loaded progressively: descriptions in the prompt, body on
  demand (`skills/skills.ts:5`).

### R3-9 Repo map / code search — **refined**
- LSP vs grep (Claude Opus 4.8 / Sonnet 4.6 / Haiku 4.5): LSP *costs* tokens on symbol lookup
  (+6% / +118%). It saves tokens only for the weakest model (−26%). LSP references without the
  source line force follow-up reads (15.2 → 3.2 reads per episode once lines are inline). Grep was
  better for multi-file renames, because comments and strings matter.
- 936-run grep vs graph vs LSP study (superset, 400K LOC): tie on simple lookups. On blast-radius and
  disambiguation tasks grep fell to 0.71 accuracy, 17% of runs never finished, and the rest cost
  6–24× more.
- **niti:** `diagnostics` / `hover` exist (`lsp-tools.ts`). If references are added, return each
  hit's line inline. Keep grep the default. The repo-map A/B from round 2 stands.

### R3-10 Prompt injection — **strengthened, with one concrete gap**
- Meta's *Rule of Two*: in one session, allow at most two of (untrusted input, private data,
  external communication / state change) without human approval.
- *Can CaMeLs Talk?* (Oct 2026): per-agent defences don't compose. Untrusted data seen by one agent
  "launders" into a trusted instruction for the next. Attack success: 12.9% with no defence, 0.2%
  with per-agent CaMeL, 0.0% with provenance carried across agents. Full CaMeL cost 21.6 points of
  utility on average.
- **niti:** peer messages and the notes board are already framed as data (`agent.ts:822-868`). The
  gap is delegation: a lead that read a poisoned README writes the teammate's *task*, which arrives
  as trusted. Fix: carry an "untrusted content read" flag from the lead into tasks it creates, so the
  teammate keeps the stricter egress approval (R1's rule) without full CaMeL.

### R3-11 Per-step reasoning effort — **strengthened**
- *The Danger of Overthinking* (4,018 SWE-bench trajectories): o1-high scored 29.1% for $1,400 vs
  o1-low 21.0% for $400. Choosing the attempt with the lowest overthinking score gave about +30%
  resolved at −43% cost. Reasoning models overthink about 3× more than non-reasoning models.
- **niti:** supports R2 N4. "Shortest / least-deliberating passing attempt" is also a cheap
  tie-breaker for the attempts feature (Merged T2).

## New in round 3 only

- **N10 Scout, then fix (routing inside a task) — strongest new lever.**
  - *Scrouting* (SWE-bench Pro, 266 tasks): a 7B scout explores the repo and writes a handoff whose
    reproduction claims are verified in a sandbox. That matched the best single model (159 vs 158
    solved) at about **1/5 of the cost per solve**. The ablation that matters: "always the cheapest
    fixer, with the handoff" tied the routed system, so the handoff carried the result, not the
    router.
  - *SWE-Router*: let a cheap model run 3 turns, then decide whether to escalate. Route-AUC improved
    by 12–15 points over prompt-only routing.
  - niti already has the parts: multi-provider, planner, teammates, verification, retry-on-another
    -model. A cheap teammate does localization plus a failing reproduction test, and a strong
    teammate (or the cheap one, then escalation) does the fix. This joins up R1 #7 (reproduction
    test) and R2 #7 (reproduction as a verified deliverable).
- **N11 Budget awareness.** Google BATS / Budget Tracker (COLM 2026): appending remaining budget each
  turn beat larger budgets without awareness. Search agents, not coding. niti has `MAX_TURNS = 30`
  and a context warning at 85%. Add "turn N of 30, $X spent" to the todo block, which is already
  re-sent each turn, so the cache cost stays unchanged.
- **N12 Command-output filter** (§R3-4).
- **N13 Hashline edit mode** (§R3-7).
- **N14 Taint across delegation** (§R3-10).
- **N15 Encourage batched independent reads.** W&D (Salesforce, Feb 2026): about 3 tool calls per
  turn was optimal, and GPT-5-medium with parallel calls beat GPT-5-high on BrowseComp
  (62.2 vs 54.9). niti already *executes* read-only batches concurrently (`agent.ts:1069`). What's
  missing is steering that asks for batches, plus counting turns in the eval.

## Considered and not recommended

- **Recursive Language Models** (prompt as a REPL variable): the paper itself finds that coding
  agents with a shell already behave like its depth-0 variant. That's niti today.
- **Live-SWE-agent / DGM** (agents writing their own tools or scaffold): niti agents can already
  write scripts. Self-modifying the harness conflicts with the eval-gated workflow.
- **Provider-side compaction** (OpenAI `/responses/compact`, Anthropic `clear_tool_uses`): opaque
  (OpenAI's is encrypted), tied to one vendor, and niti's client-side masking already does the same
  job on all 29 providers.
- **Programmatic tool calling / code-execution MCP** (Anthropic: −37% tokens on research tasks,
  98.7% on one large-data MCP flow): only pays with many MCP tools and big intermediate data. Later,
  for MCP-heavy users.
- **Full CaMeL**: −21.6 points of utility. The taint flag (N14) gets the multi-agent part cheaply.

## Already right in niti (validated by round 3)

- Read-only tool batches run concurrently (`agent.ts:1069`). Matches LLMCompiler / W&D.
- Skills are loaded progressively (`skills/skills.ts`). Matches SkillsBench and Anthropic.
- Short shared tool guidance (~1.6 KB) plus per-family steering (`steering.ts`). IFScale and AgentIF
  show instruction-following degrades with prompt length and constraint count.
- Peer messages and notes are framed as data, not instructions. The notes board is append-only for
  the cache. Matches Manus and Rule of Two.
- Gemini thought signatures are replayed (`gemini.ts:36-40`).
- Masking first, summary at the limit (`context.ts`). Matches the Complexity Trap and DeepSeek V3.2.
- Failed actions stay in context; verification failures go back to the model. Matches Manus's "keep
  the wrong stuff in".

## Sources (round 3)

- Reasoning & caching: [MiniMax — interleaved thinking](https://www.minimax.io/news/why-is-interleaved-thinking-important-for-m2) ·
  [MiniMax-M2 report](https://arxiv.org/html/2605.26494v2) · [DeepSeek-V3.2 report](https://arxiv.org/html/2512.02556v1) ·
  [Gemini thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures) ·
  [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) ·
  [OpenAI Prompt Caching 201](https://developers.openai.com/cookbook/examples/prompt_caching_201) ·
  [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction)
- Context management: [The Complexity Trap](https://arxiv.org/abs/2508.21433) ·
  [AgentDiet / trajectory reduction](https://dl.acm.org/doi/10.1145/3797084) · [DTOC](https://arxiv.org/abs/2609.26121) ·
  [Paritok cost attribution](https://arxiv.org/pdf/2609.22114) · [SUPO](https://aclanthology.org/2026.acl-long.966.pdf) ·
  [Anthropic context editing](https://docs.anthropic.com/en/docs/build-with-claude/context-editing) ·
  [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) ·
  [Manus context engineering](https://manus.im/en/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) ·
  [Recursive Language Models](https://arxiv.org/abs/2512.24601)
- Edit formats: [The harness problem (hashline)](https://stencil.so/blog/the-harness-problem) ·
  [Output Format × Model Identity](https://arxiv.org/html/2607.21674) · [To Diff or Not to Diff](https://arxiv.org/html/2604.27296v1) ·
  [Diff-XYZ](https://arxiv.org/html/2510.12487v1) · [Diffs vs whole files (Dart)](https://arxiv.org/abs/2609.05779) ·
  [Aider unified diffs](https://aider.chat/docs/unified-diffs.html)
- Routing & budgets: [Scrouting / SuperScout](https://arxiv.org/abs/2608.04804) · [SWE-Router](https://arxiv.org/html/2607.00053) ·
  [Agent-as-a-Router](https://arxiv.org/html/2606.22902v2) · [Budget-aware tool use (BATS)](https://arxiv.org/abs/2511.17006) ·
  [The Danger of Overthinking](https://arxiv.org/abs/2502.08235)
- Tools & navigation: [Anthropic advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) ·
  [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) ·
  [LSP vs grep token study](https://arxiv.org/html/2608.13568) · [grep vs graph vs LSP, 936 runs](https://dev.to/neko1313_4/how-much-does-context-cost-an-ai-coding-agent-grep-vs-graph-vs-lsp-measured-across-936-runs-33m8) ·
  [W&D parallel tool calling](https://arxiv.org/abs/2602.07359) · [PASTE](https://arxiv.org/html/2603.18897) ·
  command-output filters: [trs](https://github.com/dPeluChe/trs) · [cartoon](https://github.com/abhijitbansal/cartoon) ·
  [aibrain-compress](https://pypi.org/project/aibrain-compress/)
- Multi-agent, skills, harness: [Kimi K2.5 / Agent Swarm](https://arxiv.org/html/2602.02276) ·
  [Subagents vs Agent Skills](https://arxiv.org/abs/2609.09233) · [SkillsBench](https://arxiv.org/abs/2602.12670v1) ·
  [Anthropic — harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps) ·
  [Anthropic — Managed Agents](https://www.anthropic.com/engineering/managed-agents) ·
  [Live-SWE-agent](https://arxiv.org/html/2511.13646v2) · [Darwin Gödel Machine](https://proceedings.iclr.cc/paper_files/paper/2026/file/aa5f5e6eb6f613ec412f1d948dfa21a5-Paper-Conference.pdf)
- Instructions & security: [IFScale](https://arxiv.org/html/2507.11538v1) · [AgentIF](https://arxiv.org/abs/2505.16944) ·
  [Meta — Agents Rule of Two](https://ai.meta.com/blog/practical-ai-agent-security/) · [CaMeL](https://arxiv.org/html/2503.18813v2) ·
  [Can CaMeLs Talk? (multi-agent)](https://arxiv.org/html/2610.05640)
