# niti — the CLI

The main product: a team of AI coding agents on any mix of models, working on one project, in your
terminal. It is three pieces built from this repo:

| Piece | Source | What it is |
|---|---|---|
| `niti` | `tui/` (this folder) | The interactive terminal app: Go + Bubbletea. |
| `niti-core` | `../src/` | The engine (Bun/TypeScript). `niti` spawns it and drives it over local HTTP + SSE. It also runs headless for scripts and CI. |
| web dashboard | `../web/` | A browser view served by `niti-core --web`: live force-graph, tasks, messages, usage, approvals, prompts. |

The desktop app (`../niti-app/`) is the same product in a window, over the same engine; the iPhone app
(`../niti-mobile/`) controls a running core remotely. How they all fit: `../project_context.md`.

## Build and run

```sh
bun install
bun run build:tui        # → ./niti   (the Go TUI)
bun run build            # → ./niti-core (the compiled engine)
./niti                   # in any project folder
```

`niti` looks for `niti-core` next to its own binary, then on `$PATH`, then falls back to running
`../src/server/main.ts` with Bun from a checkout. `NITI_CORE_ENTRY=<file.ts>` forces a source entry.
The published package (`@slenderbuilds/niti` on npm) ships per-platform binaries of both
(`scripts/build-release.ts`).

## Using it

1. **Trust.** The first time in a folder, niti asks whether you trust it before reading its config.
2. **Team.** Every launch shows the team picker: keep the saved team or build one (size → provider →
   model → role → description). It writes `.niti/agents.yaml`, touching only `agents:`.
3. **Session.** A title bar (with the goal, awake and remote chips), the agents' transcripts (all
   side by side, or one), the Agents panel, the Files panel (the project tree marked M edited, A
   created, · read; enter views a file, `e` opens it in `$EDITOR`), the task board and connected
   LSP/MCP servers, the prompt, and a footer of the keys in force. After an update the session opens
   on what's new: "Updated to 0.4.10. Got 3 features, 5 bug fixes, and 1 other change." and the list.
   An approval nobody answers is denied after `approvalTimeout` (5 minutes), with a countdown.

**Keys**

| Key | Does |
|---|---|
| `enter` · `alt+enter` | Send · newline (also `shift+enter`, `^j`) |
| `shift+tab` | BUILD (agents act) ⇄ PLAN (the lead only plans) |
| `tab` | Walk focus between the prompt, transcript, Agents and Files panels |
| `esc` | Stop the run (pauses a running goal) |
| `^p` | Command palette: every command, view, agent and theme |
| `/` | Command menu (`tab` completes, `enter` runs) |
| `^l` | Switch an agent's model |
| `^g` · `alt+1…9` | Show one agent (again: all) |
| `^o` | Expand full command output and whole diffs |
| `^r` | Search earlier prompts |
| `^t` | Theme picker, with live preview |
| `x` (agents panel) | Interrupt that agent: type what it should do instead |
| `y` `a` `n` `t` (approval) | Allow once · always for this agent · deny · deny and tell it why |
| `^c` twice, or `/quit` | Quit |

**Commands** come from the engine, so every front end has the same ones: `/goal`, `/cancel`, `/awake`,
`/remote`, `/auto`, `/manual`, `/rewind`, `/branch`, `/model`, `/agents`, `/tasks`, `/status`, `/cost`,
`/sessions`, `/skills`, `/mcp`, `/lsp`, `/permissions`, `/debate`, `/export`, `/resume`, `/clear`, `/init`,
`/help`, plus project commands in `.niti/commands/*.md`. While a goal runs, what you type is a note to
its next round, and the header shows the round.

**Local models and the web.** A teammate can run on this Mac: provider `local`, model
`<huggingface repo>:<quant>` (the picker lists what you've downloaded). niti downloads GGUF models
itself and runs them with a bundled llama.cpp, with no Ollama or LM Studio needed. To get one, use
`niti-core models` (below) or the desktop app's Models page. Local agents use the harness's local
profile (`profile: local|standard` on an agent overrides it): short guidance, fewer tools, earlier
compaction, and a guard against repeated calls. Their shell has no internet unless you approve the
command. New teams get the `web` tools:
- `web_fetch` reads a page;
- `lookup` checks npm, PyPI, crates.io, Go, GitHub, Stack Overflow and Wikipedia;
- `web_search` runs once a free Tavily key is saved (`niti-core auth login tavily`).

Every web call asks, even under `/auto`.

**Themes**: graphite, obsidian, ember, tide, dusk and moss, each in dark and light
(`internal/theme/palettes.json`, shared with the web dashboard).

## Headless: `niti-core`

```sh
niti-core "<task>"                 # one run, plain-text progress, exit 0/1/2
niti-core resume                   # finish the last session's leftovers
niti-core init                     # setup wizard
niti-core serve [--port=N]         # the server the TUI starts
niti-core --web ["<task>"]         # server + the web dashboard
niti-core auth login|list|logout <provider> · login copilot · auth login tavily
niti-core models [recommended]     # models that run well here and can call tools
niti-core models search <query>    # the Hugging Face catalogue
niti-core models get <repo>[:<quant>]   # download (the best quant for this Mac by default)
niti-core models list · rm <repo>:<quant>
niti-core audit verify             # check the tool-call log's hash chain
niti-core trust check|grant
# flags: --auto · --worktree · --trust · --show-url · --version
```

## Layout

```
cmd/niti/            entry: find and spawn niti-core, read its handshake, run picker then session
internal/api/        typed HTTP + SSE client (reconnects with seq replay)
internal/wizard/     the team picker
internal/session/    the live view: transcript, tool feed, diffs, approvals, agents, tasks, files,
                     palette, carousel, goal and remote chips, settings, keys
internal/theme/      palettes and avatars
internal/trust/      the trust prompt
internal/ui/         shared list, panel and layout widgets
internal/whatsnew/   what changed since the last version run (changelog.json, drafted by bun run bump)
```

## Check it

```sh
cd tui && go build ./... && go vet ./... && go test ./...
zsh ../scripts/e2e/run.sh      # the whole CLI end to end: core API, remote path, headless CLI,
                               # the TUI against a live core, the TUI in a real terminal, the relay
```

The end-to-end run uses the repo's scripted model (`scripts/e2e/fakellm.ts`), so it needs no network
and costs nothing. A change here has its matching change in the desktop app (`../niti-app/`); see
`../CLAUDE.md`.
