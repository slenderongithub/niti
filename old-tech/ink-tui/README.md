# Archived: Ink/React terminal UI

This is the original amux interactive terminal UI, built with [Ink](https://github.com/vadimdemedes/ink)
(React for CLIs). It has been **superseded by `tui/`** (Go + Bubbletea) as the primary interactive
front end, per the v2 client/server overhaul (see `../../project_context.md`).

**Status: archived, not maintained, not part of the build.** It is kept here for reference and in
case it's ever useful again — not deleted outright. It is excluded from the root project's
`tsc --noEmit`/`bun test` (its `tsconfig.json`/dependencies live in this folder, not the root
`package.json`).

## What's here

- `App.tsx` — main screen: multi-agent panes, slash commands, approval prompts
- `GraphView.tsx` — agent→task ASCII tree (`/graph`)
- `UsageView.tsx` — token usage table + bar chart (`/usage`)
- `ModelSelector.tsx` — opencode-style provider/model picker (`/model`)
- `theme.ts` — color palette + per-agent avatars

Every file's external imports (`agent/agent.ts`, `orchestrator/*`, `events/bus.ts`, etc.) point back
into the live `../../src/` tree via relative paths — those modules still exist and are actively
maintained, so this archive stays *readable* even as the rest of the codebase evolves. It is not
guaranteed to stay *compilable*: nobody runs `tsc`/`bun test` against it as part of CI, so if `src/`
changes an exported shape this code depends on, it will silently drift out of sync.

## If you want to revive or run it

```sh
cd old-tech/ink-tui
bun install
bunx tsc --noEmit          # check it still typechecks against current src/
bun test                    # run its own *.test.tsx files
```

It was last known-working as of the v2 overhaul (all 90+ of its original tests passing, wired into
`src/cli.ts`'s interactive/one-shot mode via `renderTui()`). Reconnecting it to `src/cli.ts` means
re-adding an import like `import { renderTui } from "../old-tech/ink-tui/App.tsx"` and restoring the
Ink-driven branches that were removed from the interactive/one-shot code path.
