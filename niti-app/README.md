# niti app

The desktop app for niti: a team of AI coding agents from different providers working on one project, in a native window instead of a terminal.

It runs the same engine as the terminal app (`niti-core serve`). It also shares the terminal app's config (`.niti/agents.yaml`), keys (`~/.config/niti/auth.json` + keychain), trust list, session store and remote-control sign-in. You can switch between the two on the same project. How every part of the repo fits together: `../project_context.md`; the terminal app: `../tui/README.md`.

## Features

- **Open a folder, pick a team.** Each time you open a folder, choose to keep its team or build a new one: providers (keys saved inline), models, roles, the lead, and the approval mode. It writes the same `agents.yaml` as the TUI's picker.
- **One prompt to the whole team.** The lead plans each goal into tasks across every agent. During a run you can steer one agent, let the app pick which one, or broadcast to everyone working.
- **Session.** Every agent side by side, or one focused, each with its own avatar character (they blink). Shows:
  - streaming markdown
  - live tool calls
  - numbered diffs with word-level highlights
  - shell results
  - pinned checklists
  - the run summary, with next-step suggestions
- **Composer.** Build/Plan modes, `/commands`, `@file` mentions, `!shell`, history, Esc to stop. Mid-run, tick "Interrupt it now" to stop one agent and have it carry on from your message.
- **Goals.** `/goal <objective>` keeps the team working round after round until a judge says it's done or a budget runs out. The status bar shows the round; while it runs, what you type is a note to the next round, and you're notified once when it ends.
- **Remote control.** Once this Mac is signed in (`/remote login`), the status bar shows the link and how many phones are watching. A phone asking to join shows its pairing code here, to allow or deny.
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
  - Agent behaviour.
  - Integrations: MCP, LSP, skills, permissions.
  - Worktree: merge or discard.
  - History: rewind, branch snapshots, sessions.
- **Everywhere.**
  - Command palette ⌘K, pages ⌘1–5, model switcher ⌘L, history ⌘R, focus an agent ⌥1–9, focus mode ⌘., sidebar ⌘B.
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

`scripts/bundle-core.ts` compiles niti-core into `resources/<arch>/`, and electron-builder ships it inside the app. Builds are ad-hoc signed. Distributing them needs a Developer ID identity and notarization.

## Layout

```
src/main/       windows, menu, IPC, niti-core lifecycle (core.ts), login-shell env (env.ts)
src/preload/    the typed window.niti bridge
src/renderer/   React: lib/ (API, SSE, reducer), store/, features/, components/ui (shadcn)
scripts/        fixture, live/smoke/audit/perf checks, core bundling (the avatar PNGs come from
                the repo's scripts/avatars/make-avatars.py)
```

Each window has one project and its own niti-core. The renderer talks to the core over HTTP and SSE, using the URL and token from the core's handshake.
