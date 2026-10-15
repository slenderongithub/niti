# niti — the universal README

`niti` runs **a team of AI coding agents from different LLM providers on one project, at once**. You
give models roles and pick a lead. The lead plans a goal into a task graph, the team builds it
concurrently, **talking to each other directly** to stay aligned, and you watch, steer and approve, in
a terminal, a desktop app, a browser, or from your phone.

This file is the one place that describes the **whole repository**: what each part is, how they fit,
the engine they share, and the rules that keep them in step. Each part has its own README for its
details; the top-level `README.md` is the user-facing GitHub page.

| Read | For |
|---|---|
| `README.md` | The GitHub page: what niti is, install, use. User-facing; not a design doc. |
| **`project_context.md`** (this) | The whole repo: architecture, engine, API, data, remote control, testing, history. |
| `tui/README.md` | The CLI: the `niti` terminal app, `niti-core`, the web dashboard. |
| `niti-app/README.md` | The desktop app (Electron). |
| `niti-mobile/README.md` | The iPhone app (Expo). |
| `niti-relay/README.md` | The relay between a Mac and a phone. |
| `CLAUDE.md` | The rules for changing any of it. |

---

## The repository: one engine, four products

| Product | Lives in | What it is |
|---|---|---|
| **CLI** (the main product) | `src/` (engine), `tui/` (Go TUI), `web/` (dashboard), `scripts/`, `bin/` | `niti`, a Go + Bubbletea terminal app, spawns `niti-core`, the Bun/TypeScript engine, and drives it over local HTTP + SSE. `niti-core` also runs headless for scripts and CI, and serves the web dashboard. |
| **Desktop app** | `niti-app/` | The same product as a native Electron + React window over the same engine (it bundles `niti-core`). Same config, keys and sessions as the CLI. |
| **Relay** | `niti-relay/` | A Cloudflare Worker + Durable Object (or Bun, self-hosted): email-code sign-in, forwards end-to-end encrypted frames between a Mac's core and a phone, sends pushes. Never sees content. |
| **Mobile app** | `niti-mobile/` | An Expo iPhone app: a remote control for a core running on a Mac. Watch, steer, approve, pause, merge. All work still runs on the Mac. |

The CLI and the desktop app are **one product in two packagings**; the relay and the phone app are
**companions** that control it remotely. Shared code is imported, never copied:

```
src/  (niti-core: the engine)  ◀── bundled by niti-app/scripts/bundle-core.ts
src/remote/protocol.ts         ◀── imported by niti-relay/ and niti-mobile/
niti-app/src/renderer/src/lib/ (reducer, types, humanize, identity, diff, format)
                               ◀── imported by niti-mobile/
niti-app/src/renderer/src/assets/avatars/  ◀── loaded by niti-mobile/
```

## Architecture

```
  niti (Go TUI)     web dashboard     niti-app (Electron)        iPhone (niti-mobile)
        │                 │                  │                           │
        └──────── HTTP + SSE, bearer token, 127.0.0.1 ────────┐          │ wss, E2E encrypted
                                                              ▼          ▼
                                                       src/server   niti-relay ◀─ email codes, push
                                                              │          ▲
                                       Engine (src/engine.ts) ┤          │ one outbound socket
                                                              └── src/remote/bridge.ts
   .niti/agents.yaml ─▶ providers (keychain) ─▶ Agent[] ─▶ MessageBus (agent ↔ agent)
   goal ─▶ lead plans a DAG (planner) ─▶ scheduler runs it concurrently ─▶ lead reviews
   every event ─▶ EventHub (seq + replay ring) ─▶ SSE to every client, and to phones via the bridge
```

Every front end is a client of the same engine API. Several can attach at once; an approval answered
in one disappears from the others (the core answers by id; a second answer gets 409).

## The engine (`src/`)

**Core ideas**

1. **Orchestration is a DAG.** The lead turns a goal into a validated task graph (`orchestrator/planner.ts`:
   zod-checked, retried, ambiguous dependency ids dropped rather than guessed). `scheduler.ts` runs
   independent tasks concurrently in topological order, passes each task's output to its dependents,
   and the lead reviews and summarises at the end.
2. **Agents talk to each other.** `send_message` / `ask_agent` reach any teammate mid-task through
   `messaging/message-bus.ts`. Deliberately open, not limited to the plan's edges; a per-pair rate cap
   is the loop guard.
3. **The agent loop** (`agent/agent.ts`): multi-turn tool use (read-only calls in a turn run
   concurrently), a verification pass before a task that changed files may report done
   (`agent/verify.ts`, with a guard against gaming its own checks), stall detection (`agent/stall.ts`),
   context compaction near the ceiling (`agent/context.ts`), a todo list (`agent/todo.ts`),
   per-model-family steering (`agent/steering.ts`), a PageRank repo map in the system prompt
   (`agent/repomap.ts`), and forks (`spawn_fork`, same tools and permissions, depth-capped).
4. **Interrupting one agent.** Each agent has its own abort controller and step counter on top of the
   run's: `Engine.interruptAgent` stops the agent that owns an in-progress task mid-call, denies its
   pending approvals, and it carries on from your message. Cancel stops the whole run.
5. **Failover.** Rate limits, context exhaustion or quota requeue a task with backoff and same-agent
   exclusion; failed for good after 3 attempts.
6. **Safety.** Writes and shell go through `approval.ts` (session grant → agent `permissions:` →
   project `permissions:` → ask; most specific pattern wins). Destructive shell patterns always ask,
   even under `--auto`. Paths are jailed (`safePath`); shell spawns with array args; `sandbox.ts` puts
   shell commands in an OS sandbox (Seatbelt on macOS, bubblewrap on Linux): writes confined to the
   project, credential stores unreadable. `trust/` asks once per folder before reading its config,
   recorded globally (never a repo marker a repo could commit) with a snapshot of `agents.yaml`.
   `store/audit-log.ts` keeps a hash-chained log of tool calls and approvals (`niti-core audit verify`).
   `secrets.ts` names credential files: an agent reads one only when you approve that exact call, and
   grep never scans one, so a key can't reach a model's context.
7. **Providers.** One `Provider` interface: native Anthropic and Gemini clients, one OpenAI-compatible
   client for the rest of the Models.dev catalog (`providers/catalog.ts` + generated), GitHub Copilot
   OAuth. Keys in the OS keychain with env-var fallback (`auth/auth-store.ts`).
8. **Persistence.** Every turn is stored as sessions → messages → parts in SQLite (`.niti/niti.db`),
   so conversations survive a restart. Each write is checkpointed first, which `/rewind` reverts.
   `/branch` snapshots the tree to a git branch. The task board saves to `.niti/session.json`.
9. **Worktrees.** With `worktree: true` (or `--worktree`) a run writes into a throwaway git worktree;
   merging back is always an explicit action (`/worktree/merge`), never automatic.
10. **`/goal`** (`goal.ts`): keep working toward an objective round after round. After each round a
    judge (the lead, read-only, marker `NITI-GOAL-JUDGE`) decides done / not done and the next step.
    It stops on done, a round, token or dollar budget, two rounds with no change to the tree (blocked),
    pause, or stop. Esc pauses it. It persists in `.niti/goal.json` and comes back paused after a
    restart. While a goal runs, `/prompt` gets 409 and what you type is a note to its next round.
11. **`/awake`** (`awake.ts`): keeps the Mac awake, lid closed too, until the run (or the whole goal)
    ends, through one admin prompt and a root watchdog. From a phone it never asks for admin: lid-open
    only.
12. **LSP and MCP** side by side in the tool list; a missing server is a message, never a crash.
    `watch.ts` reports edits made outside niti.

**Where things are**

| Path | Responsibility |
|---|---|
| `cli.ts` | `niti-core`: one-shot runs, `serve`, `--web`, `init`, `resume`, `auth`, `login copilot`, `audit verify`, `trust` |
| `engine.ts` | Wires agents, orchestrator, messaging, approvals, usage, locks, store, watcher, goal and remote into one `EventHub`: `submit`, `resume`, `cancel`, `interruptAgent`, `switchModel`, `rewind` |
| `config/config.ts` | `.niti/agents.yaml`: agents, permissions, LSP, MCP, options (`loadOptions`); `saveAgents` rewrites only `agents:` |
| `agent/*` | The agent loop and its parts (above) |
| `orchestrator/*` | Planner, scheduler, runner, the task queue, file and shell locks, worktrees |
| `messaging/message-bus.ts` | Agent ↔ agent messages |
| `providers/*` | Model clients, the catalog, pricing |
| `tools/*` | `read_file`, `write_file`, `edit`, `shell`, `grep`, `glob`, `list_dir`, LSP tools; output condensing |
| `approval.ts`, `permissions.ts`, `sandbox.ts`, `secrets.ts`, `trust/` | The safety layer |
| `store/*` | SQLite sessions, checkpoints, the audit log; `.niti/.gitignore` |
| `goal.ts`, `awake.ts` | `/goal` and `/awake` |
| `commands/registry.ts` | Slash commands, shared by every front end; project commands from `.niti/commands/*.md` |
| `server/*` | The HTTP + SSE API (`server.ts`), the event hub with replay (`events.ts`), the headless core and its handshake line (`main.ts`) |
| `remote/*` | Remote control: the wire protocol, this Mac's identity, the bridge to the relay |
| `graph/filegraph.ts` | The project's import graph; its `IGNORE` set also bounds the project map every agent sees |

## Data on disk

```
<project>/.niti/
  agents.yaml        the team and options (below); meant to be committed
  niti.db            sessions, messages, parts, checkpoints, audit log (SQLite, WAL)
  session.json       the task board
  goal.json          the current /goal (atomic writes)
  worktrees/         per-run git worktrees
  reports/           /export audit reports
  skills/*/SKILL.md  skills agents can read
  commands/*.md      project slash commands
  core.log, logs/    the core's log
  .gitignore         generated: keeps the per-machine state (db, board, goal, logs, reports,
                     worktrees) out of git
~/.config/niti/
  auth.json          provider keys (0600; the OS keychain when available)
  remote.json        this Mac's remote identity: signing key, account, allowed phones (0600)
  trusted.json       folders you've trusted, with a snapshot of each agents.yaml
```

`.niti/agents.yaml`:

```yaml
agents:
  - id: string              # required, unique
    provider: string        # catalog key
    model: string
    role: string            # display title
    systemPrompt: string
    lead: boolean           # plans goals into tasks
    allowedTools, autoApprove: string[]
    baseURL: string         # custom OpenAI-compatible endpoint
    permissions: {tool: {pattern: allow|ask|deny}}
permissions: {tool: {pattern: allow|ask|deny}}   # project default
lsp: {name: {command, args?, extensions}}
mcpServers: [{name, command, args?}]
# options, all optional
theme · auto · watch · instructions: [files] · maxTurns · maxAgents · worktree · verify: [cmds]|false
autoCompact · thinkingMode · lightMode · reduceMotion · showTurnDuration · openAgentsView
projectInstructions · repoMap · sandbox · remote   # remote: false keeps this project off phones
```

## The API every client speaks (`src/server/server.ts`)

Local only (127.0.0.1), a fresh bearer token per launch, handed over in the core's handshake line.

- **Session**: `POST /session` (snapshot: agents, tasks, settings, goal, remote, bootId, lastSeq…),
  `GET /events` (SSE, replay from a seq), `POST /prompt`, `POST /cancel`.
- **Agents**: `GET/POST /agents`, `POST /agents/:id/message` (steer at its next turn),
  `POST /agents/:id/interrupt` (stop now, carry on from the message), `POST /model`, `POST /reassign`.
- **Approvals**: `POST /approval` (by id; `scope: agent|path`; `edited` content).
- **Commands**: `GET /commands`, `POST /commands/:name`.
- **Files and changes**: `GET /files`, `GET /file` (jailed, text, ≤1 MB), `GET /graph`,
  `GET /worktree`, `GET /worktree/hunks`, `POST /worktree/merge|discard`, `GET /checkpoints`.
- **Setup**: `GET /providers`, `GET /models`, `GET/POST/DELETE /auth`, `POST /auto`,
  `POST /settings`, `POST /theme`, `GET /stats`, `GET /sessions`, `POST /complete`, `POST /embed`.

Events (`server/events.ts`, kind): `agent_event`, `agent_message`, `orchestration`, `approval_request`,
`usage`, `turn_summary`, `lock`, `session`, `session_reset`, `goal`, `awake`, `remote`, `theme`,
`resync`. The Go TUI decodes all of them into one flat struct, so a field name shared with another
event must keep that event's type: nest new data rather than adding top-level fields.

Slash commands (`commands/registry.ts`): `/goal /cancel /awake /remote /auto /manual /rewind /branch
/model /agents /tasks /status /cost /sessions /skills /mcp /lsp /permissions /debate /export /resume
/clear /init /help`, plus each client's own (`/theme`, `/quit`…) and project commands.

## Remote control (`src/remote/`, `niti-relay/`, `niti-mobile/`)

- **Sign-in**: email + a 6-digit code at the relay registers a device's ed25519 key under an account.
  From then on the key is the credential: each connection signs the relay's challenge. Codes expire
  in 10 minutes, allow 5 tries, and are capped at 10 an email a day. `/remote login` and `/remote code`
  sign a Mac in (shared by every core on it); the phone signs in on its first screen.
- **Pairing**: a Mac allows each phone once, through its normal approval queue, comparing a 6-digit
  code with the phone. The code comes from a commit-then-reveal exchange (the phone commits to a
  nonce, the Mac answers with its own, the phone reveals), so neither the relay nor anyone else on the
  account can choose a key that matches. A phone can never answer its own allow request.
- **Channel**: each connection exchanges fresh x25519 keys signed with the long-term keys pinned at
  pairing; frames are secretbox-sealed with direction + counter nonces (no replay, no reordering).
  The relay forwards only the small pairing exchange between a Mac and a phone it hasn't allowed.
- **What a phone may do**: the bridge replays its requests against the core's own API with the local
  token (which never leaves the Mac), through an allowlist of routes and an allowlist of commands.
  Never: keys (`/auth`), auto-approve, settings, the team, `/remote`, allowing devices. Approval edits
  are limited to file content. Every remote action shows on the Mac as a 📱 note.
- **Push**: approvals waiting, a goal that ended, errors, a Mac with a goal running going offline.
  Content-light (who and what kind, never code or commands), only to allowed phones not connected
  right now. A Mac also leaves an encrypted status on the relay for phones to read while it's offline.
- **Revoking**: `/remote revoke <phone>` signs it out at the relay and rotates the status key. Only a
  Mac can sign another device out, and only a phone.

## Testing

Everything runs against the repo's scripted model (`scripts/e2e/fakellm.ts`): no network, no cost.
Test cores never touch your real files: every harness sets the isolation env (`NITI_AUTH_FILE`,
`NITI_TRUST_FILE`, `NITI_REMOTE_FILE`…) in `scripts/e2e/*` and `niti-app/scripts/fixture.ts`.

| What | Command |
|---|---|
| Engine and dashboard unit tests | `bun test ./src ./web` · `bun run typecheck` |
| The whole CLI, end to end (core API, remote path, CLI, TUI, a real terminal, relay) | `zsh scripts/e2e/run.sh` |
| Desktop app (typecheck, tests, build, live, smoke, audit, perf) | `cd niti-app && npm run check` |
| Relay | `cd niti-relay && bun test && bunx tsc --noEmit` |
| Mobile | `cd niti-mobile && npm run typecheck && bun test ./src && npx expo export --platform ios` |
| Agent quality (before and after any agent-loop or tool change) | `bun run scripts/eval/run.ts --repeat 3` |

## Known ceilings

- One global shell lock rather than per path; the tool sandbox is path-jailed plus the OS sandbox,
  not a container.
- Same-agent retry on exhaustion rather than live reassignment.
- File watching has no debounce or full `.gitignore` parsing.
- MCP servers are shared by the team, not per agent.
- A core lives as long as the TUI or app that started it: a phone can't start niti on a Mac (no daemon yet).
- Phone denials last only for the core's lifetime. No refresh tokens: the device key is the credential.
- Not yet built: Live Activity, approving from the lock screen without opening the app, Android.

## History worth knowing

- **October 2026:** `/goal`, interrupting one agent, remote control (relay + iPhone app), and the
  commit-then-reveal pairing (the first version's code was a hash of public keys alone, which anyone
  on the account could match by trying keys). The archived v1 Ink TUI (`old-tech/`), a VS Code fork
  (`ide/`) and an earlier Electron app (`desktop/`) were deleted; none of them exists.
- **Bugs found in review, kept as lessons:** `compactTurns()` could split a tool call from its result
  (the cut now walks back); cancel didn't stop retry backoff or the final integrate; a reused task id
  could mis-resolve a dependency (now dropped); switching a busy agent's provider mid-loop could send
  one provider's history to another (now refused); the server's token check wasn't constant-time
  (now `timingSafeEqual`); `saveAgents()` used to rewrite the whole `agents.yaml` (now only `agents:`);
  the TUI's SSE reader couldn't tell a stop from a disconnect (now reconnects with seq replay).
