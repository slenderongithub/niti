# niti

A terminal CLI that runs **multiple AI coding agents from different LLM providers concurrently** on one project. You assign models to **custom roles** (e.g. Gemini = Frontend Designer, Claude = Backend Engineer), pick one as the **orchestrator** that plans the work into a task DAG and sequences it, and the role-agents build together — **talking directly to each other** to align — while you watch live in the terminal (and an optional web dashboard graphing the agents as they message each other).

Bring your own keys — 29 curated providers / 152 models from the [Models.dev](https://models.dev) catalog, plus **Custom** for any other OpenAI-compatible endpoint. Keys live in a global `~/.config/niti/auth.json` (0600) and your OS keychain, never a server.

> **v2 overhaul:** the orchestrator-DAG, agent-to-agent messaging, team picker, HTTP+SSE server,
> Go+Bubbletea TUI, and web dashboard are new. See [`project_context.md`](./project_context.md) for
> the full architecture record — what's implemented, verified, and adversarially reviewed.

## Two front ends, one core

- **`niti`** — the **primary, interactive** front end: a Go + Bubbletea terminal UI (`tui/`). It
  spawns the Bun core as a subprocess and talks to it over a local HTTP+SSE API. This is what you run
  day to day.
- **`niti-core`** — the headless Bun/TypeScript engine (`src/`). It's what `niti` spawns under the
  hood, and it's also a standalone scripting CLI (one-shot runs, `serve`, `auth`, `init`, `--web`) for
  CI or automation where an interactive terminal isn't available.

The original React/Ink terminal UI has been archived — not deleted — under
[`old-tech/ink-tui/`](./old-tech/ink-tui/) (see its own README for status and how to run it) while the
Go TUI is the maintained interactive front end.

## Quickstart

```sh
npm install -g niti                        # prebuilt binaries — no Bun, no Go, no build step
niti                                       # pick the team, then the live session
```

The package is published as **`niti`** because `niti` was already taken on npm; the commands it
installs are still `niti` (the interactive TUI) and `niti-core` (the headless engine), and the
project's state directory is still `.niti/`.

What npm downloads is a small Node shim — the real executables ship as per-platform packages it
picks between automatically: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64.

### From source

Requires [Bun](https://bun.sh) ≥ 1.3 and [Go](https://go.dev) ≥ 1.22 (only needed to build `niti`; the
core itself is pure Bun/TypeScript).

```sh
bun install
bun run build:tui                          # builds ./niti (the Go TUI) — do this once, or after tui/ changes

./niti                                     # every launch: pick the team (1–6 models, one prompt each), then the live session
                                            #   type a goal, watch the agents plan + build + talk to each other
                                            #   "/" for commands · ctrl+p switches models · Tab cycles views · y/a/n answers approvals
```

For scripting/CI (no interactive terminal, uses the headless core directly):

```sh
bun run src/cli.ts init                    # headless setup wizard (plain prompts) — alternative to the team picker
bun run src/cli.ts "Build a clothing website for gen-z."           # one-shot, prints plain-text progress, exits
bun run src/cli.ts --web "Build a clothing website for gen-z."     # + live web dashboard (localhost)
bun run src/cli.ts login copilot           # sign in with a GitHub Copilot subscription (no API key)
bun run src/server/main.ts                 # headless core server (prints a handshake; what `niti` connects to)
                                            #   swap /dashboard for /graph/view in the printed URL to open the graph page instead
```

### Picking the team

`./niti` opens the picker on every launch, centred on screen — a static `agents.yaml` stops being
useful the moment you want to try a different model. It asks:

1. **how many teammates** (1–6 — each gets its own pixel-avatar color: blue, yellow, red, purple, green, pink),
2. then, per teammate: **provider** → **model** → **name** → **what it does**.

The provider list is the whole catalog, not just the ones you've set up: pick one without a key and
it asks for the key right there. Type to filter, `↑↓` to choose, `esc` to step back. What you write
in "what it does" becomes that agent's system prompt, so it's worth a sentence.

### Three ways to supply models

1. **API key (BYOK)** — Anthropic, OpenAI, Google, DeepSeek, Groq, OpenRouter, Moonshot/Kimi, xAI, Mistral, Together, Fireworks, Cerebras, plus **Custom (OpenAI-compatible)** — pick "Custom", enter any base URL, and reach any OpenAI-compatible endpoint the picker doesn't list (the built-in catalog is a curated 29 providers / 152 models, not the ~180 Models.dev knows about). `niti-core auth login <provider>` (global `~/.config/niti/auth.json` 0600 + OS keychain) or the matching env var.
2. **Local (offline, no key)** — Ollama (`:11434`) and LM Studio (`:1234`), routed at their local OpenAI-compatible endpoints. Nothing leaves your machine.
3. **Sign in (subscription)** — **GitHub Copilot** via OAuth: `niti-core login copilot` runs GitHub's device flow (open the URL, enter the code); the token is stored and refreshed automatically. Then pick GitHub Copilot as a role's model.

Under the hood: Anthropic and Google use native clients; Copilot wraps the OpenAI client with a self-refreshing token; everything else is OpenAI-compatible (one client, different `baseURL`). See `src/providers/catalog.ts`.

Or build a distributable headless binary of just the core (no Bun runtime needed to run it):

```sh
bun run build         # → ./niti-core
./niti-core "Add a health check endpoint and a test for it."
```

Keys can also come from env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) — handy for CI.

## Configure agents

Edit `.niti/agents.yaml` — one entry per role. The `lead` agent decomposes your prompt into tasks; every agent then drains the shared queue.

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
    allowedTools: [read_file, write_file, edit, shell, mcp]   # `mcp` = every MCP server's tools

permissions:                            # project-wide default policy
  shell:      { "git *": allow, "git commit *": ask, "rm -rf*": deny }
  write_file: { "src/**": allow, "*": ask }

lsp:                                    # optional language servers (you install them; niti spawns them)
  typescript: { command: typescript-language-server, args: [--stdio], extensions: [.ts, .tsx] }
  go:         { command: gopls, extensions: [.go] }

mcpServers:                             # optional MCP servers, merged into the same tool loop as LSP
  - name: code-review
    command: code-review-graph
    args: [--stdio]

# --- options: everything else is optional and has a working default ---
theme: niti                             # TUI colours at launch (ctrl+t or /theme opens a carousel; synced live to the web dashboard/graph)
auto: false                             # approve anything not explicitly denied (same as --auto)
watch: true                             # announce edits made outside niti as external_change events
instructions: [AGENTS.md, CLAUDE.md]    # appended to every agent's system prompt (missing files are skipped)
maxTurns: 12                            # tool-loop iterations per agent turn
maxAgents: 6                            # refuse to load a bigger team than this (the picker itself caps at 6 — one per avatar color)
```

The team picker rewrites only the `agents:` block — everything above survives a relaunch.

**Permissions** resolve agent block → project block → built-in defaults, and the most specific
pattern wins (`git push --force*` beats `git *`). Anything unmatched asks, so a file with no
`permissions:` behaves exactly as before. A `deny` is policy, not a prompt: it blocks even in
headless runs. Destructive shell commands (`rm -rf`, `git push --force`, …) always prompt, whatever
the config says — including under `--auto` (approve anything not explicitly denied).

### Environment variables

All optional — every one has a working default. Listed because they were previously documented
nowhere, which made a broken install hard to diagnose.

| Variable | What it does |
|---|---|
| `NITI_CORE_ENTRY` | Run the core from this entry point instead of the resolved `niti-core` binary (dev override). |
| `NITI_BUN` | The `bun` executable used with `NITI_CORE_ENTRY`. Default: `bun` on `$PATH`. |
| `NITI_SERVER_URL` / `NITI_SERVER_TOKEN` | Attach the TUI to an already-running core instead of spawning one. Note that a core started this way cannot be restarted by the picker, so a new team needs a manual restart. |
| `NITI_WEB_DIR` | Where the dashboard's static files live. Resolved automatically; set it only for an unusual layout. |
| `NITI_AUTH_FILE` | Path to the credential store. Default: `~/.config/niti/auth.json` (0600). |
| `NITI_NO_MOUSE` | Set to `1` to give the wheel and drag-to-select back to your terminal. niti takes mouse reporting so the wheel scrolls the session rather than the shell's scrollback; if you would rather select text with the mouse, set this. |

Provider keys are read from the usual per-provider variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, …) when nothing is stored in the auth file or the keychain.

## How it works

```
                    Go + Bubbletea TUI (niti)         Web dashboard (optional, --web)
                     team picker · panes · comm-graph    localhost force-graph
                              └──────────── HTTP + SSE (src/server) ────────────┘
                                                  ▼
                                    Engine (src/engine.ts)
   loadAgents (.niti/agents.yaml) ──▶ makeProvider (auth store) ──▶ Agent[] (+ Messenger)
                                                  │
   orchestrator ──plan (DAG)──▶ scheduler (src/orchestrator) ◀──concurrent claim──┤
                        │                    │
                  MessageBus (agent ↔ agent)  AgentEvent stream ──▶ EventHub ──▶ SSE
```

- **Orchestrator** — the lead agent turns a goal into a validated task **DAG** (dependencies + hand-offs), not a flat queue; the scheduler runs independent tasks concurrently, delivers each task's output to its dependents/hand-off recipients, and the lead reviews + summarizes at the end (`src/orchestrator/planner.ts`, `scheduler.ts`).
- **Agent-to-agent messaging** — agents can `send_message`/`ask_agent` any teammate directly mid-task (e.g. frontend asking backend about the API shape), routed through a `MessageBus` with a per-pair rate cap as the loop guard (`src/messaging/`).
- **Providers** — one `Provider` interface; native clients for Anthropic/Gemini, one OpenAI-compatible client covering the rest of the catalog (29 providers / 152 models total, generated from Models.dev) and any custom base URL.
- **Event bus → SSE** — agents publish to a typed `Bus`; the `Engine` fans that (plus orchestration lifecycle, agent messages, usage, approvals) into one `EventHub` served over Server-Sent Events to both the Go TUI and the web dashboard.
- **Tools** — sandboxed `read_file` / `write_file` / `edit` / `shell`, gated per-agent by `allowedTools` *and* by the wildcard permission policy above. `allowedTools` bounds MCP tools too: add `mcp` to grant every configured server's tools, or name one as `mcp__<server>__<tool>`. Every path is jailed to the project root and shell exec via `spawn` (no shell string → no injection). `edit` replaces an exact snippet (unique match required) instead of overwriting a whole file.
- **Persistence** — every turn is decomposed into parts and written to SQLite at `.niti/niti.db` (`src/store/`), so conversations survive a restart: `niti-core resume` re-runs unfinished tasks with their history seeded. Each file write is checkpointed first, which is what `/undo` reverts.
- **LSP + MCP together** — MCP servers and language servers are two independent tool sources merged into the same loop. LSP adds `diagnostics(path)` and `hover(path,line,col)` over hand-rolled JSON-RPC (`src/lsp/`); a missing server is a message, never a crash.
- **Sub-agent forking** — `spawn_fork` runs a child loop on the same model, tools, and permissions, and returns just its findings. It's a child *session*, invisible to the DAG scheduler, capped by `MAX_FORK_DEPTH`.
- **Slash commands** — defined server-side (`src/commands/registry.ts`) so the TUI and the web dashboard share one implementation. Typing `/` opens a filtered menu above the prompt with a description per command, so nothing has to be memorised. Server-side: `/usage /cancel /undo /rewind /branch /model /sessions /agents /tasks /skills /mcp /lsp /permissions /cost /status /debate /export /resume /clear /init /help`. Client-side (the TUI implements these itself): `/graph /dashboard /settings /config /stats /theme /quit`. Plus your own in `.niti/commands/<name>.md` (frontmatter + a prompt body, `$ARGUMENTS` interpolated).
- **Model carousel** — `ctrl+p` pops a picker in the middle of the screen: choose the teammate, then its model, with type-to-filter over every model on a provider you have a key for. `/model <agentId> <provider/model>` still works for scripting.
- **Theme carousel** — `ctrl+t` or `/theme` pops a centred carousel: `←→`/`hjkl` slides between palettes with a live preview before you commit, `esc` reverts. The choice persists to `.niti/agents.yaml` and syncs live (over the same SSE stream) to any open web dashboard or graph page — pick a theme in the TUI and an open browser tab updates without a reload.
- **Pixel-art agent avatars** — every agent in the web dashboard and the graph page's Models view renders as a small pixel mascot, one of 6 fixed identity colors by team position (blue, yellow, red, purple, green, pink — wraps past 6), each with its own face. Status (idle/working/done/failed) is a small corner dot, not the sprite's fill, so identity and status never fight for the same pixel.
- **File watching** — edits made outside niti (your editor, a `git checkout`) surface as `external_change` events; an agent's own writes are suppressed so it never hears its own echo.

## Status

Built, tested, and adversarially reviewed — see [`project_context.md`](./project_context.md) for the
full verification record and the list of bugs two review passes found and fixed. Highlights: multi-provider BYOK (29 providers / 152 models via Models.dev, plus custom endpoints), an orchestrator DAG
with concurrent scheduling and agent-to-agent messaging, a global typed auth store, sandboxed tools
(path-traversal + injection tested), a Go+Bubbletea TUI with a live communication graph, an optional
web dashboard, single-binary compiles for both front ends, and **the provider-driven tool-use loop** —
agents call `read_file`/`write_file`/`shell` mid-turn, executed through the sandbox and fed back until
the task is done (Anthropic `tool_use`, OpenAI `tool_calls`, Gemini `functionCall`).

**Streaming**: agent output streams token-by-token to both front ends, across all providers — Anthropic `.stream()`, OpenAI/Gemini/Copilot incremental deltas.

**Approval gates**: agents pause before `write_file`/`shell` and ask `[y] approve · [n] deny · [a] always` — in the Go TUI, and in the web dashboard (`--web`), which answers the same queue. A headless run (`niti-core "task"`) has nobody to ask, so it **refuses** gated tools unless you pass `--auto` or pre-grant them via `permissions:`/`autoApprove:` in agents.yaml. Dangerous shell patterns (`rm -rf`, `git push --force`, …) always prompt, even with a standing grant.

**Token safeguards & failover**: agents report token usage and get pre-emptive `warning`s — at ~85% of the context window, *and* when the account's rate-limit headers show requests running out. When one hits a 429 / overload / context-limit, its task is requeued (not failed) and another agent picks it up — a `failover` event shows the handoff; an attempt cap (3) prevents loops.

**`/usage` stats page**: `/usage` switches the main pane to a live per-agent token table (input/output/total, calls) with proportional bars, session totals, and each provider's remaining rate-limit quota. It's also the Usage tab of the `/settings` overlay, alongside Status, Config and Stats — `tab` toggles between the panes.

**Graph view**: `/graph` opens the interactive agent→task graph **in your browser** (the core serves it at `/graph/view`) — the terminal can't do the drag/hover/zoom the graph is built around. `/dashboard` opens the full control centre the same way. On a headless box with no browser, both report the failure rather than opening anything.

**MCP**: declare `mcpServers` in `.niti/agents.yaml`; each server's tools appear to agents as `mcp__<server>__<tool>` and route through the same tool loop (gated for approval like other external actions). Verified end-to-end against a live stdio MCP server.

**Skills**: drop `.niti/skills/<name>/SKILL.md` (YAML frontmatter) — descriptions are injected into every agent's system prompt; agents read the full file on demand.

**Session persistence**: tasks (and the DAG) auto-save to `.niti/session.json`; conversations (sessions → messages → parts, plus per-write checkpoints and the agent-to-agent message trail) go to SQLite at `.niti/niti.db`. `niti-core resume` continues the unfinished tasks with their stored history, rather than starting them over.

Intentional ceilings (deliberate, not gaps — see `project_context.md` for the full list): the tool sandbox is path-prefix jailed, not container/seccomp isolated (symlink escapes are possible); MCP servers are shared across agents, not per-agent scoped; skills are prompt-injected + read-on-demand, not sandboxed execution; Gemini pairs parallel tool calls by name (a rare edge when the same tool is called twice in one turn); agent-to-agent messaging is open within a run rather than restricted to the plan's declared edges (the planner can't anticipate every mid-task question, so only a per-pair rate cap guards against loops); and of the three sign-in options, only GitHub Copilot's OAuth is wired.

## Development

```sh
bun test              # TypeScript unit + integration tests
bunx tsc --noEmit     # typecheck
cd tui && go build ./... && go vet ./... && go test ./...   # Go TUI: build, vet, unit tests
```

MIT.
