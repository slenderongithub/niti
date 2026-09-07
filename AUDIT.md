# niti — codebase audit

`niti` is a terminal-first tool for running multiple AI coding agents (across providers — Claude, GPT, Gemini, local, custom) concurrently as a team: an orchestrator plans a task DAG, agents message each other directly, work is checkpointed in SQLite with undo/rewind, and an optional web dashboard/graph view mirrors the TUI over SSE. The differentiator versus a single-agent tool like Claude Code, OpenCode, or Cursor Agent is real — multi-model orchestration with a visible task graph and cross-agent chat, not a reskin of the same one-agent-one-terminal model. Recent work (commit `5f33145`) also addresses failure modes those tools' users commonly complain about — silent goal-drift, noisy approvals, agents wandering out of scope — with genuine root-cause fixes and regression tests, not band-aids.

The findings below are from a full pass over the Go/Bun/TS backend, the vanilla-JS web dashboard, and the test/CI setup, using the project's code-review-graph tooling plus direct reading. Only things worth fixing are listed — no style nits.

## Critical

**1. The entire `web/` dashboard and graph viewer is excluded from typecheck.**
`tsconfig.json` only includes `src`, so `web/app.js` and `web/graph.js` — which parse untrusted-shaped SSE JSON straight off the wire — have no compiler safety net at all. A validly-parsed but wrong-shaped payload throws uncaught inside an unwrapped callback (e.g. `web/app.js:126-128` iterates `e.agents` with no guard if it's missing). The only thing standing between a malformed event and a broken dashboard is the hand-written test suite.

**2. Recursive file watching fails silently, and CI never exercises the failure path.**
`src/watch.ts:26-39` uses Node's recursive `fs.watch`, which is reliable on macOS/Windows but inconsistent across Linux kernels, filesystems, and containers. The failure is caught and swallowed with no user-facing warning — the "graph auto-updates on file changes" feature can just stop working with zero signal. CI only runs `ubuntu-latest`, so this exact scenario is never tested. This is the same "flaky watcher → stale state" complaint people already make about competing tools, except here there isn't even an error message pointing at the cause.

## Important

**3. Zero accessibility in the web dashboard/graph.**
No ARIA roles, `tabindex`, or `alt` text anywhere in `web/`. Both views are canvas-only with mouse/pointer-only interaction (a few keyboard shortcuts exist, but nodes themselves aren't focusable), and status is conveyed by color hue alone. If the dashboard is meant to be a selling point over a plain terminal, this undercuts it for anyone not using a mouse.

**4. Race condition on rapid view/mode switching.**
`loadProject()`/`loadModels()` (`web/graph.js:64-119`, pre-fix) have no abort/epoch guard — a stale fetch resolving after a newer one can silently overwrite the current view with old data if the user switches modes quickly.

**5. Theme default palette is hand-duplicated in three places.**
The same fallback colors are copy-pasted across `web/style.css`, `web/graph.html`'s inline `<style>`, and `web/avatar.js`'s `THEME_DEFAULTS`, with no single source of truth. `graph.html`'s copy can already drift from `style.css`'s.

**6. Shell "safe command" allowlist may not close pipe/redirect smuggling.**
`SAFE_SHELL_RULES` (`src/permissions.ts:42`) allowlists commands by name (`ls`, `cat`, `git status`, etc.). It's unclear whether it also inspects for pipes, redirects, or subshells that could let a "read-only"-labeled call perform a write (e.g. `cat file | tee other`). Worth an explicit check — this is exactly the kind of gap that turns into a real permission bypass as agents get more creative with shell syntax.

**7. `src/orchestrator/worktree.ts` (git worktree lifecycle) is barely tested.**
Only one round-trip test exists for create/discard/prune/merge-abort logic. The failed-commit → best-effort `checkout -` recovery path (`worktree.ts:106-123`) is completely unverified — precisely the kind of path that leaves a repo half-migrated when it fails partway.

**8. `resolveWebDir()` silently falls back across 4 candidate paths with no coverage of all deployment shapes.**
`src/server/server.ts:392-403` picks the dashboard's static file directory from 4 possible locations (repo checkout, compiled binary, npm install, dev build) with no test proving all 4 resolve correctly. A packaging regression would 404 the whole dashboard silently in exactly one of those shapes.

**9. Scheduler's role-keyed concurrency slot has an untested invariant.**
`src/orchestrator/scheduler.ts:296-330` — a mid-flight task redirect changes `t.role` specifically to avoid leaking a concurrency slot. The comment documents why, but there's no regression test isolating the redirect-during-flight race, despite `scheduler.test.ts` being 415 lines. Easy to silently reintroduce the exact bug that comment describes fixing.

**10. No debounce in the file watcher.**
`src/watch.ts` emits one event per raw fs notification (acknowledged as a deferred simplification). Combined with #2, a formatter running across many files or an editor's atomic-rename save pattern could double-fire graph refreshes. (Partially mitigated client-side now — see "Fixed" below — but the server-side firehose itself is still unthrottled.)

## Minor

**11. Duplicated O(n²) physics vs. Barnes–Hut.**
The dashboard's mini force-sim (`web/app.js:406-431`) reimplements node-node repulsion at O(n²) — fine for its small agent count, but `web/graph.js:191-237` already solves the same problem with Barnes–Hut. Two implementations, no shared module.

**12. Error-surfacing pattern copy-pasted 3+ times.**
`web/app.js`'s action handlers (`submitPrompt`, `sendAgentMessage`, the model-swap handler) each independently reimplement "read JSON, fall back to string, show in a status span" instead of sharing one helper.

**13. Shell tool arg parsing doesn't handle quoting.**
`src/tools/tools.ts:262` splits a raw command string on whitespace when a model sends a full command line instead of the documented `args[]` array — `echo 'a b'` splits wrong. Narrow (only affects less-compliant models not using `args[]`), but real.

## Fixed during this audit

**/graph didn't update live — it required a manual refresh to show new/changed files, unlike an Obsidian-style graph view.** Root cause: the server already knew about every file change (the watcher publishes an `external_change` event over the existing SSE stream) and the client already had an incremental, position-preserving graph-merge function (`setGraph()`) — but `web/graph.js` never opened an SSE connection outside of "models" mode, so nothing was listening for the signal, and the server's 10s graph cache could still serve stale data right after a change. Fixed by: keeping one SSE connection open for the life of the page regardless of view mode, debouncing a refetch on `external_change`, and invalidating the server's graph cache on the same event. No new event types or incremental-patch protocol needed — the pieces already existed and just weren't wired together.

## Confirmed non-issues (checked, not skipped)

- Commit `5f33145` ("Fix approval noise, silent goal-drift, and agent wandering") is a genuine root-cause fix with regression tests — path-jail bypass attempts, mid-run plan discarding, and an inbox/turn-ending race are all covered, not just papered over.
- No command-injection vector: every git/shell exec site uses argv arrays, never string-concatenated shell invocation.
- `safePath` correctly blocks `..` traversal; the symlink-escape limitation is documented, not hidden.
- Keystore's broad catch blocks are intentional OS-keychain → env-var fallback chains, not silent data loss.
