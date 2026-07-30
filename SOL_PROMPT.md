# amux v2 — Build Prompt for GPT-5.6 Sol Pro

> **How to use this file:** Paste everything below the `---` as the first message to GPT-5.6 Sol Pro, with the `amux` repository attached/open. It is a complete, self-contained build brief. It assumes an *overhaul that reuses the working TypeScript core*, a *new Go + Bubbletea TUI*, and an *optional local web dashboard* — i.e. opencode's real client/server architecture. Hard requirements are marked MUST.

---

You are a staff-level engineer implementing a production release of **`amux`**, an open-source multi-agent AI coding CLI. You are working inside the existing Git repository (a Bun + TypeScript project). This is an **overhaul that reuses the working core**, not a greenfield rewrite. Read this entire brief before writing code. Where it says MUST, it is a hard requirement. Where it says SHOULD, use judgment but justify deviations in a code comment.

## 0. What amux is (the product in one paragraph)

`amux` lets a developer assign several different LLMs (from any provider, using their own API keys) to **custom roles** — e.g. "Frontend Designer" = Gemini, "Backend Engineer" = Claude, "UI Designer" = GPT — then pick one model as the **orchestrator** that plans the work, sequences it (decides the chronology), delegates each task to the right role, and lets the role-agents **talk directly to each other** while they build. The user watches the whole thing happen **live** in a rich terminal UI: one pane per agent, a live **communication graph** showing which agents are messaging which, streaming output, diffs of every file change, and usage/cost meters. An **optional local web dashboard** renders the same activity as a true interactive node graph in the browser. Provider/API-key/model handling must feel **exactly like [opencode](https://github.com/sst/opencode)**. Small quality-of-life features from opencode and Claude Code are table stakes (enumerated in §11).

**Reference walkthrough (build to make this work end-to-end):** The user runs `amux`, and on first run a wizard appears. They add three providers by pasting API keys, then assign: Gemini → "Frontend Designer", Claude → "Backend Engineer", GPT → "UI Designer". After each assignment the wizard asks "Assign another model to a role?" or "Start the project." They choose start, then pick Claude as the orchestrator ("the model that oversees everything and decides the chronology"). The session opens with panes for each agent. The user types: *"build me a clothing website for gen-z."* The orchestrator produces a plan: **UI design first**; the UI Designer's output is handed to the Frontend Designer (and, where relevant, the Backend Engineer); the Frontend and Backend agents then run and **message each other directly** to align on the API shape; finally the orchestrator integrates and summarizes. Every hand-off and message is drawn as an animated edge in the communication graph, and every file write shows up as an approvable diff.

## 1. Architecture — client/server, three surfaces

Build amux as **one TypeScript/Bun core exposed over a local API, with a Go TUI client and an optional web dashboard**. This mirrors opencode's real architecture and is the reason the language split exists.

```
  ┌─────────────────────────────┐        ┌──────────────────────────────┐
  │   Go + Bubbletea TUI        │        │  Web dashboard (optional)    │
  │  wizard · agent panes ·     │        │  localhost, true node graph  │
  │  comm-graph · diffs · usage │        │  (read-only mirror, v1)      │
  └───────────────┬─────────────┘        └───────────────┬──────────────┘
                  │  HTTP (commands)  +  SSE (event stream, one schema)  │
                  └───────────────────────┬───────────────────────────────┘
                                          ▼
  ┌───────────────────────────────────────────────────────────────────────┐
  │                     amux core  (Bun + TypeScript)                       │
  │  Local server (Bun.serve): REST commands + GET /events (SSE)            │
  │  ── Orchestrator (NEW: plan→schedule→delegate→collaborate→integrate)    │
  │  ── Inter-agent MessageBus (NEW)     ── Agent run loop (reuse+extend)   │
  │  ── Providers ×4 (REUSE)  ── Models.dev catalog (REUSE)                 │
  │  ── Tools sandbox + path jail (REUSE)  ── Lock registry (REUSE)         │
  │  ── Approval queue (REUSE)  ── Global auth store (NEW)  ── Usage (REUSE) │
  └───────────────────────────────────────────────────────────────────────┘
```

**Process model / entrypoint (MUST):** The `amux` command is the **Go binary**. On launch it spawns the Bun core as a child process (`bun run <core-server-entry>`), reads a one-line JSON **handshake** from the core's stdout (`{"amuxServer":{"url":"http://127.0.0.1:<port>","token":"<random>"}}`), connects to that URL, and owns the child's lifecycle (kill on exit, forward signals). The core binds to `127.0.0.1` on a random free port and requires the handshake `token` on every request (defense-in-depth for a local server). This is the same pattern opencode uses. Non-interactive modes (§10) run the core headless with no Go TUI.

## 2. Tech stack — hard constraints

**Core (reuse the runtime):**
- Bun ≥ 1.3, TypeScript in `strict` mode. No switch to Node/npm/pnpm; keep `bun` + `bun.lock`.
- Keep the existing provider SDKs: `@anthropic-ai/sdk`, `openai` (v7), `@google/genai`, `@napi-rs/keyring`, `yaml`.
- Add `zod` for schema validation at **every external boundary** (config files, orchestrator plan output, API request bodies, wizard-submitted config). No `any` at seams.
- Server = `Bun.serve`. Commands = JSON REST. Event stream = **Server-Sent Events** (`GET /events`). No new web framework; Bun's native routing is enough.
- Keep `scripts/gen-catalog.ts` and the committed `src/providers/catalog.generated.ts` (Models.dev). Do not fetch the catalog at runtime.

**TUI (new):**
- Go ≥ 1.22. Libraries: `bubbletea`, `lipgloss`, `bubbles`, `glamour` (markdown/diff rendering). HTTP+SSE via stdlib `net/http`. **No CGO.** Single static binary per platform.
- Truecolor with graceful degradation to 256/16/no-color; respect `NO_COLOR`.

**Web dashboard (new, optional):**
- A **self-contained** static page (HTML+JS+CSS) served by the core. **No external network at runtime** — vendor the graph library locally (e.g. a small force-directed graph lib such as vis-network or cytoscape.js, committed under `web/vendor/`, not a CDN link). Consumes `GET /events` (SSE).

**General:** No new heavyweight dependency without a one-line justification comment. Prefer stdlib. Keep the four working providers intact.

## 3. Directory structure (target)

```
amux/
├─ src/                         # Bun/TS core
│  ├─ server/                   # NEW — local API
│  │  ├─ server.ts              #   Bun.serve, routing, auth token, handshake line
│  │  ├─ events.ts              #   SSE hub: fan-out ServerEvent union to subscribers
│  │  └─ routes/                #   session, prompt, agents, providers, models, auth, approvals, diff
│  ├─ orchestrator/
│  │  ├─ orchestrator.ts        # REUSE core queue; extend for DAG scheduling
│  │  ├─ planner.ts             # NEW — orchestrator agent → validated task DAG (Plan)
│  │  ├─ scheduler.ts           # NEW — topological execution, concurrency, hand-offs, integrate step
│  │  ├─ runner.ts              # REWORK — replaces one-shot fan-out with plan→schedule→integrate
│  │  ├─ task.ts                # extend Task → TaskNode (dependsOn, role, handoffTo, acceptance)
│  │  └─ locks.ts               # REUSE
│  ├─ messaging/
│  │  └─ message-bus.ts         # NEW — typed AgentMessage routing between agents
│  ├─ agent/                    # REUSE + extend (inject inbound AgentMessages as turns)
│  ├─ providers/                # REUSE (4 clients + catalog + factory)
│  ├─ auth/
│  │  └─ auth-store.ts          # NEW — global ~/.config/amux/auth.json + keychain, typed creds, OAuth refresh
│  ├─ keystore/ tools/ mcp/ skills/ config/ events/ usage/ session/   # REUSE (config gains global layer)
│  └─ cli.ts                    # REWORK — headless/one-shot/resume + `bun run` server entry
├─ tui/                         # NEW — Go + Bubbletea client (compiles to the `amux` binary)
│  ├─ cmd/amux/main.go          #   entrypoint: spawn core, read handshake, run TUI
│  ├─ internal/api/             #   typed client for the core API + SSE decoder
│  ├─ internal/wizard/          #   onboarding wizard (screens in §5)
│  ├─ internal/session/         #   live view: panes, comm-graph, diff, usage, slash commands, approvals
│  └─ internal/theme/           #   palette, degradation, distinct per-agent colors (no 6-color cap)
├─ web/                         # NEW — optional dashboard (static, self-contained)
│  ├─ index.html · app.js · style.css
│  └─ vendor/                   #   committed graph lib, no CDN
├─ scripts/                     # gen-catalog.ts (keep) + build/packaging scripts
└─ package.json · bun.lock · tsconfig.json · go.mod
```

## 4. Provider / key / model handling — opencode parity (behavioral spec)

Match opencode's **behavior**, using amux's own internals. The existing `src/providers/*`, catalog, and factory already do most of this — extend, don't replace.

- **Global, typed auth store (NEW):** credentials live globally in `~/.config/amux/auth.json` (file mode `0600`) **and** the OS keychain (`@napi-rs/keyring`, keychain preferred when available, file as fallback + readable record). Credentials are typed: `{ type: "api", key } | { type: "oauth", access, refresh, expires } | { type: "local" }`. Persist and **auto-refresh** OAuth tokens (Copilot's device flow already exists in `src/providers/copilot.ts` — wire its tokens into this store instead of the current in-memory refresh). Keys are **global, not per-project** (like opencode).
- **CLI + wizard auth:** `amux auth login` (pick provider → choose method: paste API key / OAuth device flow / local endpoint → **validate** with a cheap ping before saving), `amux auth list`, `amux auth logout <provider>`. The wizard (§5) drives the same code paths.
- **Provider registry:** from the committed Models.dev catalog (`CATALOG` in `src/providers/catalog.ts`). Support BYOK, OpenAI-compatible providers, arbitrary **custom baseURL**, **local** (Ollama/LM Studio, key-optional), and **login** (OAuth) providers — all categories already modeled in the catalog.
- **Model identifiers:** use a single **`provider/model`** string as the canonical id everywhere in the API, wizard, config, and TUI (parse into the existing separate `provider`/`model` fields internally). `/models` switcher in the TUI changes the model of the focused agent **live and persists it** to `.amux/agents.yaml` (the current selector mutates in-memory only — fix that).
- **Per-model metadata:** surface Models.dev pricing + context window per model where available for the usage/cost view; fall back to the current per-provider approximation.

## 5. Onboarding wizard — the headline UX (exact screens)

Lives in the Go TUI (`tui/internal/wizard`), calls core API endpoints for provider lists, key validation, and saving config. **Triggers automatically on first run** (no `.amux/agents.yaml` present) and via `amux init`. Each screen is keyboard-navigable, searchable where a list is long, and cancel-safe (Esc backs up a step; Ctrl-C exits cleanly).

1. **Welcome** — one screen: what amux does, "press enter to begin."
2. **Add credentials** (loops, opencode-style):
   - Searchable provider list (from `GET /providers`, grouped by category: BYOK / local / login).
   - Choose method: **paste API key** (masked input) · **OAuth login** (render device-code + verification URL, poll) · **local endpoint** (enter baseURL).
   - **Validate before saving** (`POST /auth` pings the provider); on failure show a friendly, specific error and let them retry. On success, "✓ saved."
   - Then: **"Add another provider"** or **"Continue to roles."**
3. **Assign models to roles** (loops — this is the core of the wizard):
   - Pick a model (`provider/model`, from providers that now have credentials).
   - Enter a **free-text role name** (e.g. "Frontend Designer").
   - Optional: a one-line role description (becomes part of the system prompt) and an **allowed-tools** multi-select (`read_file`, `write_file`, `shell`).
   - After each assignment: **"Assign another model to a role"** or **"Start the project."**
4. **Pick the orchestrator** (on "Start the project"): choose which assigned agent is the **orchestrator/lead** — labeled clearly as "the model that oversees everything and decides the chronology of work." (Also allow picking a not-yet-assigned model here.)
5. **Persist + launch:** write `.amux/agents.yaml` (agents + `lead: true` on the orchestrator; keys are NOT written to yaml — they live in the global auth store), then enter the live session.

The wizard MUST be re-runnable to edit roles later (`amux init` or a `/agents` command in-session) without wiping credentials.

## 6. Orchestration — chronology, supervision, integration (the core intelligence)

Replace the one-shot flat fan-out in `src/orchestrator/runner.ts` with a **plan → schedule → delegate → collaborate → integrate** loop driven by the orchestrator agent. Model tasks as a **DAG**, not a flat list.

1. **Plan (`planner.ts`):** the orchestrator agent receives the user goal, the roster of roles, and each role's description, and returns a **typed plan**: a list of task nodes with `id`, `description`, `role` (which assigned role should own it), `dependsOn: string[]`, optional `handoffTo: string[]` (roles that receive this task's output), and `acceptance` (a short done-criterion). Output MUST be validated with zod; on invalid/empty output, retry up to 3× with a corrective message, then fall back to a single task = the whole prompt (never crash). The planner's system prompt MUST instruct it to sequence work by dependency (e.g. UI/design tasks before the frontend that consumes them) and to set `handoffTo` so outputs flow to the right downstream roles.
2. **Schedule (`scheduler.ts`):** execute the DAG respecting `dependsOn` (topological order), running independent ready tasks **concurrently** on their assigned role-agents, gated by the existing `LockRegistry` for file/shell safety. Detect and reject cycles up front with a clear error. Reuse the existing `Orchestrator` queue/claim/complete/requeue + failover (429/529 → backoff → reassign, `MAX_ATTEMPTS`) machinery underneath.
3. **Delegate:** each task runs on its role-agent via the existing `Agent` run loop (`src/agent/agent.ts`).
4. **Collaborate:** when a task has `handoffTo`, the producing agent's output is delivered to the downstream agents **as an inter-agent message** (§7), and downstream agents may **message each other directly** to align (the frontend↔backend case). The orchestrator can observe, route, and inject.
5. **Integrate:** after dependent tasks complete, the orchestrator reviews outputs, MAY create follow-up tasks (re-plan — feed results back into a new planning turn, bounded by a max re-plan depth), and produces a final compiled summary emitted to the event stream.

Emit orchestration lifecycle events (plan created, task ready/started/done/failed, re-plan, integrate, complete) so both the TUI and dashboard can render DAG progress and an overall completion percentage.

## 7. Inter-agent communication protocol (agents talk to each other)

Add a **first-class messaging channel** distinct from the existing UI-telemetry `Bus` (keep that for agent→UI streaming; add this for agent↔agent).

```ts
type MessageKind = "handoff" | "question" | "answer" | "artifact" | "review" | "broadcast";
interface AgentMessage {
  id: string;
  from: string;              // agent id (or "orchestrator")
  to: string | "*";          // agent id, or "*" for broadcast
  kind: MessageKind;
  subject: string;
  body: string;
  refs?: string[];           // file paths / task ids / prior message ids
  time: number;              // epoch ms
}
```

- **`messaging/message-bus.ts` (NEW):** routes `AgentMessage`s between agents. The orchestrator authorizes which edges are allowed per the DAG (e.g. it opens a frontend↔backend channel for a shared task); unsolicited messages to unauthorized peers are dropped and logged.
- **Delivery into context:** a received message is injected into the recipient agent's turn list as a user-role turn tagged with the sender and kind, so the model naturally reads and can reply. Replies go back through the bus.
- **Loop/rate safety (MUST):** cap message depth and per-pair rate to prevent two agents ping-ponging forever; on cap, notify the orchestrator to intervene.
- **Visualization:** every `AgentMessage` is also published to the event stream so the TUI comm-graph and the web dashboard animate the edge in real time.

## 8. The local API — the TS↔Go seam (contract)

The core exposes a small, versioned HTTP API. Every request carries the handshake `token` (header `Authorization: Bearer <token>`). Define request/response bodies with zod and generate matching Go structs (or hand-write and keep in sync; document the source of truth). Suggested surface:

- `POST /session` → start/attach a session (returns session id, current agents, DAG state).
- `GET /events` → **SSE stream** of the `ServerEvent` discriminated union (below) — the single channel the TUI and dashboard both consume.
- `POST /prompt` `{ text }` → submit the user goal (kicks off plan→schedule).
- `GET /providers` · `GET /models?provider=` → catalog for the wizard/switcher.
- `POST /auth` `{ provider, method, ...creds }` → validate + save to the global auth store.
- `GET /agents` · `PUT /agents` → read/update role assignments (also used by the wizard).
- `POST /model` `{ agentId, model }` → live switch + persist.
- `POST /approvals/:id` `{ ok, scope? }` → answer an approval (single or batch).
- `GET /diff?path=` → unified diff for a changed file (for the diff viewer).
- `POST /cancel` → graceful cancel of the running session (persist state).

**`ServerEvent` (SSE union — the contract):** a discriminated union over: `agent_event` (wraps the existing `AgentEvent`: thought/tool_call/file_edit/delta/message/failover/warning/done/error), `agent_message` (§7), `orchestration` (plan/schedule/task-state/integrate/complete + completion %), `usage` (per-agent tokens + cost), `approval_request` (single/batch), `lock` (held locks), `session` (started/ended/cancelled). Include a monotonically increasing `seq` and a `time` on every event so late-joining clients (the web dashboard) can request a replay from `seq` and stay consistent.

## 9. Go + Bubbletea TUI — the live visual client

- **Responsive layout (MUST):** a grid of agent panes that reflows to terminal width (fix the current fixed-44-wide single row). Each pane: avatar + role + `provider/model`, status, streaming output (last N lines), current tool, a token/context meter. **Focus/zoom** a pane (Enter) to see full history + that agent's diffs and its message log.
- **Communication graph panel (the headline visual):** nodes for each agent + the orchestrator; **animated directed edges** when an `agent_message` flows, colored by `MessageKind`; a scrolling message log beneath. Box-art/lipgloss rendering; must stay legible at small sizes.
- **Diff viewer:** on `file_edit`/write approvals, render a unified diff (glamour/lipgloss) with inline **approve / reject** (single and batched, like the current approval queue). Never auto-write gated tools without approval unless the agent's `autoApprove` covers it; dangerous shell patterns always force-ask (reuse `isDangerousShellCall`).
- **Usage view:** per-agent sparklines + bars, token totals, and a **cost estimate** from Models.dev pricing.
- **Loading indicators (MUST):** per-agent spinners while a turn is streaming, plus a **global progress bar** tied to DAG completion %.
- **Slash commands + autocomplete:** `/model` `/models` `/agents` `/plan` `/graph` `/usage` `/diff` `/approve` `/skills` `/mcp` `/compact` `/clear` `/new` `/resume` `/dashboard` `/help` `/exit`. Live-filter dropdown (the current TUI already has this UX — match it).
- **Keybindings:** Tab/arrows move pane focus, `/` opens commands, Enter zooms a pane, Esc backs out, Ctrl-C quits (graceful cancel + persist). Document them in `/help`.
- **Degradation:** truecolor → 256 → 16 → `NO_COLOR`; generate **distinct** per-agent colors for arbitrary agent counts (remove the 6-color cap). Handle terminal resize.

## 10. Optional web dashboard

- Opened via `amux --web` (headless-friendly) or the in-TUI `/dashboard` command, which prints/opens a `http://127.0.0.1:<port>/dashboard` URL served by the core.
- Static, self-contained page consuming `GET /events` (SSE) with `seq`-based replay so it can join mid-session and backfill. Renders a **true interactive force-directed node graph** (agents + orchestrator + live messages), a timeline, per-agent detail, diffs, and usage charts. **Read-only mirror in v1** (no editing, no prompt submission from the browser). Bound to localhost only; the handshake token gates access. Vendored graph lib — **no external network at runtime**.

## 11. Inherited features (opencode + Claude Code) — table stakes

Implement/retain all of these; several already exist in the repo (marked ✓ reuse):
- Streaming responses + loading/spinner indicators ✓, global progress bar (new).
- Live model switching, **persisted** (fix current in-memory-only behavior).
- Session persistence + `amux resume` ✓ (extend to restore DAG + message history, not just tasks).
- **Checkpoint / undo** of file changes (snapshot before writes; `/undo`) — new.
- Permission modes: interactive approval ✓, per-agent `autoApprove` allow-lists ✓, dangerous-pattern force-ask ✓.
- MCP (stdio) server support ✓; skills from `.amux/skills/*/SKILL.md` ✓.
- Custom slash commands (project-defined) — new, opencode-style.
- Global + project config layering (global `~/.config/amux/`, project `.amux/`) — extend current per-project-only config.
- Cost/token tracking ✓ (add dollar estimates from Models.dev pricing).
- Context-window warnings (85%) + auto-compaction (95%) ✓.
- Root-sandbox path jail ✓ + shell-safe `spawn` (array args) ✓; respect `.gitignore` for context.
- BYOK multi-provider ✓, OpenAI-compatible + custom endpoints ✓, OAuth device flow (Copilot) ✓.
- Markdown rendering in output/diffs (glamour) — new in Go TUI.
- Graceful non-TTY / pipe / CI mode (headless core, plain stdout) ✓ extend; `--help` / `--version`.
- One-shot mode: `amux "<prompt>"` runs headless to completion and prints a summary ✓.

## 12. Input/output contracts (types)

**Reuse these existing contracts unchanged where possible** (`src/providers/provider.ts`, `src/orchestrator/task.ts`, `src/events/bus.ts`): `Provider.send(sysPrompt, turns, tools, onDelta)`, `Turn`, `ToolSpec/ToolCall/ToolResult`, `ProviderReply/Usage/RateLimit`, `AgentEvent/EventType`, `Orchestrator` queue API, `ApprovalQueue`. **Add** (all zod-validated at boundaries):

```ts
interface TaskNode extends Task {           // extends existing Task
  role: string;                              // assigned role/agent id
  dependsOn: string[];
  handoffTo?: string[];                      // roles that receive this task's output
  acceptance?: string;
}
interface Plan { goal: string; tasks: TaskNode[]; }         // orchestrator output, zod-validated
interface RoleAssignment { agentId: string; provider: string; model: string; role: string;
  description?: string; allowedTools: string[]; lead?: boolean; }
type AuthCredential =
  | { provider: string; type: "api"; key: string }
  | { provider: string; type: "oauth"; access: string; refresh?: string; expires?: number }
  | { provider: string; type: "local"; baseURL: string };
interface WizardState { credentials: AuthCredential[]; roles: RoleAssignment[]; orchestrator?: string; }
// AgentMessage — see §7.  ServerEvent (SSE discriminated union) — see §8.
```

Keep `.amux/agents.yaml` as the persisted project config (now written by the wizard); keep `.amux/session.json` for resumable state (extend to include the plan/DAG and message log).

## 13. Edge cases — MUST handle (do not crash on any of these)

Missing/invalid API key (validate in wizard, specific error, retry) · OAuth token expiry → silent refresh, re-login prompt on hard failure · provider 429/529/quota → backoff + failover to another capable role · context overflow → compact · orchestrator returns invalid/empty plan JSON → retry 3× then single-task fallback · DAG cycle → reject with the offending edge named · a role has no assigned model → block "Start the project" with a clear message · two agents writing the same file → lock (already handled) · dangerous shell command → force approval even under standing grants · agent-to-agent message loop → depth/rate cap + orchestrator intervention · terminal resize / very narrow / no-color · > 6 agents → distinct generated colors, no collision · web-dashboard/core port already in use → pick another, report it · Go TUI can't reach core (spawn failed / handshake timeout) → retry with backoff, then a clear fatal error · Ctrl-C mid-run → graceful cancel, persist session, kill child core · Models.dev fetch fails at `gen:catalog` time → keep the committed catalog · custom baseURL unreachable → surface the connection error, don't hang · keychain unavailable → fall back to `auth.json` (0600).

## 14. Definition of done / acceptance

Ship in **runnable phases**, each independently testable, in this order: (A) core server + SSE + auth store; (B) orchestrator DAG + inter-agent messaging (verifiable headless via API); (C) Go wizard; (D) Go live session view (panes/comm-graph/diffs/usage); (E) web dashboard. Acceptance:

- `amux` on a repo with no config launches the wizard; pasted keys **validate and persist globally**; roles are assigned; an orchestrator is chosen; `.amux/agents.yaml` is written (no keys in it).
- Submitting the reference prompt produces a **DAG plan** (not a flat list); tasks run **concurrently where independent**; at least one **direct agent-to-agent message** is exchanged and is **visible as an animated edge** in both the TUI comm-graph and the web dashboard.
- Every file write appears as an **approvable diff**; dangerous shell forces a prompt.
- `/model` switches a live agent's model and it **persists** across restart; `amux resume` restores tasks + DAG + message history.
- `amux --web` serves a self-contained localhost dashboard that mirrors the live session with no external network calls.
- **Tests:** keep and extend the existing `bun test` suite (there are `*.test.ts` across providers, orchestrator, tools, config, keystore, approval, usage, TUI). Add tests for: DAG scheduling + topological order + cycle rejection, message-bus routing + loop cap, plan zod validation + fallback, auth-store read/write/refresh, the SSE event union, and wizard state transitions. Add Go tests (`go test`) for the API client, SSE decoder, and comm-graph layout. `bun test` and `go test` both green; `tsc --noEmit` and `go vet` clean.

## 15. Non-goals (v1)

No hosted/cloud/multi-user mode · no browser-based editing or prompting (dashboard is read-only) · do **not** rewrite the 4 working providers or swap the Models.dev catalog source · no package-manager change · no telemetry/analytics · no auth on the local server beyond localhost binding + handshake token · no plugin system.

## 16. Working style (how to build this)

- **Reuse before writing.** The modules in §0/§3 marked REUSE are working — extend them, don't reimplement. Read a module and its test before changing it.
- **Strict types, zod at every boundary**, no `any` at the TS↔Go seam or at file/plan/API inputs.
- **Small, reviewable, phased diffs** (§14 A→E); each phase must run and have a test before moving on.
- **Match existing code style** (naming, comment density, file layout) in `src/`.
- When you deliberately cut a corner with a known ceiling, leave a one-line comment naming the ceiling and the upgrade path. When something is stubbed, say so in the PR/summary — never present skipped work as done.

Deliver working software: a developer clones the repo, runs the documented install, types `amux`, completes the wizard, submits a prompt, and **watches multiple models plan, build, and talk to each other live**. That experience is the product — optimize everything toward it.
