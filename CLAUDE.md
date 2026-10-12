# One product, two packagings — keep them uniform

niti ships **one product in two packagings** from this repository:

| Product | Lives in | What it is |
|---|---|---|
| **CLI** | `src/`, `tui/`, `web/`, `scripts/`, `bin/` | `niti` (Go TUI) + `niti-core` (Bun engine). **The main product.** |
| **Desktop app** | `niti-app/` | The same product as an Electron + React app over the same engine — see `niti-app/README.md`. |

`old-tech/` is the archived v1 Ink TUI. Dead, kept for reference, part of nothing. (A VS Code fork
in `ide/` and an earlier Electron app in `desktop/` were deleted in October 2026; neither exists.)

**Rules, in order of how easy they are to break by accident:**

1. **Never put changes to two products in one commit** — a mirrored change is two commits. If a file you need to edit already has
   uncommitted changes belonging to the other product, say so and ask — do not sweep them in. Check
   `git status` before you start, not after.
2. **Keep the two uniform.** They are the same product bundled differently, so a change on one side
   gets its matching change on the other. `src/` is `niti-core`, the engine **both** run (the app
   bundles it via `niti-app/scripts/bundle-core.ts`): fix or extend the engine itself rather than
   working around it in the app. Logic the app ported from the CLI moves in step with it — e.g. the
   graph physics in `web/graph.js` ⇄ `niti-app/src/renderer/src/features/graph/physics.ts`, the team
   builder in `tui/internal/wizard/picker.go` ⇄ `niti-app/.../setup/team.ts`, and the test isolation
   env in `scripts/e2e/*` ⇄ `niti-app/scripts/fixture.ts`. Verify both sides: `zsh scripts/e2e/run.sh`
   and `cd niti-app && npm run check`. Intentional differences stay (the app's own version line,
   its native features, each product's design tokens).
3. **Never let one product's files into another's view of the project.** `niti-app/` and
   `old-tech/` are in the `IGNORE` set in `src/graph/filegraph.ts`, which bounds both the `/graph`
   view and the project map injected into every agent's system prompt. A filter added anywhere else
   that lists project files must honour that same set — `filegraph.test.ts` asserts it, so if you
   are about to make that test pass by editing the test, you have it backwards. IGNORE matches any
   path segment, so only add names a user's own project won't use (`niti-app`, not `app`).
4. **`niti-app/node_modules` is ~630MB and `niti-app/release` holds packaged apps.** Never
   `git add -A` at the repo root. Never point a directory walk at the repo root without a boundary.

# UI & Design System Rules

These apply to the **desktop app (`niti-app/`) and the web dashboard only** — the CLI's UI is a
Go/Bubbletea terminal app (`tui/`) with none of this in it.

- We use `shadcn/ui` for all interactive components (`niti-app/components.json`; primitives in
  `niti-app/src/renderer/src/components/ui`).
- **Rule 0:** Any UI design work follows the design workflow in `~/.claude/rules/ui-design.md`:
  `ui-ux-pro-max` and `design-taste-frontend` for direction, the shadcn and Magic UI MCPs for
  components, Context7 for library docs. Here they refine and extend the Studio design
  language rather than replace it.
- **Rule 1:** Before creating a custom UI element, use the shadcn MCP to check if an official primitive exists (e.g., Button, Card, Dialog, Sheet, Sidebar). For animated or showcase elements (backgrounds, text effects, marquees, special buttons), also check the Magic UI MCP.
- **Rule 2:** Never write raw Tailwind buttons, inputs, or modals from scratch. Always install and use the shadcn equivalent. Magic UI components are allowed for visual flair on top of shadcn primitives, never as a replacement for them. Animate with `motion`.
- **Rule 3:** Maintain compound component structures. If using a Card, use `CardHeader`, `CardTitle`, and `CardContent` rather than arbitrary `div`s.
- **Rule 4:** Use our Tailwind semantic variables (e.g., `bg-primary`, `text-muted-foreground`), never raw hex codes in components, including inside Magic UI components (restyle them to the tokens). The tokens live in `niti-app/src/renderer/src/styles/globals.css` (the app's Studio palette, light and dark). The palette may evolve: a new color or a palette change is proposed with its reason and lands as a semantic variable in `globals.css`, in both light and dark.
- **Rule 5:** Only use `lucide-react` for icons.

# Checking the desktop app

`cd niti-app && npm run check` — typecheck, unit tests, build, the live client check against a real
core (`scripts/live.ts`) and the Electron smoke run (`scripts/smoke.ts`), all against the repo's fake
model. The user does visual verification; don't screenshot the app to check it.
