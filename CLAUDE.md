# niti: one engine, four products — keep them uniform

niti ships **one product in two packagings**, plus **two companions** that control it remotely, all
from this repository:

| Product | Lives in | What it is | README |
|---|---|---|---|
| **CLI** (the main product) | `src/`, `tui/`, `web/`, `scripts/`, `bin/` | `niti` (Go TUI) + `niti-core` (Bun engine) + the web dashboard. | `tui/README.md` |
| **Desktop app** | `niti-app/` | The same product as an Electron + React app over the same engine. | `niti-app/README.md` |
| **Relay** (companion) | `niti-relay/` | Cloudflare Worker + Durable Objects (or Bun): email-code sign-in, forwards end-to-end encrypted frames between a Mac's core and a phone, sends pushes. Never sees content. | `niti-relay/README.md` |
| **Mobile app** (companion) | `niti-mobile/` | Expo, iOS-first remote control for a running core: watch, steer, approve, pause. All work still runs on the Mac. | `niti-mobile/README.md` |

Shared code is imported, never copied:

- `src/` is `niti-core`, the engine the CLI and the desktop app **both** run (the app bundles it via
  `niti-app/scripts/bundle-core.ts`).
- `src/remote/protocol.ts` is the wire protocol the core, the relay and the phone share.
- `niti-app/src/renderer/src/lib/` (reducer, types, humanize, identity, diff, format) and
  `niti-app/src/renderer/src/assets/avatars/` are imported by the phone.

(The archived v1 Ink TUI in `old-tech/`, a VS Code fork in `ide/` and an earlier Electron app in
`desktop/` were deleted in October 2026; none of them exists.)

# The docs

| File | Is | Update it when |
|---|---|---|
| `README.md` | The GitHub page, for users. | **Only when the user asks.** Don't edit it as a side effect of other work. |
| `project_context.md` | The universal README: the whole repo's architecture, engine, API, data, remote control, testing and history. | Anything structural changes: a new module, route, event, command, option, file on disk, product, or security property. |
| `tui/README.md`, `niti-app/README.md`, `niti-mobile/README.md`, `niti-relay/README.md` | Each product's own README: what it does, how to run and check it, its layout. | That product's features, keys, commands, run or check steps change. |
| `CLAUDE.md` (this) | The rules. | A rule changes or a new one is learned. |

A doc change belongs in the same commit as the change it describes. `README.md`,
`project_context.md` and `CLAUDE.md` count as the CLI for the commit rule below.

# Rules, in order of how easy they are to break by accident

1. **Never put changes to two products in one commit.** A mirrored change is two commits; the relay
   and the mobile app get their own commits too. Commit by explicit path: never `git add -A` at the
   repo root. If a file you need to edit already has uncommitted changes from another product, say
   so and ask; don't sweep them in. Check `git status` before you start, not after. Branch first
   when on `main`.
2. **Keep the CLI and the desktop app uniform.** They are the same product bundled differently, so a
   change on one side gets its matching change on the other. Fix or extend the engine itself rather
   than working around it in a client. Logic the app ported from the CLI moves in step with it: the
   graph physics in `web/graph.js` ⇄ `niti-app/.../features/graph/physics.ts`, the team builder in
   `tui/internal/wizard/picker.go` ⇄ `niti-app/.../setup/team.ts`, the test isolation env in
   `scripts/e2e/*` ⇄ `niti-app/scripts/fixture.ts`. Intentional differences stay (the app's own
   version line, its native features, each product's design tokens).
3. **Keep the phone in step with the desktop app.** It wears the desktop's design language exactly
   (tokens, Inter + JetBrains Mono, the shadcn variants, avatars, rail and transcript rows), so a
   design change on one gets its matching change on the other; `niti-mobile/src/lib/colors.test.ts`
   fails if the colour tokens drift. A change to `niti-app/src/renderer/src/lib/` or
   `src/remote/protocol.ts` is a change to the phone (and the relay): run their checks too.
4. **Never let one product's files into another's view of the project.** `niti-app`, `niti-relay` and
   `niti-mobile` are in the `IGNORE` set in `src/graph/filegraph.ts`, which bounds the `/graph` view
   and the project map in every agent's system prompt. Any other filter that lists project files
   must honour that set; `filegraph.test.ts` asserts it, so if you are about to make that test pass
   by editing the test, you have it backwards. IGNORE matches any path segment: only add names a
   user's own project won't use (`niti-app`, not `app`).
5. **Test cores never touch real state.** Every harness sets the isolation env (`NITI_AUTH_FILE`,
   `NITI_TRUST_FILE`, `NITI_REMOTE_FILE`, …) so a test never reads your keys or dials a real relay.
   A new harness, or a new file under `~/.config/niti/`, gets its env var in `scripts/e2e/*` and
   `niti-app/scripts/fixture.ts` both.
6. **Remote control's security holds.** Phones reach the core only through the bridge's route and
   command **allowlists** (`src/remote/bridge.ts`): add to them deliberately, never to anything that
   touches keys, auto-approve, settings, the team, `/remote` or allowing devices. Pairing stays
   commit-then-reveal; the relay forwards nothing but the pairing exchange between a Mac and a phone
   it hasn't allowed; pushes carry no code or commands. A protocol change bumps `PROTOCOL`.
7. **Measure agent-loop changes.** Before and after any change to the agent loop, its prompts or its
   tools, run `bun run scripts/eval/run.ts --repeat 3` and compare.
8. **Big trees.** `niti-app/node_modules` is ~630MB and `niti-app/release` holds packaged apps;
   `niti-mobile/` and `niti-relay/` have their own `node_modules`. Never point a directory walk at the
   repo root without a boundary.
9. **Commit messages carry no AI attribution** (no `Co-Authored-By: Claude` or similar).

# UI & design system rules

For the **desktop app (`niti-app/`), the web dashboard and the mobile app (`niti-mobile/`)**. The CLI's
UI is a Go/Bubbletea terminal app (`tui/`) with none of this in it.

- **Rule 0:** Any UI design work follows `~/.claude/rules/ui-design.md`: `ui-ux-pro-max` and
  `design-taste-frontend` for direction, the shadcn and Magic UI MCPs for components, Context7 for
  library docs. Here they refine and extend the graphite design language rather than replace it.
- **Rule 1 (desktop, web):** use `shadcn/ui` for every interactive component (`niti-app/components.json`;
  primitives in `niti-app/src/renderer/src/components/ui`). Check the shadcn MCP for an official
  primitive before building one; for animated or showcase elements, also check the Magic UI MCP.
- **Rule 2 (desktop, web):** never write raw Tailwind buttons, inputs or modals; use the shadcn
  equivalent. Magic UI adds flair on top of shadcn, never replaces it. Animate with `motion`.
- **Rule 3:** keep compound structures: a Card is `CardHeader` / `CardTitle` / `CardContent`, not
  arbitrary containers. The phone's `src/components/ui.tsx` mirrors the same variants and parts.
- **Rule 4:** semantic tokens only, never raw hex in components. Desktop: Tailwind variables from
  `niti-app/src/renderer/src/styles/globals.css` (the TUI's graphite / graphite light palettes).
  Phone: `niti-mobile/src/lib/colors.ts`, the same tokens. A new colour or palette change is proposed
  with its reason and lands as a token in `globals.css` (light and dark) and in `colors.ts`.
- **Rule 5:** icons are lucide only (`lucide-react`, `lucide-react-native` on the phone).
- **Rule 6 (phone):** every control reaches 44pt, motion stops under Reduce Motion, type runs two
  points above the desktop's; otherwise it matches the desktop.

# Checking

| What | Command |
|---|---|
| Engine and dashboard | `bun test ./src ./web` · `bun run typecheck` |
| The whole CLI end to end (core, remote path, CLI, TUI, real terminal, relay) | `zsh scripts/e2e/run.sh` |
| Go TUI | `cd tui && go build ./... && go vet ./... && go test ./...` |
| Desktop app (typecheck, tests, build, live, smoke, audit, perf) | `cd niti-app && npm run check` |
| Relay | `cd niti-relay && bun test && bunx tsc --noEmit` |
| Mobile | `cd niti-mobile && npm run typecheck && bun test ./src && npx expo export --platform ios` |
| Agent quality | `bun run scripts/eval/run.ts --repeat 3` |

All of it runs against the repo's scripted model (`scripts/e2e/fakellm.ts`): no network, no cost.
Verify both sides of a mirrored change. The user does visual verification of the apps; don't
screenshot them to check.
