# Three products in one tree — do not mix them

niti ships **three separate products** from this repository:

| Product | Lives in | What it is |
|---|---|---|
| **CLI** | `src/`, `tui/`, `web/`, `scripts/`, `bin/` | `niti` (Go TUI) + `niti-core` (Bun engine). **The main product.** |
| **IDE** | `ide/` | A VS Code/VSCodium-based editor build. Its own app. |
| **Desktop app** | `desktop/` | An Electron app. Its own app. |

`old-tech/` is the archived v1 Ink TUI. Dead, kept for reference, part of nothing.

**Rules, in order of how easy they are to break by accident:**

1. **Never put changes to two products in one commit.** If a file you need to edit already has
   uncommitted changes belonging to another product, say so and ask — do not sweep them in. Check
   `git status` before you start, not after.
2. **Ask which product you are working on** if the request doesn't make it obvious. Most requests
   are about the CLI. Do not assume a change to `src/` is automatically CLI-only: `src/` is
   `niti-core`, the engine **all three** products share, so a change there can reach the IDE and the
   desktop app.
3. **Never let one product's files into another's view of the project.** `ide/`, `desktop/` and
   `old-tech/` are in the `IGNORE` set in `src/graph/filegraph.ts`, which bounds both the `/graph`
   view and the project map injected into every agent's system prompt. A filter added anywhere else
   that lists project files must honour that same set — `filegraph.test.ts` asserts it, so if you
   are about to make that test pass by editing the test, you have it backwards.
4. **`ide/` is ~12GB and `desktop/` is ~670MB.** Never `git add -A` at the repo root. Never point a
   directory walk at the repo root without a boundary — it will spend its entire budget inside
   `ide/vscodium` and never reach `src/`. This has already happened twice.

# UI & Design System Rules

These apply to the **desktop app and web dashboard only** — the CLI's UI is a Go/Bubbletea terminal
app (`tui/`) with none of this in it.

- We use `shadcn/ui` for all interactive components.
- **Rule 1:** Before creating a custom UI element, use the shadcn MCP to check if an official primitive exists (e.g., Button, Card, Dialog, Sheet, Sidebar).
- **Rule 2:** Never write raw Tailwind buttons, inputs, or modals from scratch. Always install and use the shadcn equivalent.
- **Rule 3:** Maintain compound component structures. If using a Card, use `CardHeader`, `CardTitle`, and `CardContent` rather than arbitrary `div`s.
- **Rule 4:** Stick to the established theme. Do not introduce random hex codes; use our Tailwind semantic variables (e.g., `bg-primary`, `text-muted-foreground`).
- **Rule 5:** Only use `lucide-react` for icons.
