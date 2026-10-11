# niti improvement research — Round 2 (Exa deep research) and comparison with Round 1

**Date:** 2026-10-11 · **niti:** 0.4.7, `main` @ 53df9ba
**Method:** 33 searches via Exa `web_search_exa` and 12 full-text reads via `web_fetch_exa` (called
over Exa's HTTP MCP endpoint), mostly primary arXiv / ACL / ACM papers from 2026. About 25 sources
round 1 never saw. Each finding checked against niti's code.
**Companions:** [Round 1 (standard web search)](./2026-10-round1-web-search.md) · [Round 3 (Exa, deeper)](./2026-10-round3-exa-deep.md) · [Merged plan](./2026-10-merged.md).
**Caveat:** most 2026 sources are preprints with self-reported numbers on different benchmarks
(SWE-bench, Terminal-Bench, LiveCodeBench) — confirm every change with niti's own eval.

## Result of the comparison

| | Count |
|---|---|
| Round-1 ideas confirmed or strengthened | 5 |
| Held, but the evidence changes how to build them | 4 |
| Weakened or moved down | 2 |
| New findings only round 2 surfaced | 9 |

The round-1 bug (reasoning dropped in `openai.ts`) stands; GLM-5's "preserved thinking" mode is a
further case. Three things change: a blanket "use another model family to review" is wrong; the repo
map in every prompt was underrated as a cost question; client-side lazy tool loading conflicts with
prompt caching, which niti already protects on purpose.

## Round 1 vs Round 2, idea by idea

### 01 Eval on cost per solved task — **strengthened**
- R1: compression −38.4% tokens → +6.8% bill; cache ≈ 80% of the bill.
- R2: single-run pass@1 varies 2.2–6.0 points even at temperature 0 (runs diverge in the first 1% of
  tokens); detecting a 2% gain at 80% power needs 9 runs per agent, 15 for 95%. Harness choice alone
  moved tokens per solved task up to 40× while pass rates moved 0–8 points.
- **niti:** `scripts/eval` → cache-priced dollars per solved task, trajectory length, paired runs with
  confidence intervals. `--repeat 3` only detects large effects.

### 02 Anthropic 1-hour cache TTL — **strengthened**
- R1: 1h write 2× / read 0.1×; 5-minute default re-buys context after waits.
- R2: six-harness study — TTL alone decides whether a session resumes at 10% of list price or re-buys
  its whole context after each human pause; $205–290 per seat per month; the one harness with 1h
  markers by default was cheapest at every session length. Separate study: caching cut agent cost
  41–80%; caching at the system-prompt boundary was most consistent. Per-turn injected scaffolding cost
  2.3× the payload in one harness.
- **niti:** `ttl: "1h"` on the system/tools breakpoint in `anthropic.ts`; audit the per-turn inbox /
  notes / todo injections.

### 03 One agent for dependent steps — **strengthened**
- R1: Google, 180 configs — +81% parallel, −39 to −70% sequential (non-coding benchmarks).
- R2: coding-specific — a single agent beat a fixed multi-agent pipeline on every task family incl.
  bug fixing and multi-file coding, cheaper and faster (ECER 2026). Counterpoint: OpenCollab Duo
  +3.4 Terminal-Bench 2.1, +14.2 DeepSWE. Topology matters a lot: one dimension moved actual
  collaboration 47% → 97%; team layout shifted scores >30 points (MSEval).
- **niti:** planner rule in `planner.ts` (dependent chain → one agent; split only independent work on
  separate files) + log planned vs actual hand-offs (leads were seen taking over the budget).

### 04 Several attempts, best one wins — **confirmed**
- R1: 70.9 → 77.6% SWE-bench Verified; 46.9 → 59.1% Terminal-Bench 2; SWE-World 55 → 68.2% @8.
- R2: AI21 — sequential attempts with early stopping cut compute up to 44% at about the same quality;
  self-confidence picking clearly worse than an LLM judge. Bayesian control helps most when
  verification is expensive.
- **niti:** first turn retry-on-another-model into a sequence that stops at the first verified result;
  then opt-in parallel attempts in worktrees (verification filter, then judge).

### 05 Learning playbook — **confirmed, with a security caveat**
- R1: ACE +10.6%; ReasoningBank ~3 fewer steps.
- R2: SWE-Exp 73.0% pass@1 SWE-bench Verified; Exp-SWE-Agent 42.7 → 47.5% on sequential SWE-bench Pro
  with fewer steps; per-task memory mis-retrieves — store per step; Cisco showed Claude Code memory
  poisoning that persisted across every project.
- **niti:** only lessons backed by a verification result; per project; user-visible and editable;
  never auto-loaded across projects.

### 06 Cross-family reviewer — **refined**
- R1: self-preference bias → default to another provider.
- R2: direction matters. Opus 4.7 reviewing GPT-5.5 drafts: 71.6 → 89.7%. GPT-5.5 reviewing Opus
  drafts: 91.4 → 82.8% (harmful reviews rewrite working code). Fresh-session same-model review ≈
  cross-model on F1, but they catch different errors (41% overlap); one fresh same-model + one
  cross-model beat two same-model reviews (56.7% vs 42.7%).
- **niti:** reviewer at least as strong as the author, or the same model in a fresh session; on work
  that already passed verification the reviewer comments, it doesn't rewrite. (Those studies'
  reviewers couldn't run tests; niti's can.)

### 07 Reproduction test first — **refined**
- R1: ReProAgent +10 / +13 resolved.
- R2: 21,120-trajectory plan-compliance study — a bad or incomplete plan hurts more than none; agents
  often write poor reproduction tests when told to; extra plan phases help only when they match the
  model's own workflow. Google: writing the test together with the fix doesn't lower the fix rate.
- **niti:** make it a deliverable verification checks (fails before, passes after), not a mandated
  first step in the prompt.

### 08 Syntax guard on edit — **refined**
- R2: SWE-agent's full interface beat a plain shell by 10.7 points; the 176-setting harness study
  found structured tools help models weak at bash, while capable models do better and cheaper with
  bash alone.
- **niti:** per model (weaker / cheaper teammates), not global.

### 09 Absolute compaction threshold — **moved down**
- R1: CliffCompaction 16–32K ≥ full context at ~half cost.
- R2: harness study (176 settings) — context management helps mainly by preventing overflow; with large
  windows, elaborate compaction barely moved accuracy; best efficiency = rule-based trimming then
  selective LLM summary, which is what niti already does. Compression also increased repeated
  exploration and run-to-run instability (TRACE).
- **niti:** design validated; a lower threshold is a cost experiment, not a quality fix.

### 10 Load MCP tools on demand — **weakened**
- R1: tool search −85% tool tokens, Opus 4 49 → 74%.
- R2: OpenAI Codex lists changing tools mid-conversation as a cache miss (and shipped an MCP
  tool-order cache bug); a Claude Code issue shows tool-search batches discarding the whole cache.
  niti already keeps its tool list stable for this reason (`buildTools` in `agent.ts`).
- **niti:** only provider-native deferral (Anthropic `defer_loading`), only for users with many MCP
  tools; never client-side swapping.

### 11 Prompt injection — **strengthened**
- R2: Cloud Security Alliance confirmed README / AGENTS.md injection across every major coding agent
  tested; directory names and source comments carry attacks too; how the user phrases a request
  changes exposure to a poisoned repository.
- **niti:** label repo-sourced text reaching the prompt (skill descriptions, notes, repo map) as data,
  not instructions; keep sandbox network rules strict after reading outside content.

## New in round 2 only

- **N1 Repo map in every prompt — highest-value experiment.** ETH Zurich (4 agents): repository
  overviews in context files don't help and raise cost >20% with more steps. A second controlled
  study: context strategy didn't measurably change correctness — agents failed on implementation
  skill, not missing repo knowledge. Counterpoint: AGENTS.md cut runtime 28.6% and output tokens
  16.6% in another study. niti injects a ranked map (`src/agent/repomap.ts`) and has `repoMap: false`
  → A/B it on cost per solved task; if it doesn't pay, keep only the `repo_map` tool.
- **N2 Eval noise.** 60,000 SWE-bench trajectories: 2–3-point gains are often noise; 9 runs to detect
  2%. Paired runs, more repeats for close calls, confidence intervals.
- **N3 Harness settings per model tier.** Planning keeps weaker models from quitting early (costs
  more) and mostly trims redundant verification for strong ones; tools vs bash-only is
  model-dependent; each harness has failure patterns that repeat across models.
- **N4 Per-step reasoning effort.** Ares (per-step effort) beat fixed levels; Claude adaptive thinking
  and OpenAI effort levels support it. Check first whether changing thinking settings breaks the
  provider's message cache.
- **N5 Semantic search alongside grep.** Semantic search matched or beat delegated grep-search on repo
  QA for all 4 models at far fewer tokens (~34K vs ~761K input per question on Qwen3-235B); Cursor
  reports it clearly helps on large codebases. Start with the lead's read-only "question" path.
- **N6 Run read-only tools while streaming.** PASTE cut task time 43.5% with speculative tools. Simple
  version: start `read_file` / `grep` / `glob` / `list_dir` as soon as their arguments finish
  streaming.
- **N7 Approval fatigue.** Users chose "ask" for 114 of 140 rules; 133 of 148 overreach actions ran
  after a human approved. Approve the plan, then ask only about destructive or out-of-project actions.
- **N8 Plan adherence.** OpenCollab's adherence metric (planned vs actual team layout); at low
  adherence leads took over. Report planned vs actual hand-offs in `/stats` and the summary card.
- **N9 Already backed by research — keep:** stall detection (futile-cycle detection F1 0.72);
  mechanical trimming + stall handling (fail-to-pass fraction 28% → 49% under a 20K window);
  cache-stable tool list; verification by running the project's checks.

## Revised order of work

1. Send reasoning back in the OpenAI-compatible provider — small, bug.
2. Eval: dollars per solved task, paired repeats, confidence intervals — small.
3. 1-hour Anthropic cache TTL + audit of per-turn injected text — small.
4. Repo map on/off in the eval — small, experiment.
5. Planner: one agent for dependent steps + hand-off logging — small–medium.
6. Review policy: stronger or fresh-session reviewer, comment-only on verified work — small.
7. Sequential attempts with early stop, then opt-in parallel attempts in worktrees — medium–large.
8. Reproduction test as a verified deliverable — medium.
9. Playbook from verified runs only, poisoning-safe — medium.
10. Later, each behind an eval run: per-tier harness settings, per-step effort, semantic search for
    questions, early read-only tool execution, provider-native MCP deferral, edit syntax guard, lower
    compaction threshold.

## Sources (round 2)

- Harness: [Empirical study of harness design](https://arxiv.org/abs/2609.20804) ·
  [Same model, different harness](https://arxiv.org/abs/2608.26218) ·
  [Scaffold effect](https://arxiv.org/html/2607.22585) · [SWE-agent ACI](https://arxiv.org/html/2405.15793v3)
- Context files: [Evaluating AGENTS.md (ETH)](https://arxiv.org/abs/2602.11988) ·
  [Do context files help?](https://arxiv.org/abs/2607.27250) · [AGENTS.md efficiency](https://arxiv.org/abs/2601.20404)
- Review: [Cross-model LLM code review](https://arxiv.org/html/2607.21656v1) ·
  [When does a second model help?](https://arxiv.org/html/2610.01471)
- Caching: [Cache efficiency in six harnesses](https://agnt.gg/whitepapers/the-cache-wars-prompt-cache-efficiency-llm-agent-harnesses) ·
  [Prompt caching for long-horizon agents](https://arxiv.org/html/2601.06007v2) ·
  [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/) ·
  [Tool-search cache issue](https://claudeissues.com/issue/83756-bug-large-mcp-toolsearch-batches-invalidate-the-whole-conversation-cache-contrad) ·
  [Anthropic tool use with caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching)
- Multi-agent: [Single vs multi-agent (ECER 2026)](https://ecer.eraa.at/archive/ecer-2026/papers/When_Do_Multi-Agent_LLM_Systems_Outperform_Single-Agent_Approaches_An_Empirical_Comparison_Across_Different_Task_Types.pdf) ·
  [OpenCollab](https://arxiv.org/html/2609.38345) · [MSEval](https://arxiv.org/abs/2607.27877)
- Evaluation: [Variance in agentic evals](https://arxiv.org/pdf/2602.07150) ·
  [Reliability science for long-horizon agents](https://arxiv.org/html/2603.29231)
- Test-time scaling: [AI21 budget-aware best-of-N](https://www.ai21.com/blog/improving-best-of-n-with-budget-aware-execution-for-swe-agents/) ·
  [Bayesian control](https://arxiv.org/html/2606.24453) · [Agentic aggregation](http://arxiv.org/abs/2604.11753)
- Planning / tests: [Plan compliance (21k trajectories)](https://arxiv.org/html/2604.12147v3) ·
  [Cogeneration of bug reproduction tests](https://arxiv.org/html/2601.19066v3) ·
  [Agentic bug reproduction at Google](https://arxiv.org/html/2502.01821v2)
- Memory: [SWE-Exp](https://arxiv.org/pdf/2507.23361) · [Exp-SWE-Agent](https://dl.acm.org/doi/pdf/10.1145/3803437.3807663) ·
  [Memory granularity](https://arxiv.org/pdf/2602.21611) ·
  [Cisco memory compromise](https://blogs.cisco.com/ai/identifying-and-remediating-a-persistent-memory-compromise-in-claude-code)
- Security: [CSA README injection](https://labs.cloudsecurityalliance.org/wp-content/uploads/2026/03/CSA_research_note_readme_instruction_injection_ai_coding_agents_20260317-csa-styled.pdf) ·
  [Workspace topology attacks](https://arxiv.org/html/2608.14876v1) · [User invocation & poisoning](https://arxiv.org/abs/2608.30686) ·
  [Permission policies](https://arxiv.org/html/2608.27443)
- Other: [Ares adaptive effort](https://arxiv.org/html/2603.07915v1) ·
  [Semantic vs deep agentic search](https://arxiv.org/abs/2608.01507) · [Cursor semantic search](https://cursor.com/blog/semsearch) ·
  [PASTE](https://arxiv.org/html/2603.18897v3) · [Futile cycle detection](https://dlnext.acm.org/doi/10.1145/3774748.3795682) ·
  [GLM preserved thinking](https://substack.ayaz.pk/p/some-thoughts-on-interleaved-and)
