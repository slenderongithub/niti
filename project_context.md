# Project Context: niti

`niti` runs **multiple AI coding agents from different LLM providers concurrently** on one project.
You assign models to custom roles, pick one as the **orchestrator** (plans a task DAG and sequences
it), and the role-agents build together — **talking directly to each other** to align — while you
watch live in a terminal (and an optional web dashboard).

This file is the single merged source of project history/architecture context, replacing
`BUILD_STATUS.md` and `OPENCODE_PARITY_PLAN.md` (both folded in below, then deleted).

---

## Two front ends, one core

- **`niti`** — the Go + Bubbletea terminal UI (`tui/`), the primary interactive front end. It spawns
  the Bun core as a subprocess and drives it over a local HTTP+SSE API. Build: `bun run build:tui`.
- **`niti-core`** — the headless Bun/TypeScript engine + scripting CLI (`src/cli.ts`). Used
  standalone for one-shot/CI runs, `serve`, `auth`, `init`, `--web`, and it's what `niti` spawns.
  Build: `bun run build`.
- **`old-tech/ink-tui/`** — the original React/Ink interactive TUI (niti v1). Archived, not deleted,
  not wired into the active build — `src/cli.ts` no longer imports or renders it. Has its own
  `package.json`/`tsconfig.json` so it doesn't affect the root project's deps or `tsc`/`bun test`.

## Architecture (as built)

```
       Go + Bubbletea TUI (niti)   Web dashboard (--web)   Electron desktop app (desktop/)
        team picker · panes · graph   localhost force-graph   embedded panels, file:// renderer
                              └──────────── HTTP + SSE (src/server) ────────────┘
                                                  ▼
                                    Engine (src/engine.ts)
   loadAgents (.niti/agents.yaml) ──▶ makeProvider (auth store) ──▶ Agent[] (+ Messenger)
                                                  │
   orchestrator ──plan (DAG)──▶ scheduler (src/orchestrator) ◀──concurrent claim──┤
                        │                    │
                  MessageBus (agent ↔ agent)  AgentEvent stream ──▶ EventHub ──▶ SSE
```

### Core architectural concepts

1. **Concurrency & synchronization** — the `Orchestrator` (`src/orchestrator/orchestrator.ts`) is a
   single-threaded in-memory task queue; `claimTask` is synchronous/atomic under Bun's event loop.
   Concurrent writes and shell calls are synchronized via `LockRegistry` (`src/orchestrator/locks.ts`)
   — file writes lock per relative path, shell calls lock a global `*shell*` mutex, stale locks expire
   after 60s.
2. **Orchestration is a DAG, not a flat queue** — the lead agent turns a goal into a validated task
   **DAG** (dependencies + hand-offs) via `planner.ts` (zod-validated, retry, robust JSON extraction,
   ambiguous-id dependencies dropped rather than guessed at); `scheduler.ts` runs independent tasks
   concurrently in topological order, delivers each task's output to its dependents/hand-off
   recipients, and the lead reviews + summarizes at the end.
3. **Failover & token safeguards** — rate limits (429/529/503), context exhaustion, or account quota
   depletion requeue the task with backoff (`attempts * 500ms`, capped at 3000ms) and same-agent
   exclusion; permanently failed after `MAX_ATTEMPTS = 3`. Context warnings fire at 85% depth;
   `compactTurns()` (`src/agent/context.ts`) summarizes older turns at 95%, walking the cut point back
   so it never starts on an orphaned `tool` turn (a bug found and fixed during review — see below).
4. **Security boundary & approval gates** — `write_file`/`edit`/`shell` gate through `ApprovalQueue`
   in interactive mode, resolved through a **wildcard permission hierarchy**
   (`src/permissions.ts`: session grant → agent's own `permissions:` → project `permissions:` →
   default-ask; most-specific pattern wins). Destructive shell patterns (`rm -rf`, `git reset --hard`,
   `git push --force`, `drop table`, fork bombs) always force a prompt regardless of any `allow` rule
   or `--auto`. File access is jailed via `safePath` prefix validation; shell exec uses `spawn` with
   array arguments (no shell string → no injection).
5. **Provider abstraction & keychain storage** — one `Provider` interface; native clients for
   Anthropic/Gemini, one OpenAI-compatible client covering a curated 29 providers / 152 models via the Models.dev catalog
   (`src/providers/catalog.ts` + generated `catalog.generated.ts`). Keys come from the OS keychain
   (`@napi-rs/keyring`) with env-var fallback, or GitHub Copilot's OAuth device-code flow.
6. **Agent-to-agent messaging (niti's differentiator)** — agents `send_message`/`ask_agent` any
   teammate directly mid-task, routed through `MessageBus` (`src/messaging/message-bus.ts`).
   Deliberately **open**, not DAG-edge-restricted (the planner can't anticipate every mid-task
   question) — a per-pair rate cap is the loop guard instead.
7. **Persistence** — every turn decomposes into `sessions → messages → parts` in SQLite at
   `.niti/niti.db` (`src/store/`), so conversations survive a restart (`niti resume`/`/resume`
   reseed history). Each file write is checkpointed first (`checkpoints` table), which is what
   `/undo` reverts (LIFO, one write per call). Tasks separately auto-save to `.niti/session.json`
   (unchanged since v1) — a session is a child concept a task *has*, not a replacement for the DAG.
8. **LSP + MCP together** — two independent tool sources merged into the same `buildTools()`
   concatenation in `agent.ts`, neither replacing the other. LSP (`src/lsp/`) spawns
   user-installed language servers over hand-rolled JSON-RPC (no tree-sitter — niti has no
   syntax-highlighting UI surface to justify it) and exposes `diagnostics(path)`/`hover(path,line,col)`.
   MCP (`src/mcp/mcp.ts`) namespaces external stdio server tools as `mcp__<server>__<tool>`. A missing
   server of either kind is a message, never a crash.
9. **Sub-agent forking** — `spawn_fork` runs a child loop (`Agent.fork()`) on the same provider,
   tools, and permissions (no privilege escalation) — a new *session* (`kind:'fork'`), invisible to
   the DAG scheduler, capped by `MAX_FORK_DEPTH`.
10. **File watching** — `src/watch.ts` (`node:fs.watch({recursive:true})`, no `chokidar`) announces
    edits made outside niti as `external_change` events; a short-TTL set of the engine's own recent
    write paths stops an agent's own `write_file` from re-triggering itself.

---

## Key file map

| File | Responsibility |
|---|---|
| `src/cli.ts` | Scripting entry point: one-shot, `serve`, `auth login/list/logout`, `init`, `resume`, `--web`, `--auto` |
| `src/config/config.ts` | Parses/validates `.niti/agents.yaml`: agents, `permissions:`, `lsp:`, `mcpServers:`, top-level options (`loadOptions`/`loadInstructions`), `saveAgents()` (replaces only the `agents:` key so hand-written config survives a picker relaunch) |
| `src/permissions.ts` | Wildcard pattern resolver (`resolve()`), `Bun.Glob`-based, layered session→agent→project→default-ask |
| `src/engine.ts` | Wires agents + orchestrator + messaging + approvals + usage + locks + store + watcher into one `EventHub`; `submit()`/`resume()`/`undo()`/`switchModel()` |
| `src/agent/agent.ts` | Multi-turn tool loop (read-only calls in a turn run concurrently), `send_message`/`ask_agent`/`spawn_fork`, approval + quota checks, checkpoint-before-write, `maxTurns` override, verification pass before a changed task may report done |
| `src/agent/verify.ts` | `detectChecks()` (package.json typecheck/build script, `go build`, `cargo check`) + `runChecks()`; overridden by `verify:` in agents.yaml |
| `src/agent/context.ts` | `compactTurns()` — summarizes older turns near the context ceiling |
| `src/orchestrator/planner.ts`, `scheduler.ts`, `runner.ts`, `orchestrator.ts`, `locks.ts`, `task.ts` | Goal→DAG planning, concurrent topological execution, the shared task queue, the lock registry |
| `src/messaging/message-bus.ts` | Cross-provider agent↔agent channel: `post`/`announce`/`authorize`/`drain`, per-pair rate cap |
| `src/providers/*` | `Provider` interface; `anthropic.ts`/`gemini.ts`/`openai.ts`/`copilot.ts` clients; `catalog.ts` (+ generated) provider metadata; `pricing.ts` cost table; `factory.ts` instantiation |
| `src/tools/tools.ts` | Sandboxed `read_file`/`write_file`/`edit`/`shell` + read-only `grep`/`glob`/`list_dir`, `safePath()` jail; line-numbered paged reads; `edit` requires a unique match but recovers from pasted line numbers and indentation drift (`resolveEdit`) |
| `scripts/eval/` | Harness benchmark: 6 fixture tasks (navigate/edit/verify/restraint) scored on what lands on disk — run before and after any loop or tool change |
| `src/tools/lsp-tools.ts`, `src/lsp/client.ts`, `src/lsp/registry.ts` | `diagnostics`/`hover` tools over hand-rolled LSP JSON-RPC |
| `src/mcp/mcp.ts` | MCP subprocess manager, `mcp__<server>__<tool>` namespacing |
| `src/store/db.ts`, `src/store/session-store.ts` | SQLite (WAL) open/migrate; `SessionStore` — sessions/messages/parts, checkpoint/undo, `listSessions`, `recordMessage` |
| `src/approval.ts` | `ApprovalQueue` — scope grants, batch dialogs, dangerous-pattern override |
| `src/usage.ts`, `src/providers/pricing.ts` | Per-agent token/rate-limit tracking; per-model cost |
| `src/session.ts` | `saveTasks`/`loadTasks` (`.niti/session.json`), `resumeConversation()` |
| `src/watch.ts` | External-edit file watcher, self-write suppression |
| `src/skills/skills.ts` | `.niti/skills/*/SKILL.md` frontmatter → system-prompt addendum |
| `src/commands/registry.ts` | Server-side slash-command registry, shared by the TUI and the web dashboard; user commands from `.niti/commands/*.md` |
| `src/server/server.ts`, `src/server/events.ts`, `src/server/main.ts` | HTTP+SSE API, `EventHub`, headless-core bootstrap + handshake line |
| `src/auth/auth-store.ts`, `src/keystore/keystore.ts` | Global typed credential store (`~/.config/niti/auth.json` 0600 + OS keychain), env-var fallback |
| `tui/cmd/niti/main.go` | Spawns/attaches to the core, reads its handshake, runs the picker then the live session |
| `tui/internal/wizard/{picker,chrome}.go` | Every-launch team picker (size → provider → model → name → description, whole catalog, centered card UI) |
| `tui/internal/session/{session,view,carousel}.go` | Live multi-agent view: panes/graph/usage, approvals, `ctrl+p` model carousel, `/` command menu |
| `tui/internal/ui/list.go` | Shared filterable list + centered-box + overlay widgets used by both the picker and the session view |
| `tui/internal/api/client.go` | Typed HTTP+SSE client mirroring the server's JSON contract |
| `tui/internal/theme/theme.go` | Color palettes, avatars, theme cycling |

---

## Data models / schemas

### `.niti/agents.yaml`

```yaml
agents:
  - id: string               # required, unique
    provider: string         # required, catalog key
    model: string            # required
    role: string              # required, display title
    systemPrompt: string     # required
    allowedTools: string[]   # optional
    lead: boolean            # optional — decomposes the goal into tasks
    baseURL: string          # optional — custom/OpenAI-compatible endpoint
    autoApprove: string[]    # optional — tools pre-granted for this agent
    permissions: {tool: {pattern: allow|ask|deny}}   # optional, per-agent override

permissions: {tool: {pattern: allow|ask|deny}}        # optional, project default
lsp: {name: {command, args?, extensions}}             # optional language servers
mcpServers: [{name, command, args?}]                  # optional MCP servers

# top-level options (all optional, all have a working default)
theme: string          # TUI colours at launch
auto: boolean          # approve anything not explicitly denied
watch: boolean         # announce external edits (default true)
instructions: string[] # files appended to every agent's system prompt
maxTurns: number       # tool-loop cap per agent turn (default 12)
maxAgents: number      # refuse to load a bigger team than this
```

`saveAgents()` rewrites only the `agents:` key — every other block above survives a relaunch of the
team picker.

### Task (`src/orchestrator/task.ts`)

```typescript
type TaskStatus = "pending" | "in_progress" | "done" | "failed";
interface Task {
  id: string; description: string; assignedTo?: string; status: TaskStatus;
  attempts?: number; lastFailedBy?: string; availableAt?: number; dependsOn?: string[];
}
```

### Event (`src/events/bus.ts`)

```typescript
type EventType = "thought" | "tool_call" | "file_edit" | "delta" | "message"
  | "failover" | "warning" | "done" | "error" | "external_change";
interface AgentEvent { agentId: string; type: EventType; payload: string; time: number; }
```

### Turn / provider contract (`src/providers/provider.ts`)

```typescript
type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: "tool"; results: ToolResult[] };

interface Provider {
  send(sysPrompt: string, turns: Turn[], tools: ToolSpec[], onDelta?: (text: string) => void): Promise<ProviderReply>;
}
interface ProviderReply { text: string; toolCalls: ToolCall[]; raw?: unknown; usage?: Usage; rateLimit?: RateLimit; }
```

### Persistence (`src/store/session-store.ts`)

```typescript
type SessionKind = "task" | "fork" | "ask" | "respond";
type PartType = "text" | "tool_call" | "tool_result" | "raw" | "file_ref";
// sessions(id, agentId, taskId?, parentSessionId?, kind, provider, model, status, ...)
// messages(id, sessionId, role, seq, tokens...) → parts(id, messageId, seq, type, content)
// checkpoints(id, sessionId, path, content|null, createdAt) — undone LIFO by /undo
```

### `.niti/session.json` (unchanged since v1 — tasks only, not conversations)

```json
{ "tasks": [{ "id": "t1", "description": "Add /health route", "assignedTo": "architect", "status": "done", "attempts": 0 }] }
```

---

## Current API surface

### HTTP + SSE (`src/server/server.ts`)

`POST /session · POST /prompt · POST /cancel · POST /undo · GET/POST /commands(/:name) · GET /sessions
· GET/POST /agents · GET /providers · GET /models · POST /model · GET/POST/DELETE /auth · POST
/approval · GET /events (SSE)`.

### Slash commands (`src/commands/registry.ts`, shared by the TUI and the web dashboard)

`/help /status /agents /tasks /mcp /lsp /permissions /cost /resume /clear /init /model /sessions
/undo /cancel /panes /graph /usage`, plus client-side `/theme` and `/quit`, plus project-defined
commands from `.niti/commands/<name>.md` (frontmatter + `$ARGUMENTS`-interpolated body).

### TUI interaction (Go, `tui/internal/session`)

- Typing `/` opens a filtered command menu above the prompt bar (prefix matches rank first); `tab`
  completes, `enter` runs, `esc` dismisses.
- `ctrl+p` opens the model carousel — pick a teammate (skipped for a solo team), then filter/pick a
  model from any provider with a stored key; `/model <agentId> <provider/model>` still works for
  scripting.
- `shift+tab` toggles BUILD/PLAN mode; `Tab` cycles panes/graph/usage; `y`/`a`/`n` answers approvals;
  `ctrl+t` cycles the theme.

### CLI (`src/cli.ts`)

`niti-core "<prompt>"` (one-shot) · `niti-core resume` · `niti-core serve [--auto] [--port=]` ·
`niti-core auth login/list/logout <provider>` · `niti-core login copilot` · `niti-core init` ·
`niti-core --web "<prompt>"`.

---

## What's implemented and verified

Covered by `bun test` (215+ tests, 0 fail — flaky-test rate near zero, not chased further) and
`bunx tsc --noEmit` (clean), plus `cd tui && go build ./... && go vet ./... && go test ./...` (clean)
and a live server smoke test:

| Area | Files |
|---|---|
| Global typed auth store (0600 + keychain, logout revokes) | `src/auth/auth-store.ts`, `src/keystore/keystore.ts` |
| Inter-agent messaging (routing, edge auth, rate cap, sync `ask` vs async `send`) | `src/messaging/message-bus.ts` |
| Orchestrator planner → validated DAG | `src/orchestrator/planner.ts` |
| Scheduler (topological order, concurrency, cycle rejection, hand-offs, integrate) | `src/orchestrator/scheduler.ts` |
| Agent loop + coordination tools + inbox injection + forking | `src/agent/agent.ts` |
| SQLite persistence: sessions/messages/parts, checkpoint/undo, resume | `src/store/*` |
| Wildcard permission resolver, `--auto`, dangerous-pattern override | `src/permissions.ts` |
| LSP client/registry + tools, alongside MCP | `src/lsp/*`, `src/tools/lsp-tools.ts` |
| File watcher + `external_change` events | `src/watch.ts` |
| Server-side command registry + user-defined commands | `src/commands/registry.ts` |
| Local HTTP + SSE server (constant-time token auth, replay, routes, static dashboard) | `src/server/*` |
| Go + Bubbletea TUI: every-launch team picker, live session view, model carousel, command menu | `tui/internal/*` |
| Web dashboard (self-contained SSE force-graph, tasks, messages, usage) | `web/*` |
| Electron desktop app (M1: native shell + Session panel — agent list, task board, Block-rendered live feed, approvals, model swap, prompt bar — over the same HTTP+SSE API, CORS-enabled since it's cross-origin unlike the TUI/browser dashboard) | `desktop/*` |

The headline end-to-end path — orchestrator plans a DAG, a frontend agent **asks the backend agent
directly**, the answer flows back without clobbering the frontend's task output, and every message
streams over SSE — is asserted in `src/engine.test.ts` and `src/server/server.test.ts`.

## Bugs found and fixed during adversarial review (kept for history)

- `compactTurns()` could split a tool-call/tool-result pair when `injectInbox()`'s extra turn shifted
  the parity of a fixed-size tail slice. Fixed: the cut point now walks back to never start on an
  orphaned `tool` turn.
- Cancellation didn't stop a task's exhausted-retry/backoff loop or the final integrate call — both
  now check `shouldStop()`.
- `normalizePlan()` could silently mis-resolve a dependency when the model reused an id across two
  tasks; ambiguous ids are now tracked and dropped instead of guessed at.
- `Engine.switchModel()` had no guard against swapping an agent's provider mid-loop, which could send
  one provider's turn history (e.g. Anthropic's opaque `raw` thinking blocks) to a different provider.
  `Agent` tracks in-flight calls with a counter (not a boolean — `run()`/`respond()` legitimately
  overlap via `ask_agent`) and rejects a live switch while busy.
- The server's bearer-token check used `!==` instead of a constant-time comparison — a timing
  side-channel on the sole auth gate. Now `timingSafeEqual`.
- Go TUI: `truncate()` panicked on any terminal narrow enough to make a computed width ≤0. Now clamps.
- Go TUI: `StreamEvents` returned quietly on any disconnect with no way to tell "asked to stop" from
  "should reconnect," freezing the TUI on the last frame. Now a distinguishable `ErrStreamDisconnected`
  with capped-backoff reconnect and last-seen-`seq` replay.
- Go TUI: the SSE line buffer was capped at 4MB with no distinct overflow error; raised to 32MB with a
  documented ceiling and a real error on overflow.
- Go TUI: approval keys fired bare `go func(){}` goroutines with discarded errors, risking
  duplicate/misdirected approvals on a fast double-press. Converted to `tea.Cmd` with an optimistic
  local pop.
- Go TUI: `saveAgents()` (server-side) used to rewrite the whole `agents.yaml`, silently deleting
  `permissions:`/`lsp:`/`mcpServers:`/options next to it on every picker relaunch — fixed to replace
  only the `agents:` key.

## Known simplifications (ponytail ceilings)

- Same-agent retry-with-backoff on exhaustion rather than live reassignment to a different (possibly
  busy) agent — avoids concurrency races; upgrade if cross-agent failover is needed.
- Credential validation is deferred to first use (no live provider ping on `auth` save).
- Re-planning after integrate is not implemented (the orchestrator reviews + summarizes only).
- ~~The web dashboard is a read-only viewer (no prompt submission from the browser).~~ Corrected: `web/app.js` already submits prompts, switches models, answers approvals, and sends mid-task agent messages via `POST /prompt`/`/model`/`/approval`/`/agents/:id/message` — it has not been read-only for some time; this line was stale.
- One global shell lock (`*shell*`) rather than per-path — real path extraction from an arbitrary
  shell command is a guessing game; upgrade only if shell contention shows up in practice.
- File watching has no debounce or full `.gitignore` parsing, just an inline ignore list.
- The tool sandbox is path-prefix jailed, not container/seccomp isolated (symlink escapes possible).
- MCP servers are shared across agents, not per-agent scoped.
- Agent-to-agent messaging is open within a run rather than restricted to the plan's declared edges —
  deliberate (see architecture point 6), not an oversight.
- Of the three sign-in options, only GitHub Copilot's OAuth is wired.

## Explicitly out of scope (named, not silently dropped)

| Surface | Decision | Reason |
|---|---|---|
| ACP (Zed/VS Code embedding) | Out of scope | niti is a standalone CLI/TUI, no IDE host to embed into |
| Desktop app (SolidJS) | Superseded 2026-09-15 — see `desktop/*` | Electron GUI added additively, alongside (not replacing) the TUI/web dashboard, as a native panel-based front end; SolidJS was never built, Electron was chosen instead |
| 20+ TUI themes | Deferred | Pure polish, addable to `tui/internal/theme/theme.go` any time |
| Frecency-based autocomplete | Deferred | UX polish on top of the command registry, not parity-critical |
| tree-sitter | Descoped, subprocess LSP instead | No syntax-highlighting UI surface to justify it |
| Dedicated `git_diff` tool | Descoped, `shell` + permissions instead | Redundant once wildcard permissions exist |
| Commit-boundary checkpointing | Descoped, per-write checkpoints instead | Strictly coarser for more code |
| WebSocket transport | Deferred | SSE already covers every event type for single-client use |
| Multi-project `EngineManager` | Deferred | Real scope beyond single-project use; not yet needed |

## Run it

```sh
bun install
bun run build:tui                          # builds ./niti (the Go TUI) — do this once, or after tui/ changes
./niti                                     # every launch: pick the team (1–5 models), then the live session

# headless/scripting:
bun run src/cli.ts init
bun run src/cli.ts "build me a clothing website for gen-z"
bun run src/cli.ts --web "build me a clothing website for gen-z"
bun run src/server/main.ts
```

## Verification

```sh
bun test                 # TypeScript unit + integration tests
bunx tsc --noEmit        # typecheck
cd tui && go build ./... && go vet ./... && go test ./...   # Go TUI
```
