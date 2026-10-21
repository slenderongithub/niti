# niti app

The desktop app for niti: a team of AI coding agents from different providers working on one project, in a native window instead of a terminal.

It runs the same engine as the terminal app (`niti-core serve`). It also shares the terminal app's config (`.niti/agents.yaml`), keys (`~/.config/niti/auth.json` + keychain), trust list, session store and remote-control sign-in. You can switch between the two on the same project. How every part of the repo fits together: `../project_context.md`; the terminal app: `../tui/README.md`.

## Features

- **Open a folder, pick a team.** Each time you open a folder, choose to keep its team or build a new one: providers (keys saved inline), models, roles, the lead, and the approval mode. It writes the same `agents.yaml` as the TUI's picker. Each teammate runs in the **Cloud** or **On this Mac**. On this Mac lists the models you've downloaded, can add one found elsewhere on the Mac, and can download one recommended for this Mac right there.
- **Models.** Open models from Hugging Face that run on this Mac, on niti's own engines (no Ollama or LM Studio needed): GGUF on a bundled llama.cpp, and on Apple Silicon MLX on Apple's mlx-lm, which downloads once (about 140 MB) the first time an MLX model runs. There are three tabs:
  - **Recommended for this Mac:** the most downloaded models that can call tools and run well here, one per model family.
  - **All models:** search, sort (most downloaded, liked, trending, recently updated), and filter by format (GGUF, MLX), size, tool support and fit.
  - **Installed:** size on disk, when an agent last used it, loaded or not, unload and delete. **Found on this Mac** lists models another app already downloaded (LM Studio's folder, the Hugging Face cache); Add uses them where they are, with no second download, and removing one never touches its files. The MLX engine's status, install progress and removal are here too.

  Each model shows Runs well / Tight / Won't fit, tools and thinking support, licence, downloads, likes, parameters and context. Its sheet lists every quantization with its exact size and fit, and the model card. Downloads resume, verify their checksum, and keep going in the background. A local agent's shell has no internet unless you approve the command.

  niti checks each downloaded model once, before its first agent task. It tests whether the model calls tools, how niti has to drive it, and whether it can split work for a team. Installed models and the setup picker show the result: **Ready**, **Partly ready** or **Chat only**. The sheet's "niti's check" section has the details and Check again. A chat-only model answers and reviews but never gets work that changes files. A model waiting for memory says so.
- **Web.** Agents with the `web` tool read pages (`web_fetch`) and look things up in npm, PyPI, crates.io, Go, GitHub, Stack Overflow and Wikipedia (`lookup`) with no account. Settings → Web search adds a free Tavily key for `web_search` (1,000 searches a month, no card). Every web call asks you first, even with auto-approve on.
- **One prompt to the whole team.** The lead plans each goal into tasks across every agent. Launching a team on local models notes what to expect: models that don't fit in memory together take turns, chat-only teammates, and a teammate planning for a lead whose model can't. During a run you can steer one agent, let the app pick which one, or broadcast to everyone working.
- **Session.** Every agent side by side, or one focused, each with its own avatar character (they blink). Shows:
  - streaming markdown
  - live tool calls
  - numbered diffs with word-level highlights
  - shell results
  - pinned checklists
  - the run summary, with next-step suggestions
  - for a local agent, a card for niti's checks on its work: what fails, with what to fix, and what passed
- **Composer.** Build/Plan modes, `/commands`, `@file` mentions, `!shell`, history, Esc to stop. Mid-run, tick "Interrupt it now" to stop one agent and have it carry on from your message.
- **Goals.** `/goal <objective>` keeps the team working round after round until a judge says it's done or a budget runs out. The status bar shows the round; while it runs, what you type is a note to the next round, and you're notified once when it ends.
- **Remote control.** `/remote on <email>` shows a code to type into the niti app on your phone; then the status bar shows the link and how many phones are watching. `/remote pair` adds another phone.
- **Files.** Open any file as a tab in the centre and edit it (CodeMirror: syntax highlighting, search, undo), save with ⌘S.
  - Lines the agents changed this session are marked in the gutter.
  - A file an agent is writing is read-only until it's done.
  - If an agent changes a file you're editing, you choose: reload theirs or keep yours.
  - Unsaved changes are never lost silently.
- **Approvals.** For each write or command:
  - allow, or always allow for this agent
  - deny, or deny and tell the agent what to do instead
  - edit before allowing
  - approve all
  - a countdown to when the core denies it on its own (`approvalTimeout`, default 5 minutes)
- **Tasks.** A kanban board with animated hand-offs, a dependency graph, task details, and reassign.
- **Tokens.**
  - Live: totals, cost, per-agent breakdown, context meters, rate limits, run history.
  - All time: a year heatmap, the last 90 days, per-model spend.
- **Graph.** The project's import graph (the web view's force layout, ported), with search, pinning, minimap and zoom/pan. An agents view shows message pulses.
- **Dashboard.** Run state up top, then the agents' conversations, threaded by pair (hand-offs, questions, answers, reviews), then agents, changed files and tasks.
- **Settings.**
  - Appearance: light, dark or system.
  - Team: per-agent models.
  - Providers and keys.
  - Web search: the Tavily key, tested before it's saved.
  - Agent behaviour.
  - Integrations: MCP, LSP, skills, permissions.
  - Worktree: merge or discard.
  - History: rewind, branch snapshots, sessions.
- **Everywhere.**
  - Command palette ⌘K, pages ⌘1–6 (⌘6 Models), settings ⌘7 or ⌘,, model switcher ⌘L, history ⌘R, focus an agent ⌥1–9, focus mode ⌘., sidebar ⌘B.
  - Resizable panes.
  - A notification when a long run ends, and a Dock badge for pending approvals.
  - Drop a folder on the window or the Dock icon to open it.

The look: the TUI's obsidian palettes with a violet accent (`#9D8CFF` / `#5A46D8`), Inter and JetBrains Mono, the logo's spider web for empty space, the braille spinner, and the transcript's glyph language.

## Shared with the phone

The iPhone app (`../niti-mobile/`) wears this app's design language and runs on this app's code:
it imports `src/renderer/src/lib/` (the reducer, types, humanize, identity, diff, format) and loads the
avatars from `src/renderer/src/assets/avatars/`. A change there is a change to the phone too: run its
checks (`cd ../niti-mobile && npm run typecheck && bun test ./src`), and give a design change here its
matching change there. `niti-mobile/src/lib/colors.test.ts` fails if the colour tokens in
`src/renderer/src/styles/globals.css` and the phone's drift apart.

## Develop

```sh
cd niti-app
npm install
npm run dev        # hot reload; runs the engine from ../src via bun
```

## Check

```sh
npm run typecheck
bun test ./src                          # reducer, humanize, physics, team rules, SSE, diffs, stats
bun scripts/live.ts                     # API client + reducer vs a real niti-core and a fake model
npm run build && bun scripts/smoke.ts   # real app: trust, keep team, run a goal via the approval
                                        # dialog, every page in both themes
bun scripts/audit.ts                    # layout test: every page, 2 window sizes, both themes —
                                        # clipping, overflow, unequal boxes, misaligned edges, gaps
bun scripts/perf.ts                     # real input → paint timings, streaming, idle CPU, with budgets
npm run check                           # all of the above
```

The live and smoke checks use the repo's scripted model (`scripts/e2e/fakellm.ts`). They need no network and cost nothing.

## Package

```sh
npm run dist:dir                  # unpacked .app for this arch → release/mac-<arch>/niti.app
npm run dist                      # dmg + zip for this Mac's arch
npm run dist:all                  # dmg + zip for arm64 and x64
bun scripts/smoke.ts --packaged   # smoke (and perf.ts / audit.ts) against the packaged app
```

`scripts/bundle-core.ts` compiles niti-core into `resources/<arch>/`, and electron-builder ships it inside the app. `scripts/bundle-llama.ts` fetches the pinned, checksum-verified llama.cpp release and keeps `llama-server` and the libraries it links in `resources/<arch>/llama/` (shipped as `Contents/Resources/llama`, about 28 MB). `npm run dev` uses that copy too, once fetched (`npm run bundle-llama`). Builds are ad-hoc signed. Distributing them needs a Developer ID identity and notarization.

## Layout

```
src/main/       windows, menu, IPC, niti-core lifecycle (core.ts), login-shell env (env.ts)
src/preload/    the typed window.niti bridge
src/renderer/   React: lib/ (API, SSE, reducer), store/, features/, components/ui (shadcn)
scripts/        fixture, live/smoke/audit/perf checks, core bundling (the avatar PNGs come from
                the repo's scripts/avatars/make-avatars.py)
```

Each window has one project and its own niti-core. The renderer talks to the core over HTTP and SSE, using the URL and token from the core's handshake.
