# amux

A terminal CLI that runs **multiple AI coding agents from different LLM providers concurrently** on one project. You assign models to **custom roles** (e.g. Gemini = Frontend Designer, Claude = Backend Engineer), pick one as the **orchestrator** that plans the work into a task DAG and sequences it, and the role-agents build together — **talking directly to each other** to align — while you watch live in the terminal (and an optional web dashboard graphing the agents as they message each other).

Bring your own keys (Anthropic, OpenAI, Gemini, + 150 more via Models.dev). Keys live in a global `~/.config/amux/auth.json` (0600) and your OS keychain, never a server.

> **v2 overhaul:** the orchestrator-DAG, agent-to-agent messaging, onboarding wizard, HTTP+SSE server,
> Go+Bubbletea TUI, and web dashboard are new. See [`BUILD_STATUS.md`](./BUILD_STATUS.md) for exactly
> what's implemented, verified, and adversarially reviewed.

## Two front ends, one core

- **`amux`** — the **primary, interactive** front end: a Go + Bubbletea terminal UI (`tui/`). It
  spawns the Bun core as a subprocess and talks to it over a local HTTP+SSE API. This is what you run
  day to day.
- **`amux-core`** — the headless Bun/TypeScript engine (`src/`). It's what `amux` spawns under the
  hood, and it's also a standalone scripting CLI (one-shot runs, `serve`, `auth`, `init`, `--web`) for
  CI or automation where an interactive terminal isn't available.

The original React/Ink terminal UI has been archived — not deleted — under
[`old-tech/ink-tui/`](./old-tech/ink-tui/) (see its own README for status and how to run it) while the
Go TUI is the maintained interactive front end.

## Quickstart

Requires [Bun](https://bun.sh) ≥ 1.3 and [Go](https://go.dev) ≥ 1.22 (only needed to build `amux`; the
core itself is pure Bun/TypeScript).

```sh
bun install
bun run build:tui                          # builds ./amux (the Go TUI) — do this once, or after tui/ changes

./amux                                     # first run: onboarding wizard (providers → roles → orchestrator), then the live session
                                            #   after setup: type a goal, watch the agents plan + build + talk to each other
                                            #   Tab switches panes/comm-graph/usage views; y/a/n answers approvals
```

For scripting/CI (no interactive terminal, uses the headless core directly):

```sh
bun run src/cli.ts init                    # headless setup wizard (plain prompts) — alternative to the Go wizard
bun run src/cli.ts "Build a clothing website for gen-z."           # one-shot, prints plain-text progress, exits
bun run src/cli.ts --web "Build a clothing website for gen-z."     # + live web dashboard (localhost)
bun run src/cli.ts login copilot           # sign in with a GitHub Copilot subscription (no API key)
bun run src/server/main.ts                 # headless core server (prints a handshake; what `amux` connects to)
```

### Three ways to supply models (`/model` selector)

1. **API key (BYOK)** — Anthropic, OpenAI, Google, DeepSeek, Groq, OpenRouter, Moonshot/Kimi, xAI, Mistral, Together, Fireworks, Cerebras, plus **Custom (OpenAI-compatible)** — pick "Custom", enter any base URL, and reach any of the 150+ OpenAI-compatible providers via the Models.dev catalog. `amux-core auth login <provider>` (global `~/.config/amux/auth.json` 0600 + OS keychain) or the matching env var.
2. **Local (offline, no key)** — Ollama (`:11434`) and LM Studio (`:1234`), routed at their local OpenAI-compatible endpoints. Nothing leaves your machine.
3. **Sign in (subscription)** — **GitHub Copilot** via OAuth: `amux-core login copilot` runs GitHub's device flow (open the URL, enter the code); the token is stored and refreshed automatically. Then pick GitHub Copilot as a role's model.

Under the hood: Anthropic and Google use native clients; Copilot wraps the OpenAI client with a self-refreshing token; everything else is OpenAI-compatible (one client, different `baseURL`). See `src/providers/catalog.ts`.

Or build a distributable headless binary of just the core (no Bun runtime needed to run it):

```sh
bun run build         # → ./amux-core
./amux-core "Add a health check endpoint and a test for it."
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
    permissions:                        # optional, per-agent — overrides the project block below
      shell: { "git *": allow }
  - id: engineer
    provider: openai
    model: gpt-4o
    role: Backend Engineer
    systemPrompt: You are a backend engineer. Implement the assigned task.
    allowedTools: [read_file, write_file, edit, shell]

permissions:                            # project-wide default policy
  shell:      { "git *": allow, "git commit *": ask, "rm -rf*": deny }
  write_file: { "src/**": allow, "*": ask }

lsp:                                    # optional language servers (you install them; amux spawns them)
  typescript: { command: typescript-language-server, args: [--stdio], extensions: [.ts, .tsx] }
  go:         { command: gopls, extensions: [.go] }
```

**Permissions** resolve agent block → project block → built-in defaults, and the most specific
pattern wins (`git push --force*` beats `git *`). Anything unmatched asks, so a file with no
`permissions:` behaves exactly as before. A `deny` is policy, not a prompt: it blocks even in
headless runs. Destructive shell commands (`rm -rf`, `git push --force`, …) always prompt, whatever
the config says — including under `--auto` (approve anything not explicitly denied).

## How it works

```
                    Go + Bubbletea TUI (amux)         Web dashboard (optional, --web)
                     wizard · panes · comm-graph        localhost force-graph
                              └──────────── HTTP + SSE (src/server) ────────────┘
                                                  ▼
                                    Engine (src/engine.ts)
   loadAgents (.amux/agents.yaml) ──▶ makeProvider (auth store) ──▶ Agent[] (+ Messenger)
                                                  │
   orchestrator ──plan (DAG)──▶ scheduler (src/orchestrator) ◀──concurrent claim──┤
                        │                    │
                  MessageBus (agent ↔ agent)  AgentEvent stream ──▶ EventHub ──▶ SSE
```

- **Orchestrator** — the lead agent turns a goal into a validated task **DAG** (dependencies + hand-offs), not a flat queue; the scheduler runs independent tasks concurrently, delivers each task's output to its dependents/hand-off recipients, and the lead reviews + summarizes at the end (`src/orchestrator/planner.ts`, `scheduler.ts`).
- **Agent-to-agent messaging** — agents can `send_message`/`ask_agent` any teammate directly mid-task (e.g. frontend asking backend about the API shape), routed through a `MessageBus` with a per-pair rate cap as the loop guard (`src/messaging/`).
- **Providers** — one `Provider` interface; native clients for Anthropic/Gemini, one OpenAI-compatible client covering 150+ providers via the Models.dev catalog.
- **Event bus → SSE** — agents publish to a typed `Bus`; the `Engine` fans that (plus orchestration lifecycle, agent messages, usage, approvals) into one `EventHub` served over Server-Sent Events to both the Go TUI and the web dashboard.
- **Tools** — sandboxed `read_file` / `write_file` / `edit` / `shell`, gated per-agent by `allowedTools` *and* by the wildcard permission policy above, with every path jailed to the project root and shell exec via `spawn` (no shell string → no injection). `edit` replaces an exact snippet (unique match required) instead of overwriting a whole file.
- **Persistence** — every turn is decomposed into parts and written to SQLite at `.amux/amux.db` (`src/store/`), so conversations survive a restart: `amux-core resume` re-runs unfinished tasks with their history seeded. Each file write is checkpointed first, which is what `/undo` reverts.
- **LSP + MCP together** — MCP servers and language servers are two independent tool sources merged into the same loop. LSP adds `diagnostics(path)` and `hover(path,line,col)` over hand-rolled JSON-RPC (`src/lsp/`); a missing server is a message, never a crash.
- **Sub-agent forking** — `spawn_fork` runs a child loop on the same model, tools, and permissions, and returns just its findings. It's a child *session*, invisible to the DAG scheduler, capped by `MAX_FORK_DEPTH`.
- **Slash commands** — defined server-side (`src/commands/registry.ts`) so the TUI and the web dashboard share one implementation: `/panes /graph /usage /cancel /undo /model /sessions`, plus your own in `.amux/commands/<name>.md` (frontmatter + a prompt body, `$ARGUMENTS` interpolated).
- **File watching** — edits made outside amux (your editor, a `git checkout`) surface as `external_change` events; an agent's own writes are suppressed so it never hears its own echo.

## Status

Built, tested, and adversarially reviewed — see [`BUILD_STATUS.md`](./BUILD_STATUS.md) for the full
verification record (142 TypeScript tests, Go build/vet/test, and the list of bugs two review passes
found and fixed). Highlights: multi-provider BYOK (150+ providers via Models.dev), an orchestrator DAG
with concurrent scheduling and agent-to-agent messaging, a global typed auth store, sandboxed tools
(path-traversal + injection tested), a Go+Bubbletea TUI with a live communication graph, an optional
web dashboard, single-binary compiles for both front ends, and **the provider-driven tool-use loop** —
agents call `read_file`/`write_file`/`shell` mid-turn, executed through the sandbox and fed back until
the task is done (Anthropic `tool_use`, OpenAI `tool_calls`, Gemini `functionCall`).

**Streaming**: agent output streams token-by-token to both front ends, across all providers — Anthropic `.stream()`, OpenAI/Gemini/Copilot incremental deltas.

**Approval gates**: in interactive mode (the Go TUI), agents pause before `write_file`/`shell` and ask `[y] approve · [n] deny · [a] always`. Headless/scripted runs (`amux-core "task"`, `--web`) auto-run for automation.

**Token safeguards & failover**: agents report token usage and get pre-emptive `warning`s — at ~85% of the context window, *and* when the account's rate-limit headers show requests running out. When one hits a 429 / overload / context-limit, its task is requeued (not failed) and another agent picks it up — a `failover` event shows the handoff; an attempt cap (3) prevents loops.

**`/usage` stats page**: type `/usage` for a live per-agent token table (input/output/total, calls) with proportional bars, session totals, and each provider's remaining rate-limit quota.

**Graph view**: type `/graph` in the interactive session for a live agent→task tree — each agent node with the tasks it worked, failover markers (`⚡×N`), and unassigned pending tasks.

**MCP**: declare `mcpServers` in `.amux/agents.yaml`; each server's tools appear to agents as `mcp__<server>__<tool>` and route through the same tool loop (gated for approval like other external actions). Verified end-to-end against a live stdio MCP server.

**Skills**: drop `.amux/skills/<name>/SKILL.md` (YAML frontmatter) — descriptions are injected into every agent's system prompt; agents read the full file on demand.

**Session persistence**: tasks (and the DAG) auto-save to `.amux/session.json`; conversations (sessions → messages → parts, plus per-write checkpoints and the agent-to-agent message trail) go to SQLite at `.amux/amux.db`. `amux-core resume` continues the unfinished tasks with their stored history, rather than starting them over.

Intentional ceilings (deliberate, not gaps — see `BUILD_STATUS.md` for the full list): the tool sandbox is path-prefix jailed, not container/seccomp isolated (symlink escapes are possible); MCP servers are shared across agents, not per-agent scoped; skills are prompt-injected + read-on-demand, not sandboxed execution; Gemini pairs parallel tool calls by name (a rare edge when the same tool is called twice in one turn); agent-to-agent messaging is open within a run rather than restricted to the plan's declared edges (the planner can't anticipate every mid-task question, so only a per-pair rate cap guards against loops); and of the three sign-in options, only GitHub Copilot's OAuth is wired.

## Development

```sh
bun test              # TypeScript unit + integration tests (142)
bunx tsc --noEmit     # typecheck
cd tui && go build ./... && go vet ./... && go test ./...   # Go TUI: build, vet, unit tests
```

MIT.
