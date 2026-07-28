# amux

A terminal CLI that runs **multiple AI coding agents from different LLM providers concurrently** on one project — each with a role, coordinating on a shared task queue, shown live in a color-coded terminal UI with 8-bit avatars.

Bring your own keys (Anthropic, OpenAI, Gemini). Keys live in your OS keychain, never a server.

```
╭─────────────────────────────────────╮ ╭─────────────────────────────────────╮
│◆ architect · Architect              │ │▲ engineer · Backend Engineer        │
│thought: decomposing: build a todo…  │ │tool_call: claimed t2: write tests   │
│thought: queued t1: add /health route│ │message: added tests/health_test.ts  │
│tool_call: claimed t1: add /health…  │ │done:                                │
╰─────────────────────────────────────╯ ╰─────────────────────────────────────╯
╭──────────────────────────────────────────────────────────────────────────────╮
│Tasks                                                                           │
│t1 [done] architect: add /health route                                          │
│t2 [done] engineer: write tests                                                 │
╰──────────────────────────────────────────────────────────────────────────────╯
```

## Quickstart

Requires [Bun](https://bun.sh) ≥ 1.3.

```sh
bun install
bun run src/cli.ts keys set anthropic     # stored in your OS keychain
bun run src/cli.ts keys set deepseek      # any provider: openai, google, groq, openrouter, moonshot, xai, …
bun run src/cli.ts login copilot          # or sign in with a GitHub Copilot subscription (no API key)

bun run src/cli.ts                        # interactive session — type a task, watch, repeat
                                          #   type /model to switch a provider/model (opencode-style)
bun run src/cli.ts "Add a health check endpoint and a test for it."   # one-shot
```

### Three ways to supply models (`/model` selector)

1. **API key (BYOK)** — Anthropic, OpenAI, Google, DeepSeek, Groq, OpenRouter, Moonshot/Kimi, xAI, Mistral, Together, Fireworks, Cerebras, plus **Custom (OpenAI-compatible)** — pick "Custom", enter any base URL, and reach any of the 75+ OpenAI-compatible providers. `amux keys set <provider>` (OS keychain) or the matching env var.
2. **Local (offline, no key)** — Ollama (`:11434`) and LM Studio (`:1234`), routed at their local OpenAI-compatible endpoints. Nothing leaves your machine.
3. **Sign in (subscription)** — **GitHub Copilot** via OAuth: `amux login copilot` runs GitHub's device flow (open the URL, enter the code); the token is stored in your keychain and refreshed automatically. Then pick GitHub Copilot in `/model`.

Under the hood: Anthropic and Google use native clients; Copilot wraps the OpenAI client with a self-refreshing token; everything else is OpenAI-compatible (one client, different `baseURL`). See `src/providers/catalog.ts`.

Or build a single static binary (no runtime needed to distribute it):

```sh
bun run build        # → ./amux
./amux "Add a health check endpoint and a test for it."
```

Keys can also come from env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) — handy for CI.

## Configure agents

Edit `.amux/agents.yaml` — one entry per role. The `lead` agent decomposes your prompt into tasks; every agent then drains the shared queue.

```yaml
agents:
  - id: architect
    provider: anthropic
    model: claude-opus-4-8
    role: Architect
    lead: true
    systemPrompt: You are a software architect. Decompose work into independent subtasks.
  - id: engineer
    provider: openai
    model: gpt-4o
    role: Backend Engineer
    systemPrompt: You are a backend engineer. Implement the assigned task.
```

## How it works

```
loadAgents (.amux/agents.yaml) ──▶ makeProvider (keychain/env) ──▶ Agent[]
                                                                      │
lead agent ──decompose──▶ Orchestrator (shared task queue) ◀──claim──┤
                                   │                                   │
                            AgentEvent stream (node:events) ──────────▶ Ink TUI
```

- **Orchestrator** — a shared `Task[]`. `claimTask` is synchronous, so it's atomic under Node's single-threaded event loop: no locks needed, no double-claims. Agents run as concurrent async loops draining the queue.
- **Providers** — one `Provider` interface, three hand-thin wrappers over the official Anthropic / OpenAI / Gemini SDKs.
- **Event bus** — a typed wrapper over `node:events`; agents publish, the TUI subscribes.
- **Tools** — sandboxed `read_file` / `write_file` / `shell`, gated per-agent by `allowedTools`, with every path jailed to the project root and shell exec via `spawn` (no shell string → no injection).

## Status

Built and tested: multi-provider BYOK (12 providers via one catalog), shared-queue orchestration, config, OS-keychain key storage, sandboxed tools (path-traversal + injection tested), live Ink TUI, single-binary compile, **an interactive terminal session**, an **opencode-style `/model` selector** (provider → model, applied to an agent live), and **the provider-driven tool-use loop** — agents call `read_file`/`write_file`/`shell` mid-turn, executed through the sandbox and fed back until the task is done (Anthropic `tool_use`, OpenAI `tool_calls`, Gemini `functionCall`).

**Streaming**: agent output streams token-by-token in the TUI (live growing text per agent), across all providers — Anthropic `.stream()`, OpenAI/Gemini/Copilot incremental deltas.

**Approval gates**: in interactive mode, agents pause before `write_file`/`shell` and ask `[y] approve · [n] deny · [a] always`. One-shot (`amux "task"`) auto-runs for scripting.

**Token safeguards & failover**: agents report token usage and get pre-emptive `warning`s — at ~85% of the context window, *and* when the account's rate-limit headers show requests running out. When one hits a 429 / overload / context-limit, its task is requeued (not failed) and another agent picks it up — a `failover` event shows the handoff; an attempt cap (3) prevents loops.

**`/usage` stats page**: type `/usage` for a live per-agent token table (input/output/total, calls) with proportional bars, session totals, and each provider's remaining rate-limit quota.

**Graph view**: type `/graph` in the interactive session for a live agent→task tree — each agent node with the tasks it worked, failover markers (`⚡×N`), and unassigned pending tasks.

**MCP**: declare `mcpServers` in `.amux/agents.yaml`; each server's tools appear to agents as `mcp__<server>__<tool>` and route through the same tool loop (gated for approval like other external actions). Verified end-to-end against a live stdio MCP server.

**Skills**: drop `.amux/skills/<name>/SKILL.md` (YAML frontmatter) — descriptions are injected into every agent's system prompt; agents read the full file on demand.

**Session persistence**: tasks auto-save to `.amux/session.json`; `amux resume` reopens them.

Intentional ceilings (deliberate, not gaps): the graph is a tree layout, not force-directed physics; the tool sandbox is path-prefix jailed, not container/seccomp isolated (symlink escapes are possible); MCP servers are shared across agents, not per-agent scoped; skills are prompt-injected + read-on-demand, not sandboxed execution; Gemini pairs parallel tool calls by name (a rare edge when the same tool is called twice in one turn); and of the three sign-in options, only GitHub Copilot's OAuth is wired (ChatGPT/GitLab subscription-as-API has no official, testable device flow).

## Development

```sh
bun test              # unit + security tests
bunx tsc --noEmit     # typecheck
```

MIT.
