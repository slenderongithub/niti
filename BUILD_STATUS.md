# amux v2 — build status

This document records the overhaul implemented from `SOL_PROMPT.md`: a multi-agent CLI where a
chosen **orchestrator** model plans a task DAG, delegates to role-agents that **talk directly to
each other**, and streams the whole thing live to a terminal TUI and an optional web dashboard.

## Binaries and front ends

- **`amux`** — the Go + Bubbletea TUI (`tui/`), built via `bun run build:tui`. This is the **primary,
  maintained interactive front end** — it spawns `amux-core` as a subprocess and drives it over the
  local HTTP+SSE API.
- **`amux-core`** — the headless Bun/TypeScript engine + scripting CLI (`src/cli.ts`), built via
  `bun run build`. Used standalone for one-shot/CI runs, `serve`, `auth`, `init`, `--web`, and as what
  `amux` spawns.
- **`old-tech/ink-tui/`** — the original React/Ink interactive TUI, **archived, not deleted, not
  wired into the active build**. It was amux v1's interactive front end; `src/cli.ts` no longer
  imports or renders it. Kept for reference with its own `package.json`/`tsconfig.json` so it doesn't
  affect the root project's dependencies or `tsc`/`bun test`. See its own README for status.

## Architecture (as built)

```
  Go + Bubbletea TUI (tui/)              Web dashboard (web/, optional)
   wizard · agent panes · comm-feed        localhost force-graph of agents talking
        └──────────── HTTP + SSE (one event contract) ───────────┘
                                  ▼
                amux core  (src/, Bun + TypeScript)
   Engine (src/engine.ts) wires:
     · Orchestrator DAG:  planner.ts → scheduler.ts (topological, concurrent, hand-offs, integrate)
     · Inter-agent MessageBus (src/messaging) + send_message / ask_agent tools (src/agent/agent.ts)
     · Providers ×4 + Models.dev catalog (reused)  · tools sandbox · locks · approvals (reused)
     · Global auth store (src/auth/auth-store.ts)  · HTTP+SSE server (src/server/)
```

## What's implemented and VERIFIED (Bun + TypeScript)

All of the following is covered by `bun test` (142 tests, 0 fail) and `tsc --noEmit` (clean), plus a
live server smoke test:

| Area | Files | Verified by |
|---|---|---|
| Global typed auth store (auth.json 0600 + keychain, logout revokes) | `src/auth/auth-store.ts`, `src/keystore/keystore.ts` | `auth-store.test.ts` |
| Inter-agent messaging (routing, edge auth, rate cap, sync `ask` vs async `send`) | `src/messaging/message-bus.ts` | `message-bus.test.ts` |
| Orchestrator planner → validated DAG (zod, retry, fallback, robust JSON extraction) | `src/orchestrator/planner.ts` | `planner.test.ts` |
| Scheduler (topological order, concurrency, cycle rejection, hand-offs, integrate) | `src/orchestrator/scheduler.ts` | `scheduler.test.ts` |
| Agent loop + `send_message`/`ask_agent` tools + inbox injection | `src/agent/agent.ts` | `engine.test.ts` |
| Engine wiring + agent-to-agent `ask` (no output clobber, no double-delivery) | `src/engine.ts` | `engine.test.ts` |
| Local HTTP + SSE server (token auth, replay, routes, static dashboard) | `src/server/*` | `server.test.ts` + live smoke |
| CLI: `serve`, `auth login/list/logout`, `init` wizard, `--web`, interactive/one-shot/resume | `src/cli.ts` | live smoke + typecheck |
| Web dashboard (self-contained SSE force-graph, tasks, messages, usage) | `web/*` | served + asserted in `server.test.ts` |

The headline end-to-end path — orchestrator plans a DAG, a frontend agent **asks the backend agent
directly**, the answer flows back without clobbering the frontend's task output, and every message
streams over SSE — is asserted in `src/engine.test.ts` and `src/server/server.test.ts`.

## Go + Bubbletea TUI — compiled, vetted, and adversarially reviewed

`tui/` (entrypoint, SSE API client, onboarding wizard, live multi-agent view) was authored without a
Go toolchain, then built, reviewed, and fixed on a real machine:

```sh
cd tui && go mod tidy && go build -o ../amux-tui ./cmd/amux   # ✓ builds clean (bubbletea bumped to v1.1.0)
go vet ./...                                                    # ✓ clean
gofmt -l .                                                      # ✓ clean (nothing to format)
go test ./...                                                   # ✓ 2 packages with tests, all pass
```

`go mod tidy` resolved `bubbletea` to `v1.1.0` (up from the `v0.27.1` pinned at authoring time) with
no source changes needed. A smoke run confirmed the binary spawns the Bun core, parses its handshake
line, and detects setup/first-run mode correctly.

### Adversarial review — 14 confirmed findings, all fixed

Two review passes (one on the TS core alone, one across TS + the newly-compiled Go TUI) found and
fixed real bugs — each with a regression test:

**TypeScript core:**
- `compactTurns()` could split a tool-call/tool-result pair when `injectInbox()`'s extra turn shifted
  the parity of a fixed-size tail slice, corrupting the next provider call. Fixed: the cut point now
  walks back to never start on an orphaned `tool` turn (`src/agent/context.ts`).
- Cancellation didn't stop a task's exhausted-retry/backoff loop or the final integrate call — both
  now check `shouldStop()` (`src/orchestrator/scheduler.ts`).
- `MessageBus.restrict()`'s doc comment claimed the scheduler wired it from the plan's DAG; it never
  did. Rather than retrofitting that restriction (which would silently break the core "agents
  dynamically coordinate mid-task" feature the whole product is built around), the doc now matches
  reality: coordination is intentionally open (`allowAll()`), gated only by the per-pair rate cap.
- `normalizePlan()` could silently mis-resolve a dependency when the model reused an id across two
  tasks (last-write-wins clobbered the mapping); ambiguous ids are now tracked and dropped instead of
  guessed at (`src/orchestrator/planner.ts`).
- `Engine.switchModel()` had no guard against swapping an agent's provider while its `run()`/
  `respond()` was mid-loop, which could send one provider's turn history (e.g. Anthropic's opaque
  `raw` thinking blocks) to a different provider. `Agent` now tracks in-flight calls with a counter
  (not a boolean — `run()` and `respond()` can legitimately overlap via `ask_agent`) and rejects a
  live switch while busy (`src/agent/agent.ts`, `src/engine.ts`).
- The server's bearer-token check used `!==` instead of a constant-time comparison — a timing
  side-channel on the sole auth gate (`src/server/server.ts`, `timingSafeEqual`).

**Go TUI:**
- `truncate()` panicked (`slice bounds out of range`) on any terminal narrow enough to make a
  computed width ≤0 — a real crash on split panes/SSH clients. Now clamps instead of panicking.
- `StreamEvents` returned quietly on any disconnect (server restart, network drop) with no way for
  the caller to tell "asked to stop" from "should reconnect," so the TUI froze forever on the last
  frame. It now returns a distinguishable `ErrStreamDisconnected`, and `main.go` reconnects with
  capped backoff, tracking the last-seen `seq` so a reconnect only replays what was missed.
- The SSE line buffer was capped at 4MB with no distinct error on overflow, silently combining with
  the bug above; raised to 32MB with a documented ceiling and a real error on overflow.
- Approval keys (`y`/`a`/`n`) fired bare `go func(){}` goroutines with discarded errors and no
  synchronization, risking duplicate/misdirected approvals on a fast double-press. Converted to the
  idiomatic `tea.Cmd` pattern with an optimistic local pop so a stray keypress can't re-answer an
  already-resolved request; `/cancel` errors are now surfaced the same way `/prompt` already did.
- The wizard's "add at least one provider" gate was backed by a hardcoded-truthy placeholder and
  never actually fired; it now tracks real `SaveAuth` successes. `provider/model` input like `/opus`
  or `anthropic/` passed the old `strings.Contains("/")` check and produced a broken agent config
  with an empty provider or model; both stages now validate both sides are non-empty.

Regression coverage: `src/agent/context.test.ts`, `src/orchestrator/scheduler.test.ts`,
`src/orchestrator/planner.test.ts`, `src/agent/agent.test.ts`, `src/engine.test.ts`,
`src/server/server.test.ts`, `tui/internal/session/session_test.go`,
`tui/internal/wizard/wizard_test.go`.

## Run it

```sh
bun install
bun run build:tui                # builds ./amux (the Go TUI, primary interactive front end)
./amux                           # first run: onboarding wizard; then live plan/build/talk-to-each-other session

# headless/scripting (amux-core, what ./amux spawns under the hood):
bun run src/cli.ts init                      # headless onboarding wizard
bun run src/cli.ts "build me a clothing website for gen-z"          # one-shot, plain-text progress
bun run src/cli.ts --web "build me a clothing website for gen-z"    # + live web dashboard
bun run src/server/main.ts                   # headless core server (prints the JSON handshake ./amux reads)
```

## Known simplifications (ponytail ceilings)

- Same-agent retry-with-backoff on exhaustion rather than live reassignment to a different (possibly
  busy) agent — avoids concurrency races; upgrade if cross-agent failover is needed.
- Credential validation is deferred to first use (no live provider ping on `auth` save).
- Re-planning after integrate is not implemented (the orchestrator reviews + summarizes only).
- The web dashboard is a read-only viewer (no prompt submission from the browser).
