# niti improvement research — Round 1 (standard web search)

**Date:** 2026-10-11 · **niti:** 0.4.7, `main` @ 53df9ba
**Method:** ~22 web searches and ~8 full-page reads (vendor blogs, API docs, arXiv abstracts — many
via secondary summaries), each finding checked against niti's code in `src/agent`, `src/providers`,
`src/orchestrator`.
**Companions:** [Round 2 (Exa)](./2026-10-round2-exa.md) · [Round 3 (Exa, deeper)](./2026-10-round3-exa-deep.md) · [Merged plan](./2026-10-merged.md).

Everything here touches `src/` — the engine both the CLI and the desktop app run.

## Already right in niti (validated by the research)

- Cache-aware observation masking — batched above a high-water mark, so the prompt cache is only
  broken occasionally (`src/agent/context.ts`). Same principle CliffCompaction argues for.
- Verification by running the project's own checks. Huang et al. (ICLR 2024): LLMs cannot reliably
  self-correct reasoning without external feedback; execution feedback is what works.
- Retry an unverified task on a different model; a ranked repo map; stall detection.

## 0. Bug — reasoning is dropped between tool calls

`src/providers/openai.ts:56-80` rebuilds assistant turns from text + tool calls only; it never stores
or sends back `reasoning_content` (or OpenRouter's `reasoning_details`). This provider serves
DeepSeek, Kimi, GLM, Qwen, OpenRouter and OpenAI. `anthropic.ts` and `gemini.ts` already replay
native blocks through `raw`.

- **DeepSeek** docs: with tools, `reasoning_content` "must be fully passed back … If your code does
  not correctly pass back `reasoning_content`, the API will return a 400 error." → `deepseek-reasoner`
  with tools should fail on the second tool round. Not reproduced (no key in this environment).
- **Kimi K2.7-code** docs: every historical assistant `reasoning_content` must be kept as-is.
- **OpenAI**: Chat Completions discards reasoning between turns; OpenAI reports GPT-5 scores ~5%
  higher on TAU-bench through the Responses API purely from preserved reasoning.

**Fix:** capture these into `raw` and replay on assistant turns; later consider the Responses API for
vendor `openai`.

## 1. Cheap, well-supported changes

1. **Eval on cost per solved task, not tokens per pass.** "Token Reduction Is Not Cost Reduction"
   (2,908 Claude Code runs): the most aggressive compression cut tool-output tokens 38.4% and *raised*
   the bill 6.8%; cache writes + reads were ~80% of the bill. `scripts/eval` should price cache
   reads/writes, keep failed runs in the numerator, and report trajectory length.
2. **Compact at an absolute token count, not 95% of the window.** `COMPACT_RATIO = 0.95` means a 1M
   model compacts at ~950K — far past where Chroma's context-rot study (18 models) shows degradation.
   CliffCompaction at 16–32K: Kimi K2.6 on Terminal-Bench 59.2% @ $0.40 → 61.4% @ $0.19–0.24; ~2 points
   lower on SWE-bench at roughly half the cost; LLM summarisation was its weakest method on SWE-bench.
   Try 64K / 128K in the eval.
3. **Planner: don't split sequential work across agents.** Google, "Towards a Science of Scaling
   Agent Systems" (180 configs): multi-agent +81% on parallelisable tasks, −39 to −70% on sequential
   ones; returns vanish once a single agent succeeds ~45% of the time; 3.6–6.2× more turns. (Not coding
   benchmarks.) `planner.ts:174` has no rule — add: a chain of dependent steps goes to one agent.
4. **Cross-family reviewer.** LLM judges favour their own and their family's outputs
   (arXiv 2508.06709). Default `reviewer:` / the lead's final review to a teammate on another provider.
5. **Anthropic 1-hour cache TTL across long waits.** niti uses the 5-minute default; an approval or
   `ask_agent` wait over 5 minutes re-writes the whole context at 1.25×. 1h writes cost 2×, reads 0.1×.

## 2. Bigger features with strong evidence

6. **Parallel attempts across models, best one wins.** niti has the parts (multi-provider, worktrees,
   verification). Summary-based tournament selection: Claude 4.5 Opus SWE-bench Verified 70.9 → 77.6%,
   Terminal-Bench 2 46.9 → 59.1% (arXiv 2604.16529). CliffCompaction: +10.5 points for 1.9× cost with 3
   rollouts. SWE-World: 55.0% → 68.2% at 8 attempts. Plan: N attempts in worktrees → drop failed
   verification → cross-family judge compares structured summaries → merge the winner.
7. **Reproduction test first for bug fixes.** ReProAgent: SWE-bench Verified resolved 317 → 327
   (SWE-agent), 188 → 201 (Agentless). Also resists test gaming (ImpossibleBench; niti's own eval has
   flash-lite editing the check script).
8. **A playbook that learns from runs.** ACE (ICLR 2026): +10.6% on agent benchmarks via itemised,
   incremental updates (rewriting collapses it). ReasoningBank (Google): lessons from successes and
   failures; reported +4.6% SWE-bench Verified and ~3 fewer steps (secondary source). Upgrade
   `remember`/`recall` into `.niti/playbook` distilled from verification outcomes.
9. **Load MCP tool definitions on demand.** Anthropic tool search: −85% tool-definition tokens; Opus 4
   accuracy 49 → 74%.
10. **Reject edits that introduce syntax errors** using the LSP diagnostics delta (SWE-agent's guarded
    edit interface).

## 3. Avoid

- Aggressive compression of tool output — costs more overall and breaks verbatim edit anchors (Go
  study: patches that still applied fell 27 → 15 of 40).
- Trained compressors (SWE-Pruner, Paritok) — need a model niti doesn't have.
- Self-critique loops with no external signal — models change right answers to wrong.
- More agents by default — hybrid topology had 515% overhead in Google's study.
- Prompt injection: no general-purpose agent is fully safe (design-patterns paper). Practical step:
  after an agent reads untrusted (MCP / external) content, require approval for network-capable shell.

## Suggested order (round 1)

Fix #0 → eval on cost per solved task (#1) → #2–#5 each with a before/after eval → #6.

## Sources

- Anthropic — [Advanced tool use](https://anthropic.com/engineering/advanced-tool-use) ·
  [Effective harnesses for long-running agents](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents) ·
  [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) ·
  [Prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- OpenAI — [Harness engineering](https://openai.com/blog/harness-engineering) ·
  [Responses API](https://developers.openai.com/blog/responses-api) ·
  [Compaction](https://developers.openai.com/docs/guides/compaction)
- Google — [Scaling agent systems](https://arxiv.org/html/2512.08296v2) ·
  [ReasoningBank](https://iclr.cc/virtual/2026/poster/10007887) ·
  [LLMs cannot self-correct reasoning yet](https://arxiv.org/pdf/2310.01798)
- DeepSeek — [Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode) ·
  [V3.2 report](https://arxiv.org/pdf/2512.02556) · Kimi — [Thinking models](https://platform.kimi.ai/docs/guide/use-thinking-models)
- [Token Reduction Is Not Cost Reduction](https://arxiv.org/html/2607.12161v5) ·
  [CliffCompaction](https://arxiv.org/html/2609.26779) · [SWE-Pruner](https://arxiv.org/pdf/2601.16746) ·
  [AttnCompress](https://arxiv.org/pdf/2609.08318) · [Context as a Tool](https://arxiv.org/pdf/2512.22087) ·
  [Chroma — Context rot](https://trychroma.com/research/context-rot)
- [Scaling test-time compute for agentic coding](https://arxiv.org/abs/2604.16529) ·
  [SWE-World](https://arxiv.org/pdf/2602.03419) · [SWE-RM](https://arxiv.org/pdf/2512.21919) ·
  [ACE](https://huggingface.co/papers/2510.04618) · [MAST](https://arxiv.org/html/2503.13657v3) ·
  [ImpossibleBench](https://arxiv.org/abs/2510.20270) · [ReProAgent](https://arxiv.org/html/2607.09123) ·
  [Agentless](https://arxiv.org/html/2407.01489v2) · [Self-preference bias](https://arxiv.org/abs/2508.06709v1) ·
  [Prompt-injection design patterns](https://arxiv.org/pdf/2506.08837) ·
  [Cluster, Route, Escalate](https://arxiv.org/html/2606.27457) · [RLM-Cascade](https://arxiv.org/html/2606.22840v1) ·
  [Sleep-time compute](https://www.prompthub.us/blog/sleep-time-compute)
