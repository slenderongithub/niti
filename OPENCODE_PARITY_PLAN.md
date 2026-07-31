> **How to use this file:** This is the build brief for the next phase of `amux`: a deep architectural
> rewrite bringing it to feature parity with `sst/opencode` (persistent sessions, LSP + MCP tool
> integrations, patch-based editing with undo, wildcard permission config, sub-agent forking, file
> watching, extensible slash commands, responsive TUI) while keeping amux's own differentiator —
> cross-provider agent-to-agent messaging — as a first-class feature layered on top. Paste this whole file
> as the opening brief to whichever model/session picks up the work next (this repo attached/open).

---

# amux → OpenCode-parity rewrite

## Context

The user built `amux` (Bun/TS core + Go/Bubbletea TUI, multi-provider agent CLI) but it "still didn't turn
out like how I wanted it to." They want a deep architectural rewrite bringing amux to full feature parity
with `sst/opencode` — LSP integration, patch-based editing with undo, real permission config, persistent
sessions, sub-agent forking, file watching, extensible slash commands — while keeping amux's one genuine
differentiator on top: **agents on different LLM providers coordinating directly with each other**
(OpenCode's sub-agents are same-provider; amux's are cross-provider). This is explicitly scoped as "deep
architectural rewrite," "everything," not a light feature graft — confirmed via two rounds of clarifying
questions. The user also confirmed: **both LSP and MCP integrations must coexist** (MCP is not being
replaced), and flagged one small, non-blocking UX gap — the Go TUI's panes don't currently reflow when the
terminal is resized.

Verified starting point (read directly, not assumed): `src/agent/agent.ts`, `src/tools/tools.ts`,
`src/approval.ts`, `src/orchestrator/task.ts`, `src/session.ts`, `src/engine.ts`, `src/config/config.ts`,
`src/messaging/message-bus.ts`, plus a full module map of `src/` and `tui/` from a live exploration pass.
OpenCode's architecture (SQLite/Drizzle sessions decomposed into Parts, Hono server, wildcard-pattern
permissions, tree-sitter+LSP, session forking, revert/retry) is from public docs/DeepWiki, not source
access — treat exact table/field names as a reasonable model, not gospel, and adjust if reality differs
once implementation starts.

Ladder discipline held throughout: reuse amux's existing sandboxing (`safePath`), approval queue
(`ApprovalQueue`), provider interface, event bus, and MCP subprocess pattern rather than building parallel
systems. No new runtime dependency is needed anywhere in this plan — `bun:sqlite` is stdlib-in-Bun,
`Bun.Glob` and `fs.watch` are already available, LSP's wire protocol is hand-rollable JSON-RPC over stdio
exactly like `src/mcp/mcp.ts` already does.

## Current architecture (for reference, not being replaced wholesale)

- **Orchestration**: `orchestrator/task.ts` (`Task`/`TaskNode`), `planner.ts` (goal → DAG), `scheduler.ts`
  (topological/concurrent execution, hand-offs), `runner.ts` (plan→schedule→integrate). **Stays as the
  DAG source of truth** — nothing in this plan touches scheduler topology.
- **Agent loop**: `agent/agent.ts` — `run()`/`respond()`/`ask()`, `execTool`, `GATED` approval set,
  `inFlightCount` (counter, not boolean — `run()`/`respond()` legitimately overlap via `ask_agent`),
  coordination tools (`send_message`/`ask_agent`) gated by `MAX_ASK_DEPTH`.
- **Messaging**: `messaging/message-bus.ts` — cross-provider agent-to-agent channel, deliberately open
  (not DAG-edge-restricted), per-pair rate cap as the loop guard.
- **Tools**: `tools/tools.ts` — sandboxed `read_file`/`write_file`/`shell`, `safePath()` jail.
- **Approval**: `approval.ts` — `ApprovalQueue`, scope grants, batch dialogs, `DANGEROUS_PATTERNS` hard
  override.
- **Persistence**: `session.ts` saves **only the task list** to `.amux/session.json` — no conversation
  history persists today (a documented `ponytail:` ceiling). `config/config.ts` loads `.amux/agents.yaml`.
- **Providers/server/TUI**: unchanged by this plan except where noted — `providers/*`, `server/*` (HTTP+SSE
  to the Go TUI), `tui/` (Bubbletea).

## Confirmed gaps vs. OpenCode being closed

No LSP/diagnostics · no git-aware context · no file watching · no patch/diff tool (blind overwrite only) ·
no dynamic sub-agent spawning (static DAG only) · no user-extensible slash commands · no multi-session
management · no undo/checkpointing · no real conversation persistence · coarse fixed-set approval gating
(`GATED = {write_file, shell}`) vs. OpenCode's wildcard-pattern permission hierarchy · TUI panes don't
reflow on terminal resize.

## Phased plan

Each phase lists: design, files touched, verification. **Sequencing: 0 → 1 → 2 → (3 and 5 in parallel) →
4 → 6 → 7.** Phase 0 is the prerequisite for everything else (undo, forking, and messaging-as-sessions all
need the persistence substrate); phases 3 and 5 are fully independent of each other and of 2/4. The
responsive-TUI-layout item is small and standalone — do it whenever convenient, e.g. alongside Phase 6's
TUI edits.

---

### Phase 0 — Persistence schema (prerequisite for 2, 4, 7)

**Design.** New `bun:sqlite` database at `.amux/amux.db` (WAL mode, hand-rolled migrations — no ORM
needed for ~4 tables). Schema in a new `src/store/schema.sql`:

- `sessions` — `id, agent_id, task_id (nullable FK → Task.id), parent_session_id (self-FK, for forks),
  kind ('task'|'fork'|'ask'|'respond'), provider, model, status, created_at, updated_at, time_archived`.
  **A session is a child concept a task *has*, not a replacement for `Task`/`TaskNode`** — the DAG scheduler
  is untouched.
- `messages` — `id, session_id, role, seq, {input,output,reasoning,cache}_tokens, created_at`.
- `parts` — `id, message_id, seq, type ('text'|'tool_call'|'tool_result'|'raw'|'file_ref'), content (JSON),
  created_at`. Decomposing messages into parts (mirroring OpenCode) is what lets `Turn.raw` (opaque
  provider blocks like Anthropic thinking) round-trip without redesigning `providers/provider.ts`.
- `checkpoints` — `id, session_id, path, content (nullable = file didn't exist), created_at`. Built now,
  used by Phase 2.

New `src/store/db.ts` (open/migrate) and `src/store/session-store.ts` (`createSession`,
`appendMessage(sessionId, role, parts)`, `loadTurns(sessionId): Turn[]`, `listSessions(filter)`,
`archiveSession`, `checkpoint`, `undoLast` — the latter two land in Phase 2).

**`agent/agent.ts` changes**: `AgentDeps` gets `store?: SessionStore`. `run()`/`respond()` create a session
row and mirror every `turns.push(...)` into `appendMessage` via a pure `toPartsFor(turn)`/`loadTurns`
symmetric pair. This is additive — the in-memory `turns: Turn[]` array still drives the loop unchanged; the
store call is a side-effect mirror, not a behavior change.

**`session.ts` changes**: keep `saveTasks`/`loadTasks` exactly as-is. Add `resumeConversation(taskId):
Turn[]` reading from the store, wired into `orchestrator/runner.ts`'s resume path — this is what actually
closes the "no conversation history persists" gap noted in the code today.

**Files**: `src/store/db.ts` (new), `src/store/session-store.ts` (new), `src/store/schema.sql` (new),
`src/agent/agent.ts` (edit), `src/session.ts` (edit), `src/engine.ts` (edit: construct `SessionStore`, pass
to every `Agent`).

**Verify**: `src/store/db.test.ts` (round-trip session/message/part), extend agent tests to assert
`loadTurns` reconstructs what was fed to `provider.send()`; existing `session.test.ts` (task save/load)
must keep passing unmodified.

---

### Phase 1 — Permission system (independent of 0 except sharing `agents.yaml`; can run in parallel with 0)

**Design.** Replace the fixed `GATED = new Set(["write_file","shell"])` in `agent.ts` with a config-driven
resolver. Extend `.amux/agents.yaml` rather than forking to a new config file:

```yaml
agents:
  - id: architect
    permissions:              # NEW, optional, per-agent — overrides project defaults
      bash: { "git *": allow, "git commit *": ask, "git push --force*": deny }
      write_file: { "src/**": allow, "*": ask }
permissions:                  # NEW, top-level = project defaults
  bash: { "rm -rf*": deny }
```

New `src/permissions.ts`: `resolve(rules, tool, input): "allow"|"ask"|"deny"` — matches patterns with
`Bun.Glob` (already used in `approval.ts`, no new matcher). Unmatched → `"ask"`, so agents with no
`permissions:` block behave identically to today's `GATED` set (backward compatible by construction).

Full hierarchy = session grant (`ApprovalQueue.scopes`, existing, checked first) → agent config → project
config → default-ask. `DANGEROUS_PATTERNS`/`isDangerousShellCall` stay merged in as the one thing a config
`allow` can never downgrade: `forceAsk = dangerous || decision === "ask"`.

`--auto` CLI flag (`cli.ts`): seeds a synthetic `{"*":{"*":"allow"}}` rule, still overridden by dangerous
patterns — matches OpenCode's "approve anything not explicitly denied."

**Files**: `src/permissions.ts` (new), `src/agent/agent.ts` (edit: `AgentConfig.permissions`, `execTool`
resolver call replaces `GATED.has()`), `src/config/config.ts` (edit: parse/validate `permissions:` blocks),
`src/cli.ts` (edit: `--auto` flag).

**Verify**: `src/permissions.test.ts` (pattern precedence, agent-overrides-project), extend
`approval.test.ts` (deny short-circuits without queuing; dangerous pattern still forces ask despite an
`allow` rule). Manual: configure `shell: {"git *": allow}`, confirm `git status` runs silently but
`rm -rf /tmp/x` still prompts.

---

### Phase 2 — Patch/diff tool + checkpointing + undo (needs 0's `checkpoints` table)

**Design.** New `edit` tool alongside `write_file` (kept, for full-file create/overwrite):
`{tool:"edit", path, oldString, newString, replaceAll?}` — read via `safePath` (reused unchanged), require
`oldString` occurs exactly once (or `replaceAll`), splice, write. This is the same contract Claude
Code/OpenCode both use — picking a common shape over a bespoke diff format models are already trained on.

Checkpointing hooks into `Agent.execTool`, not `tools.ts` (keeps `tools.ts` a pure sandboxed executor with
no DB dependency): before any `write_file`/`edit`, read current content (or null) and call
`store.checkpoint(sessionId, path, before)`.

Diff preview: `execTool` computes a small unified-diff string for `edit` calls (hand-rolled ~30-line
line-differ, no library) and adds it as `input.diff` on the existing `ApprovalRequest.input` bag — additive
to the approval payload, TUI/dashboard render it if present else fall back to today's raw display.

`/undo`: `undoLast(sessionId)` pops the most recent checkpoint row(s), restores content or deletes the file
if content was null. One undo = one prior write reverted (LIFO), not "undo the whole task" — the honest
simple semantics. Server: `POST /undo {sessionId}`. TUI: extend `session.go`'s slash-command switch.

**Files**: `src/tools/tools.ts` (edit: `edit` case + spec), `src/agent/agent.ts` (edit: checkpoint-before-
write, diff-in-approval), `src/store/session-store.ts` (edit: `checkpoint`/`undoLast`), `src/server/server.ts`
(edit: `/undo` route), `tui/internal/session/session.go` (edit: `/undo` case).

**Verify**: `tools.test.ts` (edit replaces unique occurrence, errors on ambiguous/absent match),
`session-store.test.ts` (checkpoint→undo round-trip, both overwrite and file-creation cases). Manual:
edit a file via the tool, approve, `/undo`, confirm disk content reverts.

---

### Phase 3 — LSP integration, alongside existing MCP (independent; can start after Phase 1 if permission-gating is wanted)

**MCP is not being replaced or touched** — `src/mcp/mcp.ts` (stdio MCP servers, `mcp__<server>__<tool>`
namespacing) stays exactly as-is; LSP is a second, separate tool source added alongside it, not instead of
it. `buildTools()` in `agent.ts` already concatenates multiple spec sources (sandbox + MCP) — LSP specs are
a third source merged the same way, so both integrations are live for every agent simultaneously.

**Design decision: subprocess LSP clients over stdio, no tree-sitter.** amux has no code-aware UI surface
(TUI renders plain text) so tree-sitter's actual OpenCode use case (syntax highlighting) doesn't apply here
— the headline feature is diagnostics/hover, which real LSP servers (`typescript-language-server`, `gopls`,
`pyright` — user-installed, not bundled) provide correctly for free over hand-rolled JSON-RPC framing
(`Content-Length` headers + JSON — ~150 lines, mirrors the subprocess lifecycle `src/mcp/mcp.ts` already
manages for MCP servers).

New `src/lsp/client.ts` (spawn/JSON-RPC/`initialize`/`didOpen`/`publishDiagnostics` listener/hover),
`src/lsp/registry.ts` (extension → server command, from a new `.amux/agents.yaml` top-level `lsp:` block,
lazy-spawn, one process per language reused across all agents since diagnostics are project-global). Two
new tools in `src/tools/lsp-tools.ts`: `diagnostics(path)`, `hover(path,line,col)`. Gated identically to
any other tool via Phase 1's resolver — no special-casing. Missing server → clear error string, not a
crash (same posture as optional MCP servers).

**Files**: `src/lsp/client.ts` (new), `src/lsp/registry.ts` (new), `src/tools/lsp-tools.ts` (new),
`src/tools/tools.ts` (edit: merge lsp specs into `buildTools`'s concatenation, same pattern as `mcp`),
`src/config/config.ts` (edit: parse `lsp:` block), `src/agent/agent.ts` (edit: wire lsp registry).

**Verify**: `src/lsp/client.test.ts` (skip via `Bun.which()` check if no LSP binary present — don't hard-
fail CI on a missing external tool). Manual: configure `lsp: {typescript: {...}}`, have an agent call
`diagnostics` on a file with a deliberate type error, confirm it surfaces.

---

### Phase 4 — Dynamic sub-agent forking (needs 0's `sessions.parent_session_id`)

**Design decision: scheduler-invisible sub-loop, not a new `TaskNode`.** The DAG scheduler is topology-
driven (plan up front, execute deterministically); forcing a mid-run spawn through `detectCycle`/the ready-
queue would be a much bigger blast radius for something that only matters to the spawning agent's own
conversation, not sibling tasks. Instead: a fork is a new **session** (`kind:'fork'`,
`parent_session_id` = current) driven by a new `Agent.fork(goal): Promise<string>` method — internally the
*same* `run()`-shaped loop body, same provider, same tool access (inherited `allowedTools`/`permissions` —
no privilege escalation), bounded by `MAX_TURNS`. Not a new `Agent` instance. New tool `spawn_fork` exposed
alongside `send_message`/`ask_agent`, depth-capped by a new `MAX_FORK_DEPTH` mirroring `MAX_ASK_DEPTH`.
Because `inFlightCount` is already a counter (not boolean — verified in current code, built for exactly
this kind of concurrent self-invocation), `fork()` running concurrently with the parent's own turn is
already safe with no further changes needed.

**Files**: `src/agent/agent.ts` (edit: `fork()`, `spawn_fork` spec/dispatch, `MAX_FORK_DEPTH`).

**Verify**: `agent.test.ts` — fork produces a session row with correct `parent_session_id`, returns text,
doesn't corrupt the parent's `turns`/`lastText`; depth-cap test mirroring existing `MAX_ASK_DEPTH` coverage.

---

### Phase 5 — Git-aware context + file watching (independent)

**Design.** Git context: **no new tool** — `shell` already exists, and once Phase 1's wildcard permissions
land, `permissions: {shell: {"git diff*": allow}}` gets the same effect a dedicated `git_diff` tool would,
for zero new code. Document the pattern in the system-prompt guidance instead of building a parallel path.
Commit-boundary checkpointing is skipped for the same reason Phase 2 already gives finer-grained undo.

File watching: `node:fs.watch({recursive:true})` (Bun-supported, no `chokidar`) in new `src/watch.ts`, with
an inline ignore list (`.git`, `node_modules`, `.amux`) — the one real ceiling worth a `ponytail:` comment
is no debounce/full gitignore parsing, upgrade if noise becomes a problem. Wired into `Engine`: one watcher
at construction, new `Bus` event `"external_change"`, with a short-TTL `Set` of the engine's own recent
write paths so an agent's own `write_file` doesn't re-trigger itself. No auto-context-stuffing — a human or
the next planner run decides what to do with a change, avoiding token bloat.

**Files**: `src/watch.ts` (new), `src/engine.ts` (edit: start watcher, new event), `src/events/bus.ts`
(edit: add `external_change` to the event union). **Not touched**: `tools.ts` (no dedicated git tool).

**Verify**: `watch.test.ts` (touch a file in tmpdir, assert callback fires and ignored paths don't).
Manual: `amux serve`, edit a file externally, confirm SSE emits `external_change`.

---

### Phase 6 — Multi-session management + slash commands (needs 0's `sessions` table for listing)

**Design.** Session listing (`GET /sessions?taskId=`) is now cheap given Phase 0's schema — add it now.
Full multi-*project* management (`EngineManager` holding one `Engine` per project root) is real, non-free
scope — sequence it last and only if there's actual need beyond single-project use.

**Slash commands move server-side.** Reasoning: the Go TUI's hardcoded switch would otherwise need
identical re-implementation in the web dashboard for parity — the user's stated goal benefits both. New
`src/commands/registry.ts`: `{name, description, run: (engine, args) => Promise<CommandResult>}` entries
for `/model`, `/graph`, `/usage`, `/cancel`, `/undo`. Exposed via `GET /commands` (list/describe, for
autocomplete) and `POST /commands/:name`. TUI's switch shrinks to fetch-registry-then-dispatch. User-
extensible via `.amux/commands/*.md` — mirrors `skills/skills.ts`'s existing `.amux/skills/*/SKILL.md`
loader shape exactly (frontmatter name/description, body = prompt template), reusing that parsing pattern
rather than inventing a second config format.

**Files**: `src/commands/registry.ts` (new), `src/server/server.ts` (edit: `/commands` routes),
`tui/internal/session/session.go` (edit: dispatch via registry), `src/engine-manager.ts` (new, multi-
project — only if time permits, last).

**Verify**: `commands/registry.test.ts` (built-ins dispatch correctly, a `.amux/commands/foo.md` fixture
loads and executes). Manual regression: `/undo` and `/model` still work identically post-refactor.

---

### Small, standalone — responsive TUI layout

Not currently a thing: `tui/internal/session/view.go` renders panes at fixed dimensions rather than
reflowing on terminal resize. Bubbletea already delivers `tea.WindowSizeMsg` on resize; the fix is
recomputing pane widths/heights from `msg.Width`/`msg.Height` in the existing `Update()` (lipgloss layout
already in use, no new dependency). Small, independent of every phase above — can be done any time, e.g.
alongside Phase 6's TUI edits since that's already touching `session.go`.

**Files**: `tui/internal/session/session.go` (edit: handle `tea.WindowSizeMsg`), `view.go` (edit: size panes
from stored width/height instead of constants).

**Verify**: manual — resize the terminal mid-session, confirm panes/boxes reflow instead of clipping or
leaving dead space.

---

### Phase 7 — Fold cross-provider messaging into persistence (needs 0 + 4's session-linking pattern)

**Design.** This is where amux's differentiator gets first-class treatment instead of staying a purely
ephemeral relay. `messaging/message-bus.ts`'s `AgentMessage` gets an optional `sessionId?`. New
`bus_messages` table (mirrors `AgentMessage`, FKs to `sessions`). `respond()` in `agent.ts` — the one loop
Phase 0 correctly left alone since it returns text without a durable trace today — gets the same store
hooks `run()` got in 0.2 (`store.createSession(kind:'ask')` + `appendMessage`). Net new capability: a UI can
render "architect asked frontend X, frontend's session Y answered" as a linked thread, because the exchange
now leaves a persisted trail instead of vanishing after `respond()` returns.

**Files**: `src/messaging/message-bus.ts` (edit: optional `sessionId`), `src/store/schema.sql` (edit:
`bus_messages` table), `src/agent/agent.ts` (edit: `respond()` store hooks).

**Verify**: integration test — agent A `ask_agent`s agent B, assert both a `sessions` row (`kind:'ask'`,
correct `parent_session_id`) and a linked `bus_messages` row exist afterward.

---

## Explicitly out of scope (named, not silently dropped)

| OpenCode surface | Decision | Reason |
|---|---|---|
| ACP (Zed/VS Code embedding) | Out of scope | amux is a standalone CLI/TUI, no IDE host to embed into. |
| Desktop app (SolidJS) | Out of scope | Terminal + optional web dashboard is amux's UI surface; a native shell is a different product. |
| 20+ TUI themes | Deferred | Pure polish, zero dependency on the rest of this plan — addable to `tui/internal/theme/theme.go` any time. |
| Frecency-based autocomplete | Deferred | Needs Phase 6's command registry to exist first; UX polish, not parity-critical. |
| tree-sitter | Descoped, subprocess LSP instead | No syntax-highlighting UI surface in amux to justify it; real LSP servers cover diagnostics/hover more cheaply. |
| Dedicated `git_diff` tool | Descoped, `shell` + Phase 1 permissions instead | Redundant once wildcard permissions exist. |
| Commit-boundary checkpointing | Descoped, Phase 2's per-write checkpoints instead | Strictly coarser for more code. |
| WebSocket transport | Deferred | amux's SSE-only transport already covers every event type for single-client TUI/dashboard use. |

## Verification (whole-project, run after each phase and again at the end)

```sh
bun test                 # TypeScript unit + integration tests
bunx tsc --noEmit        # typecheck
cd tui && go build ./... && go vet ./... && go test ./...   # Go TUI
```
Plus each phase's manual `/verify` step listed above, run against a real project directory with at least
two agents on different providers configured (to keep exercising the cross-provider messaging path
throughout, not just at Phase 7).
