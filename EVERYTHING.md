# EVERYTHING.md

**A complete architectural record of `amux`, written as a pre-publish audit.**

Audit date: 2026-08-04 · Branch `main` · HEAD `a861b44` · working tree dirty (5 files)

This document is the *descriptive* half of the audit: what the system is, how every part of it
actually works, and every observation, quirk and edge case found while reading it. It does not
rank or prescribe — that is [`lastminutechanges.md`](./lastminutechanges.md), the *prescriptive*
half, which carries the 144 ranked, actionable findings.

---

## How this audit was produced

Eight independent readers were given one subsystem each and told to read the real files — not to
summarise the README — and to quote real identifiers, real line numbers and real command output.
Their claims were then handed to 58 adversarial verifiers, one per critical/high finding, each
instructed to *refute* it and to default to "refuted" when it could not concretely confirm the
claim. A final completeness critic diffed the coverage against the file tree and filled the gaps.

- **67 agents · 1,422 tool calls · ~3.2M tokens · 58 minutes.**
- **132 findings** from the readers, **58** escalated to adversarial verification.
- **0 refuted, 30 downgraded in severity.** The findings are real; several were overstated. Every
  severity in `lastminutechanges.md` is the *post-verification* severity, and where it differs from
  the original claim that is stated inline.
- **12 further findings** from the completeness critic, plus 74 medium/low from the readers.
- The most consequential claims in this document were additionally re-verified by hand, directly,
  before being written down.

Where a statement here says "verified" or quotes command output, that command was actually run.

---

## Verified build and test state

Measured on darwin-arm64, Bun 1.3.10, Go 1.22, **in the maintainer's working copy**:

| Check | Command | Result |
| --- | --- | --- |
| TypeScript | `bun run typecheck` (`tsc --noEmit`) | **exit 0**, clean |
| Unit + integration | `bun test` | **275 pass / 0 fail**, 3,225 assertions, 41 files, 6.85s |
| Go TUI | `cd tui && go build ./... && go test ./...` | **passes** (session, theme, wizard) |
| Compiled core | `./amux-core --help` (or any argv) | **exit 1 — crashes at module load** |
| Package tarball | `npm pack --dry-run` | 135 files, 268.8 kB, **zero executables** |

The first three lines are genuinely green and the codebase deserves credit for that. The important
caveat is that **they are green only here.** On a clean clone:

- `tui/cmd/amux/main.go` does not exist in the repository at all — `.gitignore:2`'s unanchored
  `amux` pattern ignores the directory `tui/cmd/amux/`, so `bun run build:tui` fails.
- `bun test` picks up 5 test files under `old-tech/ink-tui/` that import `ink` and `react`. Neither
  package is in `package.json` or `bun.lock`; both are present in this machine's `node_modules` as
  leftovers. A fresh `bun install` therefore turns the suite red.

Both were confirmed by hand (`git check-ignore -v`, `git ls-files`, `grep` over `package.json` and
`bun.lock`). See findings 1 and 2 in `lastminutechanges.md`.

---

## What amux is

A terminal CLI that runs several AI coding agents — each on its own provider and model — as a team
against one project. A lead agent decomposes a prompt into a task DAG; the other agents drain it
concurrently, talking to each other over a message bus, writing files through an approval-gated
sandbox, with every turn persisted to SQLite so a session can be resumed, undone or rewound.

~17,300 lines across three languages and three deliverables:

| Component | Language | Role | Lines |
| --- | --- | --- | --- |
| `amux` | Go + Bubbletea (`tui/`) | The **primary** interactive front end | ~3,900 |
| `amux-core` | TypeScript on Bun (`src/`) | The headless engine, HTTP/SSE server and scripting CLI | ~7,500 |
| dashboard | Vanilla JS (`web/`) | Optional live web view, incl. a 730-line force-directed graph | ~2,700 |
| tests | TS + Go | 41 Bun test files, 4 Go packages | ~3,200 |

The two binaries are **not peers**. `amux` (Go) is what a user runs; it spawns the core as a
subprocess, reads a one-line JSON handshake from its stdout, and then drives it entirely over
HTTP + Server-Sent Events on `127.0.0.1` behind a bearer token.

### Runtime topology

```
        user
         │
    ./amux  (Go TUI, Bubbletea, alt-screen)
         │  spawn: `bun run src/server/main.ts`
         │  ← one JSON line on stdout: {"amuxServer":{"url","token"}}
         ▼
    amux-core  (Bun)
         │
    Bun.serve on 127.0.0.1:<random>  ── bearer token on every data route
         ├── GET  /events        SSE — the single fan-out stream
         ├── POST /prompt        submit a goal
         ├── POST /commands/<n>  the 21 slash commands (server-side, shared by both clients)
         └── GET  /dashboard     static web/ assets  ─────► browser (token via ?token=)
         │
      Engine
         ├── Orchestrator ── task DAG, cycle detection, ready-queue
         ├── Scheduler ───── concurrency (1 task per agent), retries, replan, review gate
         ├── Agent[] ─────── per-agent tool loop, ≤12 turns, auto-compaction at 95% context
         ├── MessageBus ──── agent↔agent send_message / ask_agent
         ├── ApprovalQueue ─ write_file / shell gating
         ├── LockRegistry ── per-path locks + one global shell lock
         ├── SessionStore ── bun:sqlite → .amux/amux.db (sessions→messages→parts, checkpoints)
         └── LSP + MCP ───── spawned language servers and MCP stdio servers
```

### On-disk state

| Path | Written by | Contents |
| --- | --- | --- |
| `.amux/agents.yaml` | user, TUI picker, `POST /agents`, `POST /theme` | roster, permissions, MCP, LSP, options, theme |
| `.amux/amux.db` (+`-wal`,`-shm`) | `SessionStore` | conversations, parts, checkpoints, bus messages |
| `.amux/session.json` | `saveTasks` | the task board, for `resume` |
| `.amux/worktrees/<id>` | `--worktree` runs | isolated git worktrees |
| `.amux/skills/`, `.amux/commands/` | user | injected skill prompts, custom slash commands |
| `~/.config/amux/auth.json` | `auth-store` | credentials, 0600 in a 0700 dir, mirrored to the OS keychain |

Every one of these is resolved relative to **`process.cwd()`**, not to a discovered project root.
That single fact drives a whole family of findings.

---

## The distribution reality

This is the part the audit was really commissioned for, so it is stated plainly up front.

**`amux` cannot currently be published to NPM in any form that works.** Not "needs polish" — the
three artefacts a global install would need are each independently non-functional today:

1. **`package.json` is `"private": true`**, version `0.0.1`, and its only `bin` entry is
   `"amux-core": "./src/cli.ts"` — a raw TypeScript file whose shebang is `#!/usr/bin/env bun`.
   npm and Node cannot execute either the `.ts` extension or that interpreter. There is no `files`
   field and no `.npmignore`.
2. **The compiled `amux-core` binary crashes on startup, on every command, on the machine that
   built it.** `bun build --compile` cannot embed `node-pty`'s native `.node` addon, so module
   resolution fails before `main()`. Verified directly:
   ```
   $ cd /tmp/empty && /Users/slender/Developer/Codes/amux/amux-core --help ; echo $?
   error: Failed to load native module: pty.node, checked: build/Release, build/Debug,
          prebuilds/darwin-arm64: … from node_modules/@napi-rs/keyring/index.js
   1
   ```
   The dependency responsible — plus `@xterm/xterm`, `@xterm/addon-fit` and the `postinstall`
   hook — exists solely for the browser-terminal route, which `src/server/server.ts:332-339`
   documents as non-functional under Bun. **Four of the ten runtime dependencies serve one broken,
   uncallable feature, and one of them breaks the build product.**
3. **The Go TUI cannot find its core outside a repo checkout.** `tui/cmd/amux/main.go:49` resolves
   it as the cwd-relative literal `"src/server/main.ts"` and runs `bun run` on it — no
   `exec.LookPath`, no `os.Executable()`-relative resolution, no reference to the `amux-core`
   binary anywhere in `tui/`. A globally installed `amux` run from a user's project fails at the
   handshake.

Additionally, `npm view amux` shows the name is **already registered** to another maintainer
(`donavon`, v0.0.0), so the package would need a scope or a new name regardless.

The tarball `npm pack` produces today ships the maintainer's personal `.amux/agents.yaml`, the
dead `old-tech/ink-tui/` tree, every `.test.ts`, the full Go source — and **no executable at all**,
because `.gitignore` excludes both binaries and there is no `files` field to override it.

A concrete, staged shipping strategy is given at the end of `lastminutechanges.md`.

---

## What is genuinely well built

An honest audit records the strengths, not only the defects. These are load-bearing and should
survive any refactor:

- **The security posture of the local server is correct by default.** `Bun.serve` binds
  `127.0.0.1` explicitly (`server.ts:129`), every data route is behind a bearer token, and the
  token comparison is `timingSafeEqual` with a length pre-check (`server.ts:416-421`). Credentials
  are redacted before they cross the wire (`server.ts:408-410`).
- **The sandbox boundary is real and deliberately marked.** `safePath()` (`tools/tools.ts:19-25`)
  resolves then rejects escapes, and carries a `SECURITY BOUNDARY — do not simplify` comment plus
  an explicit `ponytail:` note naming symlink traversal as the known ceiling.
- **No shell injection surface in the tool layer.** Both `tools.ts:35` and `worktree.ts:18` use
  `spawn(cmd, argsArray)` and never `exec`/`shell: true`, and say so in comments.
- **The permission model is well designed.** Layered agent → project → `--auto` → defaults, with
  longest-literal-wins specificity and ties broken toward the *stricter* decision
  (`permissions.ts:54-64`) so a careless config cannot silently become more permissive. `deny`
  short-circuits before the approval queue and holds in headless mode.
- **Dangerous commands cannot be waived.** `DANGEROUS_PATTERNS` (`agent.ts:33-39`) forces a prompt
  even under a standing grant: `mustAsk = dangerous || decision !== "allow"`.
- **Loops are bounded everywhere it matters**: `MAX_TURNS` 12, `MAX_RESPOND_TURNS` 6,
  `MAX_FORK_DEPTH` 2, `MAX_ASK_DEPTH`, `MAX_ATTEMPTS` 3, `MAX_REPLAN_ATTEMPTS` 1,
  `MAX_REVIEW_ROUNDS` 2 — each a named constant with a comment explaining the number.
- **Context is managed, not hoped about.** A warning fires at 85% of the context window and
  automatic compaction at 95% (`agent.ts:25-26, 208-227`).
- **Cycle detection before scheduling.** `detectCycle` (`scheduler.ts:38-64`) is a real DFS that
  returns the offending path so the error names the cycle instead of deadlocking.
- **Slash commands live server-side** (`commands/registry.ts`) so the TUI and the web dashboard
  cannot drift apart — a genuinely good call.
- **The comments are unusually honest.** `server.ts:332-339` documents its own broken pty feature
  in detail and tells the reader not to re-diagnose it; `ponytail:` markers name deliberate
  shortcuts and their upgrade paths. This is rare and made the audit far faster.
- **Test density is high where it counts**: 275 passing tests, 3,225 assertions, including real
  end-to-end coverage of the scheduler, locks, permissions, approvals and the message bus.

---

## Reading guide

The rest of this document is the per-subsystem record: **119 architecture notes** and **179
observations** across eight sections, then the completeness critic's cross-cutting pass (a further
**15 notes** and **21 observations**) — **134 and 200 in total** — then the appendices.

Architecture notes are neutral descriptions of how something works. Observations are the small
stuff — edge cases, quirks, dead code, magic numbers, naming inconsistencies, stale comments —
recorded regardless of whether they matter, because the brief was to record everything.

---

## 1. The `amux-core` CLI — entry point, argument parsing, command UX

### Argument parsing is hand-rolled, positional, and structured as a chain of independent top-level `if` blocks — not a dispatcher

`src/cli.ts:33` does `const args = process.argv.slice(2)` and then never builds a parsed-options object. Dispatch is five sequential, non-exclusive top-level `if` statements evaluated in file order: `keys` (line 40), `login` (51), `auth` (61), `serve` (82), `--web` (97), `init` (115), and finally the headless engine block (123). There is no `switch`, no `else`, and no early `return` — each branch relies on calling `process.exit()` itself, except `serve`, which deliberately falls through and relies on `Bun.serve` keeping the event loop alive. Because of that fall-through, the three later blocks each have to re-assert the negation by hand: line 97 `args[0] !== "serve" && args.includes("--web")`, line 115 `args[0] === "init"`, and line 123 `args[0] !== "serve" && !args.includes("--web") && args[0] !== "init"`. Adding a sixth subcommand requires editing that compound guard on line 123 as well, or the new subcommand silently also runs as a task prompt.

*Files:* `src/cli.ts`

### The final `if` block is a catch-all that treats any unrecognised argv as LLM task text

`src/cli.ts:125` computes `const goal = resume ? "" : args.filter((a) => !a.startsWith("--")).join(" ").trim()`. Anything that isn't `serve`/`init`/`keys`/`login`/`auth` and doesn't contain `--web` becomes the prompt. Verified by running `bun src/cli.ts stauts` in an empty directory: it went straight to `buildEngine`, failed only because no agents were configured, and printed `amux: no agents configured. Run 'amux-core init'…` with exit 1. With a real `.amux/agents.yaml` present, a typo'd subcommand is submitted to a paid model. The `!a.startsWith("--")` filter is the only flag handling in this path — it strips flags from the prompt text but never validates them.

*Files:* `src/cli.ts`

### Two independent server bootstraps exist, and the one the Go TUI actually uses is not `amux-core serve`

`src/cli.ts:82-95` implements `serve` (parse `--port=`, call `serveMain`, print a stderr banner, register a SIGINT handler). `src/server/main.ts:60-67` implements a second, near-identical bootstrap under `if (import.meta.main)` — it re-parses `--port=` from `process.argv` and re-reads `--auto`, but ignores `--worktree` and registers no SIGINT handler. `tui/cmd/amux/main.go:48-51` shows the Go TUI spawns `exec.Command(bunBin, "run", entry)` with `entry := envOr("AMUX_CORE_ENTRY", "src/server/main.ts")` — i.e. the real production path is `bun run src/server/main.ts`, so the `serve` branch in cli.ts (and its SIGINT handler) is dead in the TUI flow. The cli.ts header comment on line 11 (`amux-core serve [--port=N] → start the local core server (what the Go TUI connects to)`) is stale relative to that.

*Files:* `src/cli.ts`, `src/server/main.ts`, `tui/cmd/amux/main.go`

### Two engine constructors exist with divergent defaults: `buildEngine` in cli.ts vs `serveMain` in server/main.ts

`src/cli.ts:164-188` (`buildEngine`) and `src/server/main.ts:21-57` (`serveMain`) both load agents/options/skills/MCP/LSP/permissions and construct an `Engine`, with meaningful differences: serveMain tolerates a missing `.amux/agents.yaml` and starts in "setup mode" with `configs = []` (main.ts:23-25), while buildEngine calls `loadAgents()` unconditionally and lets it throw into `surfaceStartupError`; serveMain defaults `watch: options.watch ?? true` (main.ts:47) while buildEngine passes `watch: options.watch` (cli.ts:185) so watching is off unless explicitly configured; serveMain calls `engine.orch.load(loadTasks())` unconditionally (main.ts:52) while cli.ts only does so under `resume` (cli.ts:144). Both duplicate the same seven `load*()` imports.

*Files:* `src/cli.ts`, `src/server/main.ts`

### Headless progress output is line-oriented and stream-split, with no colour anywhere

`src/cli.ts:148-152` subscribes to `engine.bus` and drops `delta` events (streaming chunks) so scripted output stays one line per event, formatting `[${e.agentId}] ${e.type}: ${e.payload}`. Errors go to `console.error`, everything else to `console.log` (line 151). There is no ANSI escape, chalk dependency, or `isTTY` check anywhere in cli.ts, registry.ts, or export.ts — output is byte-identical piped or not. The only non-ASCII output is decorative glyphs: `★` (registry.ts:103), `● ◐ ✖ ○` (registry.ts:260 `TASK_GLYPH`), `●/○` (registry.ts:152), and `✓` (cli.ts:255).

*Files:* `src/cli.ts`, `src/commands/registry.ts`

### Error surfacing is centralised in `die()`/`surfaceStartupError()` and deliberately strips stacks — except in two async `.catch` paths

`src/cli.ts:34-37` defines `die(msg): never` → `console.error('amux: ' + msg)` + `process.exit(1)`. `surfaceStartupError` (190-194) unwraps `err instanceof Error ? err.message : String(err)` and special-cases `/ENOENT|agents\.yaml/` into the friendly `no agents configured. Run 'amux-core init'…`. No stack ever reaches the user through those. But `src/cli.ts:105` does `engine.submit(goal).catch((e) => console.error("run error:", e))` — passing the raw error object, which console.error renders with its full stack — and `src/cli.ts:172` prints raw MCP connect errors via a template string.

*Files:* `src/cli.ts`

### Slash commands are server-side data, exposed over two HTTP routes, and consumed only by the Go TUI

`src/commands/registry.ts:16-26` defines `CommandResult {ok, message, view?}` and `Command {name, description, run}`. `CommandRegistry` (296-335) is a `Map<string, Command>` populated from `[...BUILTIN_COMMANDS, ...loadCommands()]` by default (line 300), with `/help` injected afterwards (304-315) so it can see the finished map. `src/server/server.ts:198` serves `GET /commands` → `commands.list()`, and `:199-205` serves `POST /commands/<name>` with a JSON `{args}` body, always returning HTTP 200 so the command's own `ok` field carries the outcome. The Go side consumes it at `tui/internal/session/session.go:436` (`m.menuOpen = strings.HasPrefix(text, "/") && !strings.Contains(text, " ")`) and `:471` (`strings.Cut(strings.TrimPrefix(text, "/"), " ")`).

*Files:* `src/commands/registry.ts`, `src/server/server.ts`, `tui/internal/session/session.go`

### Twenty built-in commands plus a file-backed user command loader with override semantics

`BUILTIN_COMMANDS` (registry.ts:36-258) is, in registry order: usage, cancel, undo, rewind, branch, model, sessions, agents, tasks, skills, mcp, lsp, permissions, cost, status, debate, export, resume, clear, init — with `help` appended by the constructor. That exact order is asserted in `registry.test.ts:143-147`. `loadCommands(dir = ".amux/commands")` (registry.ts:272-294) reads `*.md`, parses optional `---`-delimited YAML frontmatter with `yaml.parse`, falls back to the filename for `name`, and builds a `run` that substitutes `$ARGUMENTS` (line 286) then calls `engine.submit`. User commands are appended after builtins so a same-named user command overwrites the builtin in the Map (line 300 comment, asserted in registry.test.ts:132-138).

*Files:* `src/commands/registry.ts`, `src/commands/registry.test.ts`

### Command errors never escape the registry; unknown names are data, not exceptions

`CommandRegistry.run` (registry.ts:326-334) looks up the name, returns `{ok:false, message: 'unknown command: /'+name}` on a miss, and wraps the invocation in try/catch converting any throw into `{ok:false, message: '/'+name+' failed: '+message}`. So a crashing command degrades to a red line in the TUI rather than killing the core server. Asserted at registry.test.ts:106-108. Note the asymmetry: this safety net covers command *execution* but not command *loading* — `loadCommands` runs in the constructor's default parameter and is unguarded.

*Files:* `src/commands/registry.ts`

### Task board persistence is a relative-path JSON file; conversation history is SQLite

`src/session.ts:7` hardcodes `const DEFAULT = ".amux/session.json"` — a path relative to `process.cwd()`, not to `engine.root`. `saveTasks` (11-14) does `mkdirSync(dirname(path), {recursive:true})` then a single `writeFileSync(JSON.stringify({tasks}, null, 2))`. `loadTasks` (16-20) returns `[]` for a missing file and otherwise `JSON.parse`s with no try/catch, guarding only the shape (`Array.isArray(data.tasks)`). `resumeConversation` (24-26) flattens every stored session for a task id into one `Turn[]` via `store.listSessions({taskId}).flatMap(s => store.loadTurns(s.id))` — that is what seeds a resumed agent and what `/export` renders.

*Files:* `src/session.ts`

### `/export` builds a full audit report from data the engine already holds, in six fixed sections

`buildExportReport` (export.ts:46-97) emits `# amux session export`, then Project/Goal, `## Tasks` (via `taskLine`, 15-19), `## Cost` (per-agent via `costOf`, with a `+` suffix when any model is unpriced), `## Diff patch` (only when `engine.worktreeHandle` is set, else an explicit `_not available_` line), `## Test status (best-effort)` (regex heuristics `FAIL_RE`/`PASS_RE` at lines 37-38 scanning `t.output + t.acceptance`, honestly labelled 'self-reported, not verified'), and `## Transcripts` (per task, `resumeConversation` → `renderTurn`). Output path is `join(engine.root, ".amux", "reports", isoStamp + ".md")` (91-95), and `.amux/reports/` is gitignored (.gitignore:8).

*Files:* `src/commands/export.ts`, `.gitignore`

### UsageTracker is a two-map accumulator with defensive-copy reads

`src/usage.ts:15-51`. `byAgent: Map<string, AgentUsage>` accumulates `inputTokens`/`outputTokens`/`calls` and overwrites `lastInput` with each call (line 24) so `lastInput` doubles as 'current context depth' (documented at line 6). `rateLimits: Map<string, RateLimitSnapshot>` keeps only the newest per provider (line 29, asserted in usage.test.ts:17-22). `snapshot()` spreads each usage object so callers can't mutate internal state (line 33), but `rateLimits_()` (48-50) returns the stored objects by reference. `totals()` re-sums on every call rather than maintaining a running total.

*Files:* `src/usage.ts`

### The project watcher is a thin `fs.watch` wrapper with a TTL-based self-write suppressor and a fail-open constructor

`src/watch.ts:26-52`. `watch(root, {recursive:true}, cb)` is wrapped in try/catch (29-41) so a platform without recursive watch yields a watcher-less object whose `markSelfWrite`/`close` remain valid no-ops. Filtering is a path-segment set membership test (`IGNORED_SEGMENTS`, line 11; `isIgnored`, 17-19) — segment match, not substring, asserted at watch.test.ts:61. Self-write suppression is a `Map<string, number>` of relative paths checked against `SELF_WRITE_TTL_MS = 2_000` (line 35), pruned opportunistically inside `markSelfWrite` (line 46) so no timer is needed. Wired at engine.ts:126 via `onWrite: (path) => this.watcher?.markSelfWrite(path)`, which agent.ts:468 calls with the raw model-supplied `lockPath`.

*Files:* `src/watch.ts`, `src/engine.ts`, `src/agent/agent.ts`

### Credential entry has two code paths with different validation and both echo secrets in cleartext

`amux-core keys set <provider>` (cli.ts:40-49) calls Bun's global `prompt()` and `setKey(args[2], key)` straight into the OS keychain with no catalog lookup. `amux-core auth login [provider]` (cli.ts:74-77 → `authLogin`, 197-221) does validate against `CATALOG` (line 199-200), branches on `entry.client === "copilot"` into the device flow, on `category === "local" || keyOptional` into a base-URL prompt, and otherwise stores `{type:"api", key}` via `setCredential`. `setCredential` writes `~/.config/amux/auth.json` at 0600 inside a 0700 dir (auth-store.ts:35-44) and mirrors into the keychain. Bun's `prompt()` has no masking, so the key is echoed to the terminal and lands in scrollback in both paths.

*Files:* `src/cli.ts`, `src/auth/auth-store.ts`

### `runInit` is an unbounded prompt loop that writes agents.yaml directly

`src/cli.ts:225-267`. Loop 1 (227-230) repeatedly calls `authLogin()` until the 'Add another provider?' answer isn't `y`. Loop 2 (235-257) collects `provider/model` + role name + allowed tools, slugifies the role into an id (`role.toLowerCase().replace(/[^a-z0-9]+/g,"-")…`, line 249) with a `while (usedIds.has(id)) id += "-2"` collision suffix (line 250), and defaults tools to `read_file,write_file,edit,shell` (line 253). It then asks which role is the orchestrator, clamps the answer with `Math.max(0, Math.min(roles.length - 1, (Number(pick) || 1) - 1))` (line 262), sets `lead` on exactly one role (263), and calls `saveAgents(roles)`.

*Files:* `src/cli.ts`

### Observations, edge cases and minor notes (21)

- `src/cli.ts` — `src/cli.ts` has no `.test.ts` sibling — `ls src/cli.test.ts` → No such file. The entire argv-parsing surface, every subcommand branch, `die()`, `surfaceStartupError()`, `authLogin()`, `runInit()` and `openBrowser()` are untested. Every other file in this area has a test sibling.
- `src/cli.ts:35` — `die()` prefixes messages with `amux: ` but the binary is `amux-core` (package.json bin) and `amux` is the *Go TUI*. Every error line from the core therefore appears to come from the TUI. Verified: `bun src/cli.ts keys` → `amux: usage: amux-core keys set <provider>`.
- `src/cli.ts:142` — `throw err` on line 142 is unreachable — `surfaceStartupError` is declared `: never` on line 190 so TS already narrows. The comment says as much (`// unreachable (surfaceStartupError exits)`). Dead line kept only for the compiler's benefit.
- `src/cli.ts:85` — `--port=` is parsed with the magic number `slice(7)` in two places (cli.ts:85 and server/main.ts:61) — the literal 7 is `"--port=".length` written out by hand, twice.
- `src/cli.ts:132` — The no-task banner (cli.ts:128-133) advertises `init · serve · auth · resume · --web` but omits `keys`, `login`, `--auto` and `--worktree`, all of which the file's own header comment (lines 8-15) documents. There is no `help` subcommand at all.
- `README.md` — README.md never mentions `--worktree` or `keys set` — `grep -n 'worktree\|keys set' README.md` returns nothing. `--worktree` is documented only in the cli.ts header comment and as an `agents.yaml` option.
- `src/cli.ts:182` — `--auto` and `--worktree` are OR-ed with their config equivalents (`args.includes("--auto") || options.auto`, cli.ts:182/186; the same pattern is commented in server/main.ts:44 as "neither can turn the other off"). There is no `--no-auto` escape hatch once `auto: true` is in agents.yaml.
- `src/commands/registry.ts:19` — `CommandResult.view` is typed as `string` and documented as `"panes" | "graph" | "usage"` (registry.ts:19), but only `view("usage")` is registered (line 37). `/panes` was removed in commit f8b914b; the comment and the single-use `view()` factory helper (28-34) are both leftovers of a three-view design.
- `src/commands/registry.ts:12` — The stated rationale for putting slash commands on the server — "otherwise the web dashboard needs an identical second implementation of every one of them" (registry.ts:12-14) — is currently unrealised: `grep -rn commands web/` returns nothing. Only the Go TUI calls `GET /commands` / `POST /commands/<name>`.
- `src/server/server.ts:195` — `POST /undo` at server.ts:195 duplicates the `/undo` slash command (registry.ts:47-52) — both are a bare `engine.undo()`. Two routes to the same one-liner.
- `src/commands/registry.ts:57` — `/rewind` argument parsing swallows junk: `Math.max(1, parseInt(args.trim(), 10) || 1)` turns `/rewind abc` into 1, `/rewind -5` into 1, and `/rewind 1e9` into 1 (parseInt stops at `e`). No feedback that the argument was ignored.
- `src/commands/registry.ts:78` — `/model` passes `splitModelId(undefined, modelId)`, which returns `{provider: "", model: modelId}` when the head before the slash isn't in CATALOG (catalog.ts:166-174). So `/model a bogus/x` reaches `engine.switchModel` with an empty provider rather than being rejected with 'unknown provider'.
- `src/usage.ts:48` — `UsageTracker.rateLimits_()` has a trailing underscore purely to dodge the private field of the same name (usage.ts:17 vs 48). It is also the only method in the file that returns internal objects by reference, unlike `snapshot()` which spreads.
- `src/watch.ts:11` — `IGNORED_SEGMENTS` covers `.git, node_modules, .amux, dist, build, .next, target, vendor` but not `.venv`, `__pycache__`, `coverage`, `.turbo`, or `.pytest_cache` — a Python or monorepo project will see watcher churn from those.
- `src/watch.ts:38` — The `catch {}` around `fs.watch` (watch.ts:38-41) is entirely silent. On a platform without recursive watch, the user gets a fully functional-looking watcher that never fires and no diagnostic, while `/status` still reports the session as normal.
- `src/commands/export.ts:27` — `export.ts` truncates tool *output* to 300 chars (line 32) but dumps tool *input* in full via `JSON.stringify(rest)` (line 27). A single `write_file` of a large file therefore inlines the whole file content into the report on one line.
- `src/commands/export.ts:91` — The export filename stamp `new Date().toISOString().replace(/[:.]/g,"-")` (export.ts:91) has millisecond resolution and no collision guard — two `/export` calls in the same millisecond silently overwrite. Practically unreachable, but the write is a bare `writeFileSync` with no existence check.
- `src/session.ts:13` — `saveTasks` writes with a plain `writeFileSync` (session.ts:13) — no temp-file-and-rename. A crash mid-write leaves a truncated `.amux/session.json`, which `loadTasks` then throws on (see findings).
- `src/commands/export.ts:38` — `selfReportedTestStatus`'s PASS_RE includes a bare `✓` inside a `\b…\b` word-boundary group (export.ts:38). `\b` around a non-word character behaves unintuitively; combined with the fact that agents routinely emit `✓` as a generic success glyph, a task whose output merely contains a checkmark is reported as 'possibly passing'.
- `src/cli.ts:250` — `runInit`'s duplicate-id resolver appends `-2` repeatedly rather than incrementing: three roles named 'Engineer' become `engineer`, `engineer-2`, `engineer-2-2`.
- `src/commands/registry.test.ts:143` — `registry.test.ts:143-147` pins the exact order and membership of `list()`, so any new built-in command is a guaranteed test failure until the list is updated — an intentional trip-wire worth knowing about before adding commands.


---

## 2. The agent loop — tools, permissions, approvals

### The turn loop: one `for` bound, three exits, two nested loop bodies

`Agent.run()` (src/agent/agent.ts:174-255) is a plain `for (let i = 0; i < this.maxTurns; i++)` (line 197). Each iteration: `injectInbox(turns, sessionId)` → `buildTools(allowed, ctx)` → `await this.provider.send(systemPrompt, turns, tools, onDelta)` → usage/rate-limit bookkeeping → optional compaction → if `reply.toolCalls.length === 0` push the final assistant turn, mark the session done, publish a `done` event and `return "done"` (lines 228-233); otherwise execute every tool call sequentially, push the assistant turn *then* the tool turn, and iterate. Falling out of the `for` also returns `"done"`, with payload `"(turn cap reached)"` (lines 243-245). `MAX_TURNS = 12` (line 20) is the default; `deps.maxTurns` overrides it (line 142). There is no infinite-loop risk in the loop itself — it is a counted `for`, not a `while` — but there is no per-run wall-clock or cost budget either, and a single iteration can block indefinitely inside `provider.send` or inside a tool.

*Files:* `src/agent/agent.ts`

### `subLoop` is the second, near-duplicate loop body behind respond() and fork()

`respond()` (line 259) and `fork()` (line 268) both delegate to `private async subLoop(prompt, o)` (lines 284-327). It repeats run()'s structure — injectInbox, send, execute tools, push assistant+tool turns — but returns text instead of a `RunOutcome`, never writes `this.lastText`, and deliberately omits everything run() does around the window: no `overContextThreshold` warning, no `compactTurns` call, no `recordRateLimit`, no `quotaWarned`. `respond` runs at `MAX_RESPOND_TURNS = 6` (line 21); `fork` runs at the agent's full `maxTurns`. Errors are swallowed into the return string (`fork failed: …` / `error answering: …`, line 323) so a provider outage inside a fork looks to the parent model like a normal, if unhelpful, finding.

*Files:* `src/agent/agent.ts`

### Tool dispatch: four sources, one funnel, one gate order

`buildTools()` (lines 368-410) concatenates three spec sources — `toolSpecs(allowed)` (sandbox), `this.mcp?.toolSpecs()`, `lspToolSpecs(this.lsp)` — then conditionally appends `spawn_fork` (gated on `ctx.forkDepth < MAX_FORK_DEPTH`), `send_message` and `ask_agent` (gated on `ctx.askDepth < MAX_ASK_DEPTH` and on peers existing). `execTool()` (lines 414-482) dispatches in a fixed order: `spawn_fork` first (line 421, returns before any gate), then `MESSAGING_TOOLS` (line 422), then the gated path — dangerous-shell check (427), pre-read `before` for WRITE_TOOLS (430), diff injection (431-438), `resolvePermission` (440), deny short-circuit (443), approval (448), then execution split three ways: MCP (`this.mcp!.call`), LSP (`runLspTool`), or sandbox (`toSandboxCall` → lock → checkpoint → `runTool`). Every branch is inside one try/catch that converts a throw into the string `error: ${err}` fed back to the model (lines 477-481), so no tool failure can break the loop.

*Files:* `src/agent/agent.ts`

### Argument validation is coercion, not validation

`toSandboxCall` (src/tools/tools.ts:165-189) is the only argument validator on the sandbox path and it never rejects: every field is `String(i.x ?? "")`, `replaceAll` is `i.replaceAll === true`, and args is `Array.isArray(i.args) ? i.args.map(String) : []`. A model that sends `{path: 42}` gets a write to the file named `"42"`; a missing `path` becomes `""`, which `resolve(root, "")` turns into the project root itself — `safePath` then permits it (`abs !== root` is false) and `readFile(root)` fails with EISDIR, surfaced as a tool-result string. Only an unknown tool *name* throws (line 187). MCP arguments are forwarded verbatim (`src/mcp/mcp.ts:75`), LSP arguments are `String(input.path ?? "")` / `Number(input.line ?? 1)` (src/tools/lsp-tools.ts:43,49).

*Files:* `src/tools/tools.ts`, `src/tools/lsp-tools.ts`

### The path jail: one prefix check, applied at execution, not at policy time

`safePath(root, p)` (src/tools/tools.ts:19-25) is the whole sandbox: `resolve(root, p)` then reject unless `abs === root || abs.startsWith(root + sep)`. It is called from `runTool` for read_file/write_file/edit (lines 56, 58, 61), from `runLspTool` (lsp-tools.ts:44), and from `Agent.readForCheckpoint` (agent.ts:489) and the checkpoint write (agent.ts:467). The file carries an explicit `ponytail:` comment (lines 16-18) naming the ceiling: prefix check only, symlinks inside the root pointing out are not caught, real OS sandboxing is the documented v1 gap. `root` is never `realpath`'d, and `shell` is not path-checked at all — only its `cwd` is pinned.

*Files:* `src/tools/tools.ts`

### The permission model: layered, first-match-wins, most-specific-within-layer

`resolve(layers, tool, input)` (src/permissions.ts:71-79) walks layers in order and returns the first layer that has anything to say; unmatched everywhere → `"ask"`. Within a layer, `matchLayer` tries `rules[tool]` then `rules["*"]` (line 68), and `matchRules` picks the longest matching pattern, breaking exact-length ties toward the stricter decision via `STRICTNESS` (lines 54-64). `matches()` (45-50) has two modes: bare `"*"`/`"**"` short-circuit to true, path subjects go through `Bun.Glob`, and shell subjects (`kind === "text"`) are compiled to a regex with only `*`→`.*` and `?`→`.` — because a path glob's `*` refuses to cross `/`, which would break `"rm -rf*"`. `subject()` (34-40) is the command line for shell, `input.path` for everything else. The layer array is assembled in engine.ts:112 (`project`, then `AUTO_RULES` if `--auto`) and prefixed per-agent at agent.ts:440: `[this.config.permissions, ...this.permissionLayers, DEFAULT_RULES]`.

*Files:* `src/permissions.ts`, `src/engine.ts`, `src/agent/agent.ts`

### Approvals: a promise queue with no owner, no timeout and no cancellation

`ApprovalQueue.request()` (src/approval.ts:42-48) returns immediately-true if a standing scope matches and `forceAsk` is false; otherwise it pushes `{agentId, tool, input, resolve, queuedAt}` and returns a promise that only settles when some UI calls `answer()`, `approveAll()`, `denyAll()` or `approveAgent()`. `answer()` (64-75) shifts `pending[0]`, optionally `Object.assign`s an `edited` patch straight into the same input object the agent loop still holds a reference to, and optionally grants a session-lifetime scope (`"agent"` = agentId+tool, `"path"` = additionally `${dir}/**`). Batching is `currentBatch()` (56-59): 3+ pending and `pending[0]` queued within 5s. Engine wires it at engine.ts:118 — `approve` is only supplied when `opts.interactive` is true — and re-publishes the queue to the SSE hub on every change (engine.ts:141). The HTTP surface is a single `POST /approval` (src/server/server.ts:316-323) that answers whatever is at the head of the queue.

*Files:* `src/approval.ts`, `src/engine.ts`, `src/server/server.ts`

### Context management: warn at 85%, summarize at 95%, only in run()

`contextWindow(provider)` (src/providers/catalog.ts:25-27) returns a per-*provider* (not per-model) approximation, defaulting to 128_000. `overContextThreshold` (agent.ts:48-50) returns false when context is 0. run() fires a one-shot `warning` event at `WARN_RATIO = 0.85` (lines 209-213) and calls `compactTurns` past `COMPACT_RATIO = 0.95` (lines 221-227), splicing the result back into the same array so the caller's reference stays valid. `compactTurns` (src/agent/context.ts:15-34) keeps the last `KEEP_RECENT = 4` turns, walks the cut point backwards while `turns[cut].role === "tool"` so a tool-result turn is never orphaned from its assistant turn (lines 23, explicitly tested at context.test.ts:46-66), renders the older half through `describeTurn` (tool outputs truncated to 200 chars) and replaces it with one `[Earlier conversation summary]` user turn produced by the same provider. History is otherwise never truncated — it grows one assistant + one tool turn per iteration, plus a user turn whenever `injectInbox` finds mail.

*Files:* `src/agent/context.ts`, `src/agent/agent.ts`, `src/providers/catalog.ts`

### Error handling when a provider throws mid-loop

Only `provider.send` and `compactTurns` (which itself calls `provider.send`) can throw inside run()'s try; every tool path is already try/caught in `execTool`. The catch (agent.ts:246-251) classifies via `isExhaustion(err)` (lines 56-68 — status 429/529/503, or message containing rate limit / overloaded / unavailable / high demand / context+exceed), stores `summarizeError(err)` into `this.lastError`, sets the session row to that outcome and publishes an `error` event, returning `"exhausted"` or `"failed"`. The scheduler (src/orchestrator/scheduler.ts:210-215) retries `"exhausted"` up to `MAX_ATTEMPTS = 3` with `min(attempts*500, 3000)` backoff and *without* `priorTurns`, so each retry restarts the conversation from the task prompt. Turns already pushed before the throw remain in the store under the failed session. `subLoop`'s catch (line 321-323) instead returns a string, so a fork/ask failure is invisible to the outcome machinery.

*Files:* `src/agent/agent.ts`, `src/orchestrator/scheduler.ts`

### Locking and checkpointing are woven into the sandbox branch of execTool

Only the sandbox branch locks (agent.ts:459-473): `lockPath` is the raw model-supplied path for WRITE_TOOLS, the sentinel `SHELL_LOCK = "*shell*"` for shell, undefined otherwise. `LockRegistry.acquire` (src/orchestrator/locks.ts:23-52) is a 50ms poll loop with lazy stale eviction at `STALE_MS = 60_000` and a one-shot `blocked on …` warning; `release` only deletes when the holder matches. Between acquire and `runTool`, the pre-read `before` is written to the session store as a checkpoint against `safePath(this.root, lockPath)` and `onWrite(lockPath)` tells the file watcher to ignore the echo. `undoLast`/`rewindN` (src/store/session-store.ts:256-296) pop checkpoints LIFO and restore or delete on disk, surfaced as `Engine.undo()`/`Engine.rewind(n)` (engine.ts:241-262).

*Files:* `src/agent/agent.ts`, `src/orchestrator/locks.ts`, `src/store/session-store.ts`

### Engine as the wiring layer: one Bus, one MessageBus, one EventHub, one ApprovalQueue

The `Engine` constructor (engine.ts:70-142) builds a `Messenger` closure over the live agent registry (`peers`, `send`, `ask`, `inbox`), computes the permission layer array, then constructs one `Agent` per config with `systemPrompt: c.systemPrompt + (opts.systemSuffix ?? "") + TOOL_GUIDANCE` (line 115) and seeds `autoApprove` grants (line 132). Everything fans into `this.hub`: agent events (136), messages (137-140, also mirrored to the store), approval changes (141). `runSession` (179-213) is the single mutual-exclusion point — `if (this.busy) throw`, optional worktree creation with `a.setRoot(...)` for every agent, `saveTasks` on success, and a `finally` that resets busy, restores roots, emits usage and publishes the session-ended event. `cancel()` (235-237) only flips a boolean read by the scheduler's `shouldStop`.

*Files:* `src/engine.ts`

### Skills are prompt text, not a tool

`loadSkills(dir = ".amux/skills")` (src/skills/skills.ts:13-30) scans one level of directories for `SKILL.md`, extracts the leading `---` frontmatter with a regex and parses it with `yaml.parse`, falling back to the directory name when `name` is absent and to `""` when `description` is. `skillsPrompt` (32-36) renders one bullet per skill including the file path, and cli.ts:167 concatenates it with `loadInstructions(options.instructions)` into `systemSuffix`. The agent is expected to `read_file` the SKILL.md on demand — which works because `DEFAULT_RULES` (src/permissions.ts:19-25) allows `read_file` for `"*"` unconditionally. There is no skills tool, no lazy-load mechanism, and no cap on how many skills' descriptions land in every system prompt of every agent.

*Files:* `src/skills/skills.ts`, `src/cli.ts`

### LSP tools are a thin, always-safe adapter

`LSP_TOOLS = new Set(["diagnostics", "hover"])` (src/tools/lsp-tools.ts:7); `lspToolSpecs` returns the two specs only when `registry.configured` (line 27), so agents in a project without an `lsp:` block never see them. `runLspTool` (37-54) jails the path through the same `safePath`, resolves a client via `registry.clientFor(abs)`, and converts every failure mode into a readable string — no configured server, or a thrown client error — so an LSP problem can never fail a tool call. `DEFAULT_RULES` pre-allows both (permissions.ts:22-24) so "check your work compiles" doesn't cost a dialog per call.

*Files:* `src/tools/lsp-tools.ts`, `src/permissions.ts`

### Test coverage shape: strong on the happy paths and the documented invariants, blind on the gaps

agent.test.ts (569 lines) covers the loop, streaming, the 85%/95% thresholds with real turn-count assertions (lines 132-134), busy-counter overlap, lock blocking for both write_file and SHELL_LOCK, dangerous-command override of both a standing grant and a blanket allow, store round-tripping, priorTurns, checkpoint+undo, and fork depth/permission inheritance. tools.test.ts asserts traversal rejection for both `../` and absolute paths and that `shell` args are literal. permissions.test.ts covers specificity, layering, tie-breaking and parse validation. What is *not* covered anywhere: a non-normalized path subject (`./x`), an approval that is never answered, a shell command that never exits or produces unbounded output, a run that hits the turn cap, and the `diff` field's effect on the outbound provider payload.

*Files:* `src/agent/agent.test.ts`, `src/tools/tools.test.ts`, `src/permissions.test.ts`, `src/approval.test.ts`

### Observations, edge cases and minor notes (28)

- `src/tools/tools.ts:21` — `safePath` compares `abs !== root && !abs.startsWith(root + sep)`. If a caller ever passes a root with a trailing separator (e.g. `/`), `root + sep` becomes `//` and every path is rejected. `root` is also never `realpath`'d, so on macOS a root of `/tmp/...` (symlink to `/private/tmp/...`) can diverge from a resolved child.
- `src/permissions.ts:60` — `matchRules`'s comment says "most specific pattern wins (longest literal)" but the implementation compares raw `pattern.length` including wildcards — `"**/*.ts"` (7 chars) outranks `"src/**"` (6) despite being broader. Comment and code disagree.
- `src/permissions.ts:72` — `resolve()` hardcodes `kind = tool === "shell" ? "text" : "path"`, and `subject()` returns `""` for any tool whose input has no string `path`. Every MCP tool therefore has an empty subject, so only bare `"*"` patterns can ever match one — a project cannot write a rule against MCP tool arguments.
- `src/agent/agent.ts:44` — `isDangerousShellCall` joins command and args with spaces before regex-testing, so `echo "rm -rf is dangerous"` false-positives into a forced approval prompt. Harmless but noisy under --auto.
- `src/agent/agent.ts:99` — `maxTurns` is plumbed from `loadOptions()` (top-level `maxTurns:` in agents.yaml) into every agent identically — `validate()` in config.ts never reads a per-agent `maxTurns`, despite AgentDeps documenting it as "tool-loop cap for this agent".
- `src/agent/agent.ts:142` — `this.maxTurns = deps.maxTurns && deps.maxTurns > 0 ? deps.maxTurns : MAX_TURNS` silently converts an explicit `maxTurns: 0` into 12 rather than rejecting it.
- `src/agent/agent.ts:330` — `Agent.ask()` and `Engine.debate()` never touch `inFlightCount`, so `agent.busy` is false during the scheduler's integrate pass and for the whole duration of a debate — `switchModel` will happily accept a provider swap at those moments even though the guard exists precisely to prevent that.
- `src/engine.ts:277` — `engine.debate()` runs `rounds * 2` model calls plus a synthesis with no `shouldStop` check, no `busy` guard and no turn cap — `/debate` can be launched while a session is running and cannot be cancelled.
- `src/engine.ts:209` — On worktree runs only `Agent.setRoot` is repointed; the comment at engine.ts:209 acknowledges "LSP/watcher never left the real root". So `diagnostics` during a worktree run type-checks the real root while the agent is editing the worktree copy — the tool answers about files the agent did not change.
- `src/agent/agent.ts:235` — Tool calls in a single reply execute strictly sequentially (`for (const call of reply.toolCalls) results.push({... await this.execTool(call) })`). A model that emits five parallel `read_file` calls pays five serial round trips; same in `subLoop` at line 314.
- `src/agent/agent.ts:461` — The lock key is the raw model-supplied `sandboxCall.path`, not the resolved one, so `a.txt` and `./a.txt` acquire two different locks on the same file — two agents can write it concurrently.
- `src/orchestrator/locks.ts:31` — `LockRegistry.acquire` polls every 50ms with no timeout and no fairness queue; waiters wake in arbitrary order, and a lock is force-reclaimed at 60s (STALE_MS) even if the holder is legitimately still writing.
- `src/tools/tools.ts:40` — `shell()` returns `code ?? -1`, conflating "killed by signal" with "spawn failed" — both surface to the model as `exit -1`. The result string also concatenates stdout and stderr with no separator or labelling (`exit ${code}\n${stdout}${stderr}`).
- `src/tools/tools.ts:58` — `write_file` does no `mkdir -p`: writing `src/new/dir/file.ts` fails with ENOENT and the model must discover it needs a separate `shell mkdir` call first.
- `src/tools/tools.ts:94` — `editDiff`/`writeFileDiff` emit a fake unified-diff header `@@ line N @@` with no line counts. Anything that tries to parse it as a real hunk header (or `git apply` it) will fail; only +/- colorizing works.
- `src/approval.ts:58` — `ApprovalQueue.currentBatch()` only checks `pending[0].queuedAt`, so a batch of five that formed six seconds ago silently degrades back to one-at-a-time prompting even though all five are still queued.
- `src/approval.ts:65` — `answer(ok, scope, edited)` always resolves `pending[0]` — the caller cannot name which request it is answering. A UI that renders `currentBatch()` and lets the user answer the third item resolves the first one instead.
- `src/approval.ts:29` — Granted scopes only ever accumulate (`this.scopes.push`); there is no revoke, no expiry and no listing, so an accidental "always allow shell" persists for the whole session with no way back short of a restart.
- `src/tools/lsp-tools.ts:49` — `runLspTool` passes `Number(input.line ?? 1)` straight through — a model sending `line: "top"` produces NaN and it reaches the language server unvalidated.
- `src/tools/tools.ts:157` — TOOL_GUIDANCE tells every agent "If 'diagnostics' is available, run it on files you edited", but `lspToolSpecs` returns [] whenever no `lsp:` block is configured — the guidance is unconditional while the tool is not, so agents in most projects are advised to use a tool they were never offered.
- `src/skills/skills.ts:13` — `loadSkills` defaults to the cwd-relative `".amux/skills"` rather than the engine root, so skills silently vanish when the process is started from a subdirectory — unlike everything else in the loop, which is rooted at `Engine.root`.
- `src/agent/context.ts:27` — `compactTurns` sends the entire `old` transcript as one user message to the same provider that is already at 95% of its window. That summarization call can itself exceed the window and throw — and it throws inside run()'s try, taking the whole task down as `exhausted`.
- `src/agent/context.ts:10` — `describeTurn` truncates each tool output to 200 chars for the summarization transcript, so compaction of a tool-heavy run summarizes mostly truncated fragments.
- `src/engine.ts:61` — `engine.lastGoal` is documented as not persisted ("a restart loses it"), yet /export's report header depends on it — an exported report after a resume is headed "(resumed session)".
- `src/store/session-store.ts:247` — Checkpoints store full prior file contents in SQLite and are never pruned — the file's own `ponytail:` comment names this. A long session that rewrites a large file repeatedly grows `.amux/amux.db` by the total bytes written.
- `src/engine.ts:132` — `autoApprove:` in agents.yaml becomes an unqualified `(agentId, tool)` grant with no path pattern (engine.ts:132 → approval.ts:29), so `autoApprove: [shell]` is functionally --auto for that agent, with only DANGEROUS_PATTERNS still prompting.
- `src/orchestrator/runner.ts:29` — `runner.ts`'s flat `worker()` loop is dead in the primary path — line 128 says it is "exposed for testing" and runProject only uses the DAG scheduler. It still carries its own `MAX_ATTEMPTS = 3` constant, duplicating scheduler.ts:31.
- `src/orchestrator/scheduler.ts:157` — `runReviewGate` ends with `return undefined; // unreachable — every loop path above returns`, which is dead code kept for the type checker.


---

## 3. Orchestration — DAG scheduler, planner, review gate, locks, worktrees

### Two orchestration engines exist; only one is reachable in production

There are two independent execution models in src/orchestrator/. (1) The DAG path: `runProject` (runner.ts:60) → `makePlan` (planner.ts:153) → `schedule` (scheduler.ts:163). This is what Engine.submit() drives via Engine.runSession (engine.ts:164). (2) The legacy flat queue: `Orchestrator` (orchestrator.ts) + `worker` (runner.ts:29), exported only as `runWorker` at runner.ts:129. `grep -rn runWorker src tui` returns exactly three hits: the export itself, failover.test.ts:35, and orchestrator.test.ts:44. Nothing in the shipped runtime calls it. The `Orchestrator` class is still used, but only as a task *container* — `orch.load()`, `orch.all`, `orch.clear()` — never for `claimTask`/`requeue`/`complete`/`hasUnfinished`, which are the only methods that implement failover.

*Files:* `src/orchestrator/runner.ts`, `src/orchestrator/orchestrator.ts`, `src/orchestrator/scheduler.ts`

### The scheduler's ready-queue loop and its concurrency model

`schedule` (scheduler.ts:163-307) runs a `for(;;)` loop with three phases per iteration: (a) fail any pending task whose dependency failed (`depFailed`, line 254); (b) if not cancelled, launch every pending task whose deps are done onto an idle agent (line 263-272); (c) if `running.size === 0`, mark all remaining pending tasks failed and break (line 274-282), else `await Promise.race(running.values())` (line 283). Concurrency is bounded solely by `running: Map<string, Promise<void>>` keyed on `t.role` (line 248) — one in-flight task per agent id, no global cap. With N agents in agents.yaml, N concurrent model calls are possible. The `startRole` capture at line 269 is a deliberate fix for redirect-replans mutating `t.role` mid-flight (regression-tested at scheduler.test.ts:184).

*Files:* `src/orchestrator/scheduler.ts`

### Cycle detection and the treatment of unknown dependency ids

`detectCycle` (scheduler.ts:38-64) is an iterative-stack DFS with a 0/1/2 colour map that returns the offending path as `string[]`. Critically, line 45 returns `undefined` for an id not present in `byId` — an unknown dep is 'not a cycle'. That is consistent with the runtime, where `depsDone` (line 181) uses `(byId.get(d)?.status ?? "done") === "done"` — a missing dependency is treated as *satisfied*. So an unresolvable dep never deadlocks the scheduler; it silently vanishes. `normalizePlan` (planner.ts:99-103) already drops unknown/self/ambiguous deps before they reach the scheduler, so in the makePlan path this is belt-and-braces; it matters on the resume path where the DAG is reconstructed from a subset.

*Files:* `src/orchestrator/scheduler.ts`, `src/orchestrator/planner.ts`

### Planner: JSON extraction, id namespacing, and the never-crash fallback

`extractJson` (planner.ts:41-73) walks the string looking for `[`/`{`, counts depth while skipping string literals and escapes, and advances to the next bracket on a JSON.parse failure. `normalizePlan` (planner.ts:77-131) enforces two separate id namespaces: model-supplied ids map to positional `t1..tn` via `originalToNew`, while `generatedIds` holds the positional ids themselves, so a model that labels its first task 't2' doesn't clobber the positional t2 (tested at planner.test.ts:45). Duplicate model ids go into `ambiguousIds` and any reference to them is dropped rather than mis-bound (planner.test.ts:56). `resolveRole` falls back to `roles[0].id` for an unknown assignee (a task must run somewhere), while `resolveKnownRole` *drops* unknown handoffTo targets. `makePlan` retries MAX_PLAN_ATTEMPTS=3 with a correction string appended to the prompt, then degrades to a single whole-goal task on the lead (planner.ts:176-182).

*Files:* `src/orchestrator/planner.ts`

### Dynamic re-planning: what each remediation action actually does

`attemptReplan` (scheduler.ts:70-123) is invoked once per task (MAX_REPLAN_ATTEMPTS=1, guarded at line 232) after a run failure OR a review rejection. It calls `replan` (planner.ts:217), which never throws — a bad model reply degrades to `{action:"accept"}`. `retry` and `redirect` reset `t.attempts = 0`, `t.status = "pending"`, `t.assignedTo = undefined` and return true, so the ready-queue picks the task back up and its dependents are rescued. `redirect` declines if `plan.role` isn't a known agent id (line 95). `inject` runs the remediation batch through `normalizePlan` to get a self-consistent sub-plan, then remaps ids to `${t.id}-r${t.replans}-${i+1}` so they can't collide, runs `detectCycle` over the combined DAG and discards the whole batch if it would introduce a cycle (line 113-116, tested at scheduler.test.ts:227). Injected tasks only depend on each other — the idMap has no entries for pre-existing ids, so cross-links are filtered out at line 111.

*Files:* `src/orchestrator/scheduler.ts`, `src/orchestrator/planner.ts`

### The peer-review gate

`runReviewGate` (scheduler.ts:132-158) fires only when the running agent's config has `reviewer:` set (AgentConfig.reviewer, agent.ts:82; parsed at config.ts:166) and the reviewer is not the assignee itself. It loops up to MAX_REVIEW_ROUNDS=2: emit `review/requested`, call `reviewer.run(...)` with the full agentic loop (so the reviewer can shell `git diff`, read files, call LSP diagnostics), read `reviewer.output`, and decide via `outcome === "done" && !/VERDICT:\s*changes_requested/i.test(feedback)`. Feedback is posted over the MessageBus as kind `review`. On rejection in round 1 it calls `runner.run(prompt + feedback)` to revise and updates `t.output`. Returning a non-undefined string means 'still rejected' and the caller flips the task to failed (scheduler.ts:222-226).

*Files:* `src/orchestrator/scheduler.ts`, `src/agent/agent.ts`

### File locking is in-process, advisory, and single-lock-at-a-time (hence deadlock-free)

`LockRegistry` (locks.ts) is a `Map<string, {holder, acquiredAt}>` in one Bun process, explicitly marked `ponytail: in-memory, single process`. `acquire` polls every POLL_MS=50 until free, is re-entrant for the same holder, and reclaims any entry older than STALE_MS=60_000. The single call site is agent.ts:460-473: `lockPath` is the raw tool path for write_file/edit, or the sentinel `SHELL_LOCK = "*shell*"` for shell, and it is released in a `finally`. Because exactly one lock is held per tool call and no acquire happens while another is held, AB-BA deadlock between agents is structurally impossible. Waiting is also bounded — worst case ~60s until the stale reclaim fires. `byHolder()` (locks.ts:59) filters out stale entries for the TUI lock strip, surfaced via Engine.emitLocks (engine.ts:374).

*Files:* `src/orchestrator/locks.ts`, `src/agent/agent.ts`, `src/engine.ts`

### Git worktree isolation: lifecycle and the deliberate manual-merge policy

Enabled by `--worktree` (cli.ts:186). `Engine.runSession` (engine.ts:181-191) refuses to start if a previous `worktreeHandle` is unmerged, hard-fails if `isGitRepo(root)` is false rather than silently running unisolated, creates `.amux/worktrees/<uuid8>` on branch `amux/<uuid8>` off current HEAD, and repoints every agent's sandbox root with `a.setRoot(...)`. The `finally` (engine.ts:209) always restores the real root. `createWorktree` (worktree.ts:37) captures `baseSha` from `git rev-parse HEAD` — it throws cleanly on a repo with no commits. `diffStat`/`diffPatch` both run `git add -A` first because agents write via write_file/edit and never commit as they go, so a plain diff-against-commit would hide every new file. `mergeBack` is `git merge --no-ff <branch>` and is only reached from POST /worktree/merge (server.ts:304) — never automatic. `removeWorktree` uses `--force` and only runs on a successful merge.

*Files:* `src/orchestrator/worktree.ts`, `src/engine.ts`, `src/server/server.ts`

### Agent-to-agent messaging: two delivery modes, one authorization/rate path

MessageBus (message-bus.ts) keeps `inboxes: Map<agentId, AgentMessage[]>`, a `roster` Set seeded with ORCHESTRATOR, an optional directed-edge allowlist, and a `counts` map for the MAX_PER_PAIR=10 loop guard. `post()` enqueues (async, drained into the recipient's next turn by Agent.injectInbox at agent.ts:357); `announce()` only notifies subscribers, used for the synchronous `ask_agent` path so question and answer aren't double-delivered. Both `post()` and `authorize()` funnel through the private `reserve()` (line 73) so roster/edge/rate checks are identical. `schedule` calls `resetCaps()` then `allowAll()` at startup (scheduler.ts:175-179) — the plan's dependsOn/handoffTo edges deliberately do NOT constrain messaging, which scheduler.test.ts:103 pins as intentional. Depth of synchronous A→B→A chains is capped by MAX_ASK_DEPTH=3 (message-bus.ts:149, enforced at agent.ts:503).

*Files:* `src/messaging/message-bus.ts`, `src/agent/agent.ts`, `src/orchestrator/scheduler.ts`

### An agent crash never aborts the run — every failure is caught inside Agent

`Agent.run` (agent.ts:174-255) wraps the entire tool loop in try/catch and returns `"exhausted"` or `"failed"` (line 247) — it never rejects. `execTool` catches per-tool errors and returns them as a string to the model (agent.ts:477-481). `subLoop` (respond/fork) catches and returns an error *string* (line 321-323). `replan` and `makePlan` swallow provider errors. The integrate pass is individually try/caught (scheduler.ts:289-303). Consequently a crashed/failing agent degrades to a failed task, the failure cascades to dependents via `depFailed`, and the run completes. The only remaining reject paths into `Promise.race` are the `emit?.()` / `bus.publish` / `messageBus.post` callbacks, which are not defensively wrapped (see findings).

*Files:* `src/agent/agent.ts`, `src/orchestrator/scheduler.ts`

### Retry semantics: only 'exhausted' is retried, and only on the same agent

scheduler.ts:210-215 retries the task while `outcome === "exhausted" && attempts < MAX_ATTEMPTS(3) && !shouldStop()`, sleeping `min(attempts*500, 3000)` between attempts, and always calling the *same* `runner`. `isExhaustion` (agent.ts:56-69) classifies HTTP 429/529/503 plus message matches on 'rate limit', 'overloaded', 'unavailable', 'high demand', and 'context'+'exceed'. A `"failed"` outcome is never retried — it goes straight to the replan gate. The retry emits a bus event of type `"failover"` (scheduler.ts:212) even though nothing is failed *over*.

*Files:* `src/orchestrator/scheduler.ts`, `src/agent/agent.ts`

### Resume path reconstructs a partial DAG rather than reloading the whole one

`resumeProject` (runner.ts:103-126) takes `orch.all.filter(t => t.status !== "done")`, resets each to `"pending"`, backfills `role` from `assignedTo` and `dependsOn` to `[]` if absent, and calls `schedule` with `goal: "(resumed session)"` and no planning pass. Per-task conversation is re-seeded via `deps.priorTurns` → `resumeConversation(store, taskId)` (session.ts:24), which flattens every stored session row carrying that taskId. The seed is applied only to the *first* attempt (scheduler.ts:207) — retries deliberately start clean so a failed attempt isn't replayed into the window.

*Files:* `src/orchestrator/runner.ts`, `src/session.ts`, `src/orchestrator/scheduler.ts`

### OrchestrationEvent is the DAG's only external contract

The nine-variant union at scheduler.ts:10-19 (plan, task_ready, task_started, task_done, handoff, replan, review, integrate, complete) is forwarded by Engine.runSession's `onOrchestration` into EventHub as `{kind:"orchestration"}` (engine.ts:200), typed identically in src/server/events.ts, and consumed by tui/internal/session/session.go:628 `applyOrch` and web/app.js:118. The Go TUI handles plan/task_started/task_done/handoff/integrate/complete; `task_ready`, `replan` and `review` have no case arm in either client.

*Files:* `src/orchestrator/scheduler.ts`, `src/server/events.ts`, `tui/internal/session/session.go`, `web/app.js`

### Test coverage of this subsystem

`bun test src/orchestrator src/messaging` → 54 pass / 0 fail across 7 files (verified). scheduler.test.ts covers cycle rejection, dependency ordering, real concurrency (`active.max === 2`), handoff messages, prerequisite-failure skipping, allowAll, cancellation of the retry loop, integrate+complete, retry/redirect/cyclic-inject replans, the review gate's approve / one-revision / round-cap / self-review-skip cases, and cancel-skips-integrate. worktree.test.ts spins up a real temp git repo via execFileSync and round-trips an *uncommitted* write through diffStat → commitPending → mergeBack → removeWorktree. locks.test.ts covers grant, block, stale reclaim with a 20ms threshold, and non-owner release. failover.test.ts covers only the dead flat path.

*Files:* `src/orchestrator/scheduler.test.ts`, `src/orchestrator/worktree.test.ts`, `src/orchestrator/locks.test.ts`, `src/orchestrator/failover.test.ts`

### Observations, edge cases and minor notes (22)

- `src/orchestrator/scheduler.ts:31` — MAX_ATTEMPTS = 3 is declared twice with the same meaning and no shared source: scheduler.ts:31 and runner.ts:24. Changing one silently diverges from the other.
- `src/orchestrator/scheduler.ts:157` — scheduler.ts:157 `return undefined; // unreachable — every loop path above returns` is genuinely dead: MAX_REVIEW_ROUNDS >= 1 guarantees the `round === MAX_REVIEW_ROUNDS` branch fires. It only exists to satisfy the return type.
- `src/orchestrator/scheduler.ts:147` — The review gate delivers reviewer feedback twice: once inline in the revision prompt (scheduler.ts:153 `${prompt}\n\nA reviewer requested changes:\n${feedback}`) and once via messageBus.post at line 147, which Agent.injectInbox will splice into the same run's next turn as a 'Messages from teammates' block.
- `src/config/config.ts:166` — `config.ts:166` accepts `reviewer` as any string with no check that it names a real agent id. A typo makes `agentsById.get(runner.config.reviewer)` return undefined and runReviewGate silently no-ops — the user believes review is on and it never runs. No warning is emitted.
- `src/orchestrator/scheduler.ts:277` — The unreachable-task sweep (scheduler.ts:276-280) emits `task_done ok:false` but publishes no bus error, unlike the prerequisite-failed branch at line 256 which does. Unreachable tasks fail silently in the log.
- `src/orchestrator/orchestrator.ts:18` — `Orchestrator.load` derives nextId with `Number(t.id.replace(/\D/g, ""))`. A replan-injected id like `t1-r1-2` collapses to 112, so resuming after an inject jumps the counter to 113.
- `src/agent/agent.ts:330` — `Agent.ask()` (agent.ts:330) does not increment `inFlightCount`, so `Agent.busy` reads false during the planning and integrate calls. `reconfigure()` guards on `busy` — a model swap during a plan/integrate call is therefore not blocked.
- `src/orchestrator/locks.ts:27` — LockRegistry.acquire is re-entrant but unbalanced: two acquires by the same holder followed by one release fully frees the lock. Not currently reachable (execTool acquires exactly once per call) but it is a latent footgun for any future caller.
- `src/orchestrator/locks.ts:62` — `byHolder()` skips stale entries but never deletes them (locks.ts:62). An entry for a path never re-acquired stays in the Map for the process lifetime — an unbounded, if tiny, leak.
- `src/orchestrator/locks.ts:29` — `re-acquiring` a lock you already hold resets `acquiredAt` (locks.ts:29), so a holder that keeps re-acquiring can hold indefinitely past staleMs. Harmless today, relevant if the lock is ever taken across a loop.
- `.gitignore:1` — `.amux/worktrees/` is not in .gitignore (which lists .amux/session.json, .amux/amux.db*, .amux/reports/). Verified empirically: `git add -A` in the root stages `.amux/worktrees/x` as an embedded-repo gitlink with git's 'adding embedded git repository' warning.
- `src/orchestrator/worktree.ts:52` — `diffStat` and `diffPatch` both mutate the worktree index with `git add -A` (worktree.ts:52, 60) even though they are read-only status/report calls. GET /worktree therefore has a side effect, and it clobbers any index state the user staged by hand in that worktree.
- `src/orchestrator/worktree.ts:79` — `snapshotBranch` (/branch) does `git checkout -b` + `git add -A` + commit in the real root with no check for an active worktree. Combined with the missing .gitignore entry, a /branch taken during a worktree run commits a gitlink to `.amux/worktrees/<id>` onto the snapshot branch.
- `src/orchestrator/worktree.ts:102` — `mergeBack` merges into 'whatever is currently checked out in root' with no verification that root is still on the branch/commit that `handle.baseSha` was taken from. A user who checks out another branch mid-run gets the merge landed somewhere unintended.
- `src/orchestrator/worktree.ts:16` — `git()` in worktree.ts accumulates stdout/stderr into unbounded strings. `diffPatch` on a large run returns the entire patch into memory and then into the /export markdown.
- `src/orchestrator/scheduler.ts:242` — `schedule` ignores every `PostResult`. Both the handoff post (scheduler.ts:242) and the review-feedback post (line 147) discard `{ok, reason}`, so a rate-capped or unknown-recipient message is dropped with no log line and no event.
- `src/messaging/message-bus.ts:128` — Messages left in an inbox at the end of a run are never surfaced. `MessageBus.pending()` exists but nothing calls it at run completion — a handoff to an agent with no remaining tasks is silently discarded when the process exits.
- `src/messaging/message-bus.ts:50` — `MessageBus.restrict()` has zero non-test callers (`grep -rn 'restrict(' src` hits only message-bus.ts:50 and message-bus.test.ts). It is speculative API kept alive by its own tests.
- `src/orchestrator/runner.ts:13` — `parseTaskList` (runner.ts:13) is explicitly labelled 'Kept for the legacy flat path / tests' and is referenced only by orchestrator.test.ts:21. Dead production code.
- `src/events/bus.ts:31` — `Bus.publish` (events/bus.ts:31) uses EventEmitter.emit, which invokes listeners synchronously and propagates a throwing listener back to the publisher. `MessageBus.post` line 102 does the same with a bare `for (const fn of this.subs) fn(msg)`. Neither wraps subscribers.
- `src/engine.ts:206` — `saveTasks(this.orch.all)` sits inside the try (engine.ts:206), not the finally. Any throw out of `run()` skips persistence entirely, so an aborted run leaves the previous session.json in place.
- `src/orchestrator/planner.ts:193` — MAX_PLAN_ATTEMPTS=3 vs MAX_REPLAN_PLANNER_ATTEMPTS=2 vs MAX_ATTEMPTS=3 vs MAX_REPLAN_ATTEMPTS=1 vs MAX_REVIEW_ROUNDS=2 — five independent retry budgets across two files, none configurable from agents.yaml.


---

## 4. Providers — abstraction, catalog, pricing, auth, secrets

### The Provider seam is one method wide, and that is genuinely the whole contract

`src/providers/provider.ts:85-88` declares `interface Provider { send(sysPrompt, turns, tools, onDelta?): Promise<ProviderReply> }`. There is no `close()`, no `models()`, no `countTokens()`, no health check. Streaming is not a separate method — passing `onDelta` switches the implementation into streaming mode and the full reply is still returned, so every call site can ignore streaming without branching (`src/agent/context.ts:27` calls `send` with three args for compaction; `src/agent/agent.ts:200` passes four). `ProviderReply` (`provider.ts:75-81`) carries `text`, `toolCalls`, an opaque `raw`, optional `usage` and optional `rateLimit`. Everything downstream — the agent loop, the cost meter, the context-depth warning, the quota warning — is driven off those five fields. It is a well-chosen seam; the divergence problems below are all about what individual implementations decline to populate.

*Files:* `src/providers/provider.ts`, `src/agent/agent.ts`, `src/agent/context.ts`

### `Turn.raw` is the mechanism that makes multi-turn tool use survive on reasoning models

`provider.ts:39-44` defines the assistant turn as `{ role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown }` where `raw` is provider-native content replayed verbatim. Two providers depend on it for correctness, for different reasons: `anthropic.ts:44` replays `t.raw as Anthropic.ContentBlockParam[]` so `thinking` blocks round-trip (required once `thinking: { type: "adaptive" }` is set at `anthropic.ts:65`), and `gemini.ts:24` replays raw parts so each `functionCall` keeps its `thoughtSignature` (the comment at `gemini.ts:19-23` states newer Gemini models 400 INVALID_ARGUMENT without it). `openai.ts` never sets `raw` and never reads it — it rebuilds `tool_calls` from `ToolCall[]` every turn (`openai.ts:50-55`). Because `raw` is opaque, `engine.switchModel` (`src/engine.ts:325-338`) has to refuse a mid-task provider swap: "Swapping providers mid-loop would send a turn history built for one provider … to a different provider's send()". That refusal is the direct consequence of this design and is correctly implemented (`engine.ts:332` checks `agent.busy`).

*Files:* `src/providers/provider.ts`, `src/providers/anthropic.ts`, `src/providers/gemini.ts`, `src/engine.ts`

### Tool-call translation is three genuinely different shapes, normalised to one

Anthropic: tools become `{name, description, input_schema}` (`anthropic.ts:70-74`); calls come back as `tool_use` blocks with a server-issued `id` (`anthropic.ts:10-12`); results go back as a *user* turn of `tool_result` blocks keyed by `tool_use_id` (`anthropic.ts:52-59`). OpenAI: tools become `{type:"function", function:{name,description,parameters}}` (`openai.ts:69-74`); arguments arrive as a JSON *string* and are parsed defensively by `parseArgs` (`openai.ts:5-12`, returns `{}` on malformed JSON rather than throwing); results go back as one `{role:"tool", tool_call_id, content}` message per result (`openai.ts:59-61`). Gemini: tools become `functionDeclarations` inside a single tools entry (`gemini.ts:46-55`); calls arrive as `functionCall` parts with **no id at all**, so ids are synthesised as `` `${fc.name}-${n++}` `` (`gemini.ts:80-84`); results go back as a *user* turn of `functionResponse` parts paired by **name**, not id (`gemini.ts:30-35`), which is why `ToolResult` carries a redundant-looking `name` field (`provider.ts:35`). The `ponytail:` comment at `gemini.ts:69-70` names the known ceiling: parallel calls to the same tool in one turn cannot be disambiguated on the Gemini response side.

*Files:* `src/providers/anthropic.ts`, `src/providers/openai.ts`, `src/providers/gemini.ts`, `src/providers/provider.ts`

### Rate-limit headers are captured by wrapping `fetch`, which is why they survive streaming

Both `anthropic.ts:26-30` and `openai.ts:24-28` install a `trackedFetch` into the SDK constructor that stores `parseRateLimit(res.headers, kind)` into instance field `lastRateLimit` before returning the response. This is deliberate and correct: with SSE streaming the SDK surfaces no response object to the caller, so header parsing has to happen at the transport layer. `parseRateLimit` (`provider.ts:59-73`) is kept pure and reads `anthropic-ratelimit-tokens-remaining` / `-requests-remaining` / `-tokens-reset` for Anthropic and `x-ratelimit-remaining-tokens` / `-requests` / `x-ratelimit-reset-tokens` for OpenAI. `agent.ts:207` forwards it to `usageTracker.recordRateLimit(provider, rateLimit)` and `agent.ts:214-218` fires a one-shot `warning` event when `remainingRequests <= 1`. GeminiProvider installs no such hook and never returns `rateLimit`, so this whole warning path is dead for Google.

*Files:* `src/providers/anthropic.ts`, `src/providers/openai.ts`, `src/providers/provider.ts`, `src/agent/agent.ts`

### Errors are classified twice: once for readability, once for retry policy

`summarizeError` (`provider.ts:8-19`) exists solely to unwrap `@google/genai`'s `ApiError`, whose `.message` is itself a JSON string containing another `{error:{message}}` body; it does one `JSON.parse`, reaches for `parsed.error ?? parsed`, and prefixes `status` when present. `provider.test.ts` covers the nested case, the plain-message case and the non-Error-thrown case. Separately, `isExhaustion` (`src/agent/agent.ts:56-68`) decides retry policy by checking `status === 429 || 529 || 503` and then substring-matching the lowercased message for `rate limit`, `rate_limit`, `overloaded`, `unavailable`, `high demand`, and `context`+`exceed`. `agent.ts:247` turns that into `RunOutcome` `"exhausted"` vs `"failed"`, and `src/orchestrator/scheduler.ts:210-215` retries only `"exhausted"` outcomes, up to `MAX_ATTEMPTS = 3`, with `await sleep(Math.min(t.attempts * 500, 3000))`. Note this is a *whole-task* retry — the entire agentic loop re-runs and re-bills — not an HTTP-level retry.

*Files:* `src/providers/provider.ts`, `src/agent/agent.ts`, `src/orchestrator/scheduler.ts`

### The catalog is a two-layer merge: generated first, hand-maintained last

`catalog.ts:154` is the whole mechanism — `export const CATALOG = { ...GENERATED_CATALOG, ...MANUAL_CATALOG }`. Object-spread ordering means a hand-written entry wins on id collision, which is what lets `anthropic` and `google` keep their native `client` kinds and 1M-token `context` values that the generator cannot infer (`catalog.test.ts:48-52` asserts exactly this). `CatalogEntry` (`catalog.ts:10-19`) carries `label`, `client` (one of `anthropic|gemini|openai|copilot`), optional `baseURL`, `envVar`, optional `keyOptional`, optional `category` (`byok|local|login`, defaulting to byok at `catalog.ts:161`), optional `context`, and `models[]`. `contextWindow` (`catalog.ts:25-27`) is per-*provider* not per-model with `DEFAULT_CONTEXT = 128_000`, an explicitly-flagged simplification. Live count with the uncommitted change: 34 providers (31 byok / 2 local / 1 login), down from ~163.

*Files:* `src/providers/catalog.ts`, `src/providers/catalog.generated.ts`, `src/providers/catalog.test.ts`

### `makeProvider` is the single place credentials meet transport, and it is only 22 lines

`factory.ts:10-32`: look up `CATALOG[cfg.provider]` (throw with the full known-provider list if absent), `resolveApiKey(cfg.provider)`, substitute the literal string `"local"` when the key is missing and `entry.keyOptional` is set (`factory.ts:16`), otherwise throw a provider-appropriate instruction (`amux login copilot` for the copilot client, `amux auth login (or export ${entry.envVar})` otherwise). Base URL precedence is `cfg.baseURL ?? resolveBaseURL(provider) ?? entry.baseURL` (`factory.ts:21`) — agent config beats stored credential beats catalog default. Then a four-arm switch on `entry.client`. Note the Gemini arm at `factory.ts:26` passes only `(model, apiKey)` — `baseURL` is computed and then silently dropped for that one client.

*Files:* `src/providers/factory.ts`

### Credential resolution is a three-tier fallback with a deliberate test escape hatch

`resolveApiKey` (`auth-store.ts:86-98`) reads the typed store first; an `api` credential yields `.key`, an `oauth` credential yields `.access`, and a `local` credential yields `undefined` on purpose (the factory's `"local"` sentinel covers it). Only when *no* credential exists does it fall through to `keychainKey(provider)`, and `keystore.getKey` (`keystore.ts:17-25`) itself is a two-tier fallback: OS keychain via `new Entry("amux", provider).getPassword()` wrapped in try/catch, then `envKey(provider)` which does `process.env[CATALOG[provider].envVar]`. Crucially `auth-store.ts:96` short-circuits the entire fallback when `AMUX_AUTH_FILE` is set, with the reasoning spelled out in the comment: a test store must be hermetic or a provider absent from the temp store would resolve a real key and make billed calls. `auth-store.test.ts:72-79` asserts this. `setCredential` mirrors api keys into the keychain best-effort (`auth-store.ts:62-68`) and `removeCredential` clears the mirror (`auth-store.ts:81`) so a logout is not undone by the fallback.

*Files:* `src/auth/auth-store.ts`, `src/keystore/keystore.ts`, `src/auth/auth-store.test.ts`

### On-disk credential storage: single global JSON file, 0600 in a 0700 dir

`authFile()` (`auth-store.ts:15-17`) resolves `$AMUX_AUTH_FILE || ~/.config/amux/auth.json` — global, not per-project, matching opencode. `write` (`auth-store.ts:36-45`) does `mkdirSync(dirname, {recursive:true, mode:0o700})` then `writeFileSync(..., {mode:0o600})` then a belt-and-braces `chmodSync(path, 0o600)` in a try/catch for pre-existing files, with the catch commented as a Windows concession. `read` (`auth-store.ts:23-33`) treats a corrupt file as empty rather than fatal and filters entries lacking a string `provider`. `removeCredential` deletes the file entirely when the last credential goes (`auth-store.ts:74-78`). This *is* a plaintext credential fallback — by design and clearly labelled — and the keychain is a mirror on top of it, not the other way round.

*Files:* `src/auth/auth-store.ts`

### Copilot is an adapter over OpenAIProvider with a lazily-refreshed short-lived token

`copilot.ts:81-101`. `CopilotProvider` holds the long-lived GitHub OAuth token and constructs a fresh `OpenAIProvider` whenever the cached Copilot API token is inside 60s of expiry (`copilot.ts:91`). `fetchCopilotToken` (`copilot.ts:71-78`) hits `https://api.github.com/copilot_internal/v2/token` with `Authorization: token <gho>` and converts `expires_at` seconds to ms, falling back to a 25-minute window when absent (`copilot.ts:93`). The inner provider is pinned to `https://api.githubcopilot.com` with four editor-spoofing headers (`copilot.ts:11-16`: `Editor-Version: vscode/1.99.0`, `Editor-Plugin-Version`, `Copilot-Integration-Id: vscode-chat`, `User-Agent: GitHubCopilotChat/0.26.0`) which the comment says are required or the endpoint 400s. The device flow uses the public copilot.vim client id `Iv1.b507a08c87ecfe98` (`copilot.ts:5`) with scope `read:user`, and the poll-response state machine is factored out as pure `interpretPollResponse` (`copilot.ts:40-45`) precisely so it can be unit-tested — `copilot.test.ts` covers all five outcomes.

*Files:* `src/providers/copilot.ts`, `src/providers/copilot.test.ts`

### Pricing is a prefix table, deliberately incomplete, with `priced` as the honesty flag

`pricing.ts:14-44` is a 29-entry `Record<string, Price>` keyed by model-name prefix; `priceFor` (`pricing.ts:50-63`) lowercases, strips any `provider/` prefix by `lastIndexOf("/")` so OpenRouter-style ids price on the model half, then does a longest-prefix-wins linear scan. `FREE_PROVIDERS = new Set(["ollama","lmstudio"])` short-circuits to zero (`pricing.ts:48,51`) with the reasoning that a locally-hosted llama billed at $0.59/Mtok would be actively wrong. `costOf` (`pricing.ts:67-71`) returns `{usd, priced}` and yields `{usd:0, priced:false}` for an unknown model so a mixed team still reports what it knows. Three call sites consume `priced`: `engine.ts:363-372` aggregates it into `costKnown` (comment: so the UI shows "$0.42+"), `src/server/server.ts:223`, and `src/commands/export.ts:65`. The header comment at `pricing.ts:4-7` already names the upgrade path — models.dev ships a per-model `cost` block.

*Files:* `src/providers/pricing.ts`, `src/engine.ts`, `src/server/server.ts`

### The generator is a 130-line fetch-filter-emit script with no schema validation

`scripts/gen-catalog.ts` fetches `https://models.dev/api.json`, iterates `Object.values(data)`, and applies four sequential filters: id allowlist/skiplist (`:83`), `clientFor(p.npm)` which maps `@ai-sdk/anthropic`→anthropic, `@ai-sdk/google`→skip (needs the native SDK, not a baseURL), everything else→openai (`:66-71`), presence of `p.api` (`:95`, with a good comment about not silently routing another provider's key to api.openai.com), and presence of `p.env?.[0]` (`:99-103`). Models are `Object.keys(p.models ?? {}).slice(0, 8)` (`:104`). Output is built by string concatenation into a template literal and written with `Bun.write("src/providers/catalog.generated.ts", out)` (`:126`) — a cwd-relative path. `main()` is invoked bare at `:130` with no `.catch`.

*Files:* `scripts/gen-catalog.ts`

### Secrets never reach the web dashboard, and the HTTP surface is tightly scoped

Verified end to end. `src/server/server.ts:408-410` defines `redact(c) => ({provider: c.provider, type: c.type})` and `GET /auth` maps every credential through it (`:282`), so no key, access token or baseURL leaves the process on that route. `web/app.js` has no auth/key UI at all — grepping for `auth|key|credential` in it returns only `authedFetch`, `/model` and keyboard handlers. The server binds `hostname: "127.0.0.1"` (`server.ts:129`) with a `crypto.randomUUID()` bearer token (`:52`) compared via `timingSafeEqual` in `tokensMatch` (`:416-421`). I also checked the Gemini SDK: `@google/genai` sends the key in the `x-goog-api-key` header (`node_modules/@google/genai/dist/node/index.mjs:18385`, `:23282`), never in the request URL for the REST path — only the unused BidiGenerate websocket path puts `?key=` in a URL — so a Gemini error string cannot carry the key via a leaked URL.

*Files:* `src/server/server.ts`, `web/app.js`

### Context management: an 85% warning, a 95% compaction, and a compaction call that costs money

`agent.ts:192` reads `contextWindow(this.config.provider)` once per run. At `agent.ts:209-213` a one-shot `warning` event fires past the depth threshold; at `agent.ts:220-226` past `COMPACT_RATIO` the turn array is replaced in place by `await compactTurns(turns, this.provider)`. `compactTurns` (`src/agent/context.ts:15-34`) keeps the last 4 turns, walks `cut` backwards while `turns[cut].role === "tool"` so the kept window never opens on a dangling tool result (`context.ts:23` — the comment explains that every provider rejects that), renders the older turns to text via `describeTurn` (tool outputs truncated to 200 chars), and issues **a second billed provider call** with an empty tool list to summarise. That reply's `usage` is discarded at `context.ts:27` — it destructures only `{ text }`.

*Files:* `src/agent/agent.ts`, `src/agent/context.ts`

### `splitModelId` resolves the `provider/model` ambiguity by consulting the catalog

`catalog.ts:166-174`. If an explicit provider is supplied it is trusted verbatim. Otherwise it splits on the *first* `/` only when the head is a key in `CATALOG` — the comment notes model names legitimately contain slashes (`accounts/fireworks/models/...`, `@cf/qwen/qwq-32b`, `zai-org/GLM-5` all appear in the shipped catalog). Unknown head means `{provider: "", model}` with the full string preserved. Re-exported through the server at `server.ts:394` and consumed by `POST /model` (`server.ts:276`) and `src/commands/registry.ts:78`. `server.test.ts:55-58` covers all three branches.

*Files:* `src/providers/catalog.ts`, `src/server/server.ts`

### Observations, edge cases and minor notes (22)

- `scripts/gen-catalog.ts:83` — `SKIP_IDS` (gen-catalog.ts:25-36) is now entirely dead code. The condition is `if (SKIP_IDS.has(p.id) || !ALLOW_IDS.has(p.id))` and no member of SKIP_IDS appears in ALLOW_IDS, so the first clause can never be the deciding one. Ten entries and their explanatory comment now cost reading time for nothing.
- `scripts/gen-catalog.ts:13` — `RawModel.limit?.context` is declared at gen-catalog.ts:13 but `limit` is never referenced anywhere in `main()`. models.dev supplies a real per-model context window and the generator throws it away, which is why `contextWindow()` is stuck at per-provider granularity with a 128k default.
- `scripts/gen-catalog.ts:126` — `Bun.write("src/providers/catalog.generated.ts", out)` uses a cwd-relative path, so `bun run scripts/gen-catalog.ts` from any directory other than the repo root writes the file into the wrong place and silently reports success.
- `scripts/gen-catalog.ts:130` — `main()` is called bare with no `.catch()`. A models.dev outage produces an unhandled rejection rather than a clean `amux: ...` error, and nothing sets a non-zero exit code explicitly.
- `src/providers/catalog.ts:154` — The catalog now ships four near-duplicate provider pairs the picker shows side by side: `fireworks` ("Fireworks", .../inference/v1) vs `fireworks-ai` ("Fireworks AI", .../inference/v1/ — note the trailing slash), `moonshot` ("Moonshot (Kimi)") vs `moonshotai` ("Moonshot AI") on the *identical* baseURL https://api.moonshot.ai/v1, `ollama` vs `ollama-cloud`, and `deepseek`/`openrouter`/`lmstudio` which exist in both layers (manual wins). A user with a Moonshot key must guess which of two identical entries to authenticate.
- `src/providers/catalog.ts:83` — MANUAL_CATALOG is the *sole* source for groq, xai, mistral, together and cerebras now that ALLOW_IDS excludes them — but models.dev still carries `groq`, `xai`, `mistral`, `togetherai` and `cerebras` upstream (verified against a live api.json fetch). Their hand-frozen seeds have rotted: `xai` offers `grok-2`/`grok-2-mini` while the `requesty` generated entry two screens away lists `xai/grok-4` and `xai/grok-4-fast`.
- `src/providers/catalog.ts:97` — MANUAL `together` uses id `together`; models.dev's id is `togetherai`. The two would never have collided, so the "hand-maintained overrides generated" contract was never actually exercised for this provider.
- `src/providers/catalog.ts:148` — `custom` is declared `category: "byok"` *and* `keyOptional: true` (catalog.ts:148-149). That combination makes `authLogin` take the local-endpoint branch (`cli.ts:205`, condition `(entry.category ?? "byok") === "local" || entry.keyOptional`), so a user configuring a custom OpenAI-compatible endpoint is prompted for a base URL first and stored as `type: "local"` — a shape that has no `key` field at all. There is no way to store a baseURL *and* a key for one provider; `AuthCredential` has no such variant and `setCredential` upserts by provider.
- `src/cli.ts:41` — `amux-core keys set <provider>` (cli.ts:41-47) does not validate the provider against CATALOG. `keys set opanai` prints "Stored opanai key in the OS keychain." and the key is unreachable forever, because `envVarName`/`getKey` only ever look up ids that exist in the catalog.
- `src/server/server.ts:264` — `GET /models?provider=bogus` returns `{provider:"bogus", models:[]}` with a 200. An unknown provider is indistinguishable from a provider with no seeds (which `custom` legitimately is), so the TUI picker shows the same empty list for a typo and for the intended escape hatch.
- `src/providers/catalog.ts:139` — `github-copilot`'s env fallback is named `GITHUB_COPILOT_TOKEN` but the value must be a GitHub *OAuth* token (`gho_…`) — `factory.ts:30` comments "apiKey is the GitHub OAuth token" and `CopilotProvider` exchanges it for the actual Copilot token. Anyone who exports their Copilot API token into that variable gets a confusing 401 from the exchange endpoint, not from the chat endpoint.
- `src/providers/catalog.ts:141` — Copilot's seed model list `["gpt-4o","claude-3.7-sonnet","o1","gemini-2.0-flash"]` is hand-frozen from Jul 28, even though api.githubcopilot.com exposes a `/models` endpoint the CopilotProvider could query with the token it already holds.
- `src/providers/copilot.ts:53` — `pollForToken` sleeps *before* its first poll (copilot.ts:53, `await sleep(wait * 1000)` at the top of the loop), so a user who authorises instantly still waits a full GitHub-supplied interval (typically 5s) before login completes.
- `src/providers/copilot.ts:65` — On `slow_down` the wait is *set* to `interval + 5` rather than incremented (copilot.ts:65). Repeated slow_down responses therefore never back off further, which is the opposite of what the signal asks for.
- `src/providers/copilot.ts:63` — `pollForToken` never checks `res.ok` before `res.json()`. A GitHub 5xx returning an HTML error page throws a raw JSON-parse SyntaxError out of the login command instead of a useful message.
- `src/providers/copilot.ts:94` — `CopilotProvider.client()` discards the previous `OpenAIProvider` on every token refresh (copilot.ts:94), taking its accumulated `lastRateLimit` with it. Harmless today (Copilot does not emit `x-ratelimit-*`), but it also means `parseRateLimit(headers, "openai")` runs against Copilot responses for no benefit.
- `src/providers/catalog.test.ts:8` — `catalog.test.ts` asserts `envVar` matches `/^[A-Z0-9_]+$/` — which `CLOUDFLARE_ACCOUNT_ID` and `DATABRICKS_HOST` both satisfy. The test suite therefore cannot catch the wrong-env-var defect, and nothing asserts that `baseURL` is free of unresolved `${…}` templates.
- `src/providers/catalog.test.ts:43` — The rewritten breadth test now asserts `> 20 && < 60` (catalog.test.ts:43-46). The live count is 34, so the window is wide enough that adding or dropping a dozen providers would not trip it — it pins nothing in particular.
- `src/providers/pricing.ts:30` — `pricing.ts` includes a `"claude-3.7-sonnet"` key (line 18) that can never be reached: `"claude-sonnet"` is not a prefix of `"claude-3.7-sonnet"`, but no other entry is either, so it works — however `"gemini-3"` (line 30) *does* shadow-compete with `"gemini-3.6-flash"` (line 31) and the longest-prefix rule resolves it correctly only because both carry identical values. Two entries, one price, no behavioural difference.
- `.amux/agents.yaml:2` — `.amux/agents.yaml` is tracked in git (`.gitignore` excludes only `session.json`, `amux.db*` and `reports/`) and currently holds a developer scratch roster — a single agent with `id: a`, `role: A`, `systemPrompt: "You are the A. A Implement your assigned tasks…"` and `theme: neon graveyard`. It is uncommitted-modified right now and would ship as the project's example config.
- `src/providers/gemini.ts:40` — `gemini.ts:40` carries an `// eslint-disable-next-line @typescript-eslint/no-explicit-any` comment, but there is no ESLint config or eslint dependency anywhere in package.json — the suppression is vestigial.
- `src/providers/gemini.ts:65` — `gemini.ts:65` `let n = 0` is the tool-call counter, scoped per `send()` call. Ids therefore restart at 0 every turn, so `tool-0` from turn 3 and `tool-0` from turn 5 collide in any store keyed by call id. Harmless for Gemini itself (which pairs by name) but worth knowing if ids ever get persisted.


---

## 5. The core server and the web dashboard

### One Bun.serve instance, loopback-only, token-gated, started from the engine

`startServer(engine, opts)` (src/server/server.ts:48) creates a single `Bun.serve<TerminalSocketData>` with `hostname: "127.0.0.1"` (line 129), `port: opts.port ?? 0` (ephemeral by default) and `idleTimeout: 0` (line 130, so long-lived SSE isn't reaped). I verified the bind empirically: `lsof -nP -iTCP:8796` shows `TCP 127.0.0.1:8796 (LISTEN)` and a request to the machine's LAN address (172.18.117.92:8796) times out while 127.0.0.1 answers 200. There is no LAN exposure and no configuration knob that could create one. The returned `ServerHandle` is `{url: "http://127.0.0.1:<port>", token, port, stop}` (lines 383-389); `stop()` is `server.stop(true)` (force-close).

*Files:* `src/server/server.ts`

### Auth model: one process-lifetime UUID bearer token, constant-time compared, with a small public surface

`const token = opts.token ?? crypto.randomUUID()` (server.ts:52). Everything above line 148 is public: `/health`, `/`, `/dashboard`, `/dashboard/*`, `/app.js`, `/style.css`, `/theme.js`, `/avatar.js`, the three `VENDOR_FILES` xterm paths, `/palettes.json`, `/graph/view`, `/graph.js`. Everything below is gated by `tokensMatch(provided, token)` (line 151) where `provided` is `Authorization: Bearer <t>` or `?token=` (line 150) — the query-string path exists because `EventSource` cannot set headers. `tokensMatch` (lines 416-421) uses `crypto.timingSafeEqual` after a length check, and is unit-tested in server.test.ts:61-68. There is no session, no expiry, no rotation, no per-route scoping: the same token that reads `/stats` also authorizes `POST /prompt` (arbitrary agent tasks) and `GET /terminal/ws` (a shell).

*Files:* `src/server/server.ts`, `src/server/server.test.ts`

### Handshake: the first stdout line is the machine-readable contract with the Go TUI

`serveMain()` (src/server/main.ts:21-58) builds the Engine from `.amux/agents.yaml` (empty roster = "setup mode", line 24-25), starts the server, and writes exactly one stdout line: `{"amuxServer":{"url":...,"token":...}}` (main.ts:56). Every other message goes to stderr so that line is always first. `tui/cmd/amux/main.go:51` spawns `bun run <entry>` and parses it. Port selection: no `--port` means port 0, so collisions are impossible for the TUI path; with an explicit `--port=N` already in use, Bun throws and main.ts:63-66 prints `amux serve: Failed to start server. Is port 8794 in use?` and exits 1 — I reproduced this exactly by starting two servers on 8794.

*Files:* `src/server/main.ts`, `tui/cmd/amux/main.go`

### EventHub: a 2000-entry replay ring plus a Set of live subscribers

src/server/events.ts defines `ServerEventBody` as an 8-arm discriminated union (agent_event, agent_message, orchestration, usage, approval_request, lock, session, theme) stamped with a monotonic `seq` and `time` by `publish()` (lines 28-35). `BUFFER_MAX = 2000` (line 21) with `buffer.shift()` once full. `replay(fromSeq)` filters `e.seq > fromSeq` (line 39) and `subscribe(fn)` returns an unsubscribe closure (lines 46-49). `publish` calls every subscriber synchronously in the publishing call stack, so a subscriber that blocks blocks the engine.

*Files:* `src/server/events.ts`

### SSE endpoint: replay-then-subscribe inside a ReadableStream, with a 25s comment ping

`sse(fromSeq)` (server.ts:94-125) builds a `ReadableStream` whose `start(controller)` first drains `engine.hub.replay(fromSeq)` into the socket, then registers `unsub = engine.hub.subscribe(send)` and a `setInterval(..., 25_000)` that writes `: ping`. Each frame is `id: <seq>\ndata: <json>\n\n` (line 102) — so an `id:` is emitted, which makes browsers send `Last-Event-ID` on reconnect, but the handler only ever reads `?from=` (line 153). `cancel()` clears the interval and unsubscribes (lines 117-120). Both `enqueue` calls are wrapped in empty `catch` blocks.

*Files:* `src/server/server.ts`

### Static-file serving is a whitelist plus one prefix route, and path traversal is genuinely closed

`serveFile(rel)` (server.ts:62-73) does `normalize(rel).replace(/^(\.\.[/\\])+/, "")`, joins onto `webDir`, then requires `file.startsWith(webDir) && existsSync(file)`. Content type comes from `CONTENT_TYPES[ext]` with an `application/octet-stream` fallback, plus `cache-control: no-cache`. I probed the live server with `curl --path-as-is`: `/dashboard/../../package.json` → 401 (Bun's WHATWG URL normalises dot segments before the handler sees them, so it falls through to the token gate), `/dashboard/..%2f..%2fpackage.json` → 404 (%2f is not decoded), `/dashboard/....//package.json` → 404, `/dashboard/%2e%2e/%2e%2e/package.json` → 401 (%2e IS decoded, then normalised away). No probe escaped `web/`.

*Files:* `src/server/server.ts`

### Runtime asset location is derived from import.meta.url, in three places

`webDir = opts.webDir ?? new URL("../../web", import.meta.url).pathname` (server.ts:53), `nodeModulesDir = new URL("../../node_modules", import.meta.url).pathname` (line 75), and `palettesFile = new URL("../../tui/internal/theme/palettes.json", import.meta.url).pathname` (line 88). Because they are anchored to the module rather than cwd, running the server from an unrelated directory works — I started `bun run src/server/main.ts` from /tmp and `/dashboard`, `/app.js`, `/style.css` all served correctly. The `.pathname` accessor (rather than `fileURLToPath`) and the `bun build --compile` `/$bunfs/` root are where this breaks (see findings).

*Files:* `src/server/server.ts`

### The route table is a flat if-ladder of ~25 routes covering session, control, catalog, auth, stats and worktree

In order: `/health`, static, `/events`, `/terminal/ws`, `POST /session` (the fat handshake: agents, tasks, lastSeq, running, root, lsp, mcp, contextLimits, theme — server.ts:164-179), `POST /prompt` (409 if `engine.running`), `POST /cancel`, `POST /undo`, `GET /commands` + `POST /commands/:name` (always 200, the command's own `ok` carries failure — line 202-204), `GET /graph`, `GET /stats` (prices each per-model row through `costOf` and reports `costComplete`), `GET /sessions`, `GET|POST /agents`, `POST /theme`, `GET /providers`, `GET /models`, `POST /model`, `GET|POST|DELETE /auth` (list is redacted by `redact()` at line 408), `GET /worktree`, `POST /worktree/merge`, `POST /agents/:id/message`, `POST /approval`. Unmatched requests get `{error: "no route <METHOD> <path>"}` 404.

*Files:* `src/server/server.ts`

### Two independent dashboard pages, both plain classic scripts with no bundler and no external network

`web/index.html` loads `/avatar.js`, `/app.js`, `/theme.js` in that order; `web/graph.html` loads `/avatar.js`, `/graph.js`, `/theme.js` and carries its own inline `<style>` rather than `/style.css`. `avatar.js` deliberately exports real globals (`AVATAR_COLORS`, `drawPixelAvatar`) because both canvases call them; `theme.js` is wrapped in an IIFE precisely because `params`/`TOKEN`/`$` would otherwise collide with app.js's identically-named top-level consts in the shared global scope (theme.js:8-10). Every page reads its token from `location.search`.

*Files:* `web/index.html`, `web/graph.html`, `web/avatar.js`, `web/theme.js`

### app.js: an SSE reducer over a Map of nodes, three innerHTML panels, and a hand-rolled force canvas

`connect()` opens `EventSource('/events?from=0&token=...')` (app.js:71) and `handle(e)` switches on `e.kind` (81-117). Agent state lives in `nodes: Map<id, {status, log[], pending, tokens, colorIndex...}>`; `feedDelta` accumulates streamed text until a newline (169-174) mirroring the TUI, `pushLog` caps each agent's transcript at 300 lines. Panels (`renderTasks`, `renderMessages`, `renderUsage`, `renderAgentPanel`, `renderApproval`) each rebuild their container's full `innerHTML` from scratch. The canvas loop is `draw()` → `step()` (an O(n²) spring/repulsion sim over normalised 0..1 coordinates) → per-node `drawPixelAvatar` → unconditional `requestAnimationFrame(draw)` (line 429).

*Files:* `web/app.js`

### graph.js: two modes over one renderer, with Barnes–Hut physics, an idle-detector and a minimap

Project mode fetches `GET /graph` and colours nodes by top-level directory; Models mode seeds from `POST /session` then live-updates from SSE, laying agents on a fixed ring (`setGraph`, lines 137-149) with physics disabled entirely (`tick()` returns early for `mode === "models"`, line 236). Project mode runs Fruchterman–Reingold with a Barnes–Hut quadtree (`buildTree`/`insert`/`repulse`, lines 178-223, theta 0.9, depth guard 48), velocity damping, a normalised centroid gravity, a force cap of `k*0.5`, and two freeze conditions (`alpha < alphaMin`, or `vmax < 0.0025`). `still()` (lines 338-346) makes a settled project graph stop redrawing entirely by hashing hover/selected/search/labels/size/camera into `lastKey`. Rendering batches all edges into four `Path2D`s, culls off-screen nodes, and does a two-pass O(labels×placed) label-collision scan (self-flagged with a `ponytail:` comment at line 439).

*Files:* `web/graph.js`

### The theme system is one JSON file shared by three surfaces

`GET /palettes.json` (server.ts:89-92) streams `tui/internal/theme/palettes.json` — the same file Go embeds via `//go:embed` (theme.go:34). `theme.js` fetches it, maps palette keys onto CSS custom properties (`applyPalette`, lines 21-37), persists the choice in `localStorage['amux-theme']`, POSTs `/theme` so other clients converge, and opens its own dedicated `EventSource` with `from=Number.MAX_SAFE_INTEGER` (line 86) so it only ever sees live `{kind:"theme"}` events and never a replay. Server-side, `POST /theme` mutates the closure variable `currentTheme` (so `/session` reflects it), calls `setTheme()` to persist to agents.yaml, and publishes a `theme` event (server.ts:248-255).

*Files:* `web/theme.js`, `src/server/server.ts`

### The WebSocket terminal exists as a route shape only and is documented as non-functional

`GET /terminal/ws` upgrades via `server.upgrade(req, {data:{}})` (server.ts:159-162) and the `websocket.open` handler spawns a pty with `pty.spawn(process.env.SHELL || "/bin/bash", ...)` in `engine.root`; `message` parses `{type:"input"|"resize"}` JSON frames; `close` kills the pty. A 12-line comment (lines 329-339) records that a node-pty child dies within milliseconds inside any process running `Bun.serve`, so the feature does not work end-to-end. Nothing in web/ references xterm — `grep -rn "xterm|terminal" web/*.html web/*.js` returns nothing — so the three `VENDOR_FILES` routes (server.ts:20-24) currently serve a client that does not exist.

*Files:* `src/server/server.ts`, `web/index.html`

### Test coverage: 8 server route tests plus four stub-DOM browser-script suites

server.test.ts drives a real `startServer` over real HTTP with a scripted no-network provider: token gating (line 70), commands dispatch, sessions, worktree, providers/models, live model switch, agent messaging 400/409, auth round-trip with redaction, the public dashboard shell, the public graph shell with gated `/graph` data, and one end-to-end SSE assertion that a submitted goal streams orchestration + agent_message + complete. web/*.test.ts load each browser script through `new Function(...)` against a hand-rolled DOM stub and return the internals — this is how graph.js's physics settling, glide deceleration, minimap mapping, ring layout and fit-framing get asserted without a browser. Nothing tests SSE disconnect cleanup, backpressure, static-path traversal, or the HTML-escaping of any render function.

*Files:* `src/server/server.test.ts`, `web/app.test.ts`, `web/graph.test.ts`, `web/theme.test.ts`, `web/avatar.test.ts`

### Graph data is capped at 400 files, which bounds every scale question about graph.js

`buildFileGraph(root, maxFiles = 400)` (src/graph/filegraph.ts:18) walks the tree with `readdirSync`, skips a fixed IGNORE set (node_modules, .git, dist, .amux, old-tech, …), reads each file with `readFileSync` and regex-extracts import specifiers. On this repo it returns 109 nodes / 217 edges in 78ms cold, 8ms warm. So graph.js's Barnes–Hut, viewport culling, `still()` idle-detector and batched Path2D edges are all operating on ≤400 nodes — comfortably over-engineered for the data the server can actually produce, and never stressed by it.

*Files:* `src/graph/filegraph.ts`, `web/graph.js`

### Observations, edge cases and minor notes (21)

- `src/server/server.ts:66` — `const ext = file.slice(file.lastIndexOf("."))` — for an extension-less filename `lastIndexOf` returns -1, so `slice(-1)` yields the file's LAST CHARACTER as the "extension" (e.g. `web/README` → ext `"E"`). It happens to miss every CONTENT_TYPES key and fall through to octet-stream, so it is harmless today, but it is not what the line intends.
- `src/server/server.ts:141` — `if (p in VENDOR_FILES)` uses the `in` operator, which walks the prototype chain. It is safe only because every request pathname starts with "/" and no Object.prototype key does. `Object.hasOwn` says what is meant.
- `src/server/server.ts:153` — `sse(Number(u.searchParams.get("from") ?? 0))` — a non-numeric `from` produces NaN, and `replay()`'s `e.seq > NaN` is always false, so the client silently gets zero backfill instead of a 400. Verified live: `GET /events?from=abc` streams live events but replays nothing.
- `web/app.js:215` — `esc()` in app.js and graph.js escapes only `& < >`; theme.js's `esc()` also escapes `"`. The two-tier escaping is an accident waiting to matter — theme.js is the only one that interpolates into attributes, and it is the only one that is correct.
- `web/app.js:152` — `n.activity = ae.payload.slice(0, 60)` writes a field that is never read anywhere in web/ (grep for `activity` returns only the declaration at line 51 and this assignment). Dead state kept alive per agent per event.
- `web/app.js:429` — app.js's `draw()` unconditionally re-arms `requestAnimationFrame` and re-runs the whole O(n²) `step()` + full repaint at 60fps forever, even with zero agents and zero activity. graph.js solved exactly this with `still()`; the dashboard never got the same treatment.
- `src/server/events.ts:32` — `buffer.shift()` on every publish once the ring is full is an O(BUFFER_MAX) memmove per event — 2000 elements per agent delta at token rate. A head index or a slice-on-overflow costs nothing and removes it.
- `src/server/server.ts:102` — `JSON.stringify(e)` runs once per subscriber per event (inside each stream's `send`), so N connected clients stringify the identical event N times. Stringify once in `publish` and hand subscribers the string.
- `web/theme.js:86` — Every open dashboard/graph tab holds TWO SSE subscriptions: app.js/graph.js's stream plus theme.js's own dedicated `EventSource` (documented as a deliberate design choice). There is no cap on subscriber count anywhere.
- `web/graph.html:111` — graph.html loads /theme.js but contains no `#theme-btn` / `#theme-menu` / `#theme-dot` — `boot()` bails at `if (!btn || !menu) return` after applying the palette, so the graph page silently inherits whatever theme was last chosen elsewhere with no way to change it on that page.
- `web/graph.js:117` — `onEvent` calls `syncModels()` inside the `handoff` branch and again unconditionally two lines later — the orchestration path does a redundant double full-graph rebuild for handoff events.
- `web/graph.js:477` — `miniRect()` recomputes the bounding box over every node and is called from `pointerdown`, `pointermove` (twice per move via `inMini`), `dblclick` and `drawMinimap` — an O(n) scan per mouse-move event. Fine at ≤400 nodes; it is the first thing that bites if the 400-file cap is ever raised.
- `web/graph.js:478` — The minimap only appears at `nodes.length >= 12`, so on a small project the documented "click the mini-map to jump" hint in graph.html points at something that isn't on screen.
- `web/graph.js:722` — `buildLegend(...).slice(0, 14)` silently truncates the directory legend; a project with more than 14 top-level source directories gets colours on screen with no legend entry, and no "+n more".
- `web/graph.js:60` — `n.label.replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|go)$/, "")` strips extensions from labels, so `catalog.ts` and `catalog.test.ts`… actually collapse to distinct labels, but `foo.ts` and `foo.go` in different directories both render as `foo` with no disambiguation; the tooltip's `esc(n.id)` is the only way to tell them apart.
- `web/index.html:19` — The dashboard has no UI for `POST /cancel` or `POST /undo` even though both routes exist and the TUI exposes them; the prompt bar simply disables itself while `running` with no way to stop a run from the browser.
- `web/index.html:10` — Nothing links /dashboard to /graph/view or back — the two pages are discoverable only through the TUI's `/graph` and `/dashboard` slash commands (tui/internal/session/session.go:491-501).
- `src/server/server.ts:198` — `GET /commands` exists and is exercised by server.test.ts, but no web/ file ever calls it — the slash-command registry is TUI-only in practice, despite the route comment claiming "one registry, every client".
- `src/server/server.ts:164` — `POST /session` is a POST that mutates nothing except triggering `engine.emitUsage()`; it is the handshake, not a resource. Harmless, but it means the dashboard cannot be bookmarked-and-refreshed by a plain GET, and any future CORS/preflight work has to account for it.
- `web/avatar.js:58` — `AVATAR_COLORS` has exactly 6 entries and `drawPixelAvatar` wraps modulo 6, so a 7th agent is visually indistinguishable from the first (same colour AND same face). tui/internal/wizard/picker_test.go:15 encodes this as MaxAgents, but the server does not enforce any roster cap on `POST /agents`.
- `src/server/server.ts:408` — `redact()` returns only `{provider, type}` — correct, but `GET /auth` is the only route that redacts. `POST /session` returns `engine.configs` verbatim, which includes each agent's `baseURL` and any other config field; worth confirming no future AgentConfig field carries a secret.


---

## 6. Persistence, configuration, MCP, LSP, and the file graph

### Two-tier persistence: JSON task board + SQLite conversation store

State is split deliberately. `src/session.ts:7` defines `const DEFAULT = ".amux/session.json"` and `saveTasks`/`loadTasks` (lines 11-20) round-trip the whole task board as `JSON.stringify({ tasks }, null, 2)`. Conversation history lives in SQLite instead — the header comment at `src/session.ts:9-10` states the reason: "The task board stays JSON (small, human-readable, hand-editable); conversation history lives in SQLite (store/), because it's large, append-heavy, and queried by session rather than read whole." `saveTasks` is called from exactly one production site, `src/engine.ts:206`, after a run session; `loadTasks` from `src/cli.ts:144` (only on `resume`), `src/server/main.ts:52` (on every core boot) and `src/commands/registry.ts:245` (`saveTasks([])` to clear the board).

*Files:* `src/session.ts`, `src/engine.ts`, `src/server/main.ts`

### SQLite schema: sessions → messages → parts, plus checkpoints and bus_messages

`src/store/db.ts` holds one `SCHEMA` template literal (lines 14-82) executed by `openDb` (line 90). Five tables: `sessions` (id, agent_id, task_id, parent_session_id self-FK, kind, provider, model, status, created_at, updated_at, time_archived), `messages` (per-session, `seq`-ordered, four token counters), `parts` (message decomposed into text/tool_call/tool_result/raw/file_ref, `content` a JSON string), `checkpoints` (one row per file mutation holding the content BEFORE the write; NULL means the file did not exist), and `bus_messages` (durable trail of the agent-to-agent channel). Five indexes: `sessions_task`, `sessions_parent`, `messages_session(session_id, seq)`, `parts_message(message_id, seq)`, `checkpoints_session(session_id, id)`, `bus_messages_session`. I dumped the live `.amux/amux.db` and the on-disk schema matches `SCHEMA` exactly; it currently holds 38 sessions / 85 messages / 109 parts / 0 checkpoints / 1 bus message.

*Files:* `src/store/db.ts`

### Turn ⇄ Parts is a pure, testable boundary

`toParts` (`session-store.ts:40-54`) and `fromParts` (`:56-68`) are pure functions with no DB dependency, and the comment at line 38-39 states the invariant `fromParts(role, toParts(turn)) === turn`. `toParts` splits an assistant turn into an optional text part, one `tool_call` part per call, and an optional `raw` part carrying opaque provider blocks (Anthropic `thinking`). `fromParts` returns `undefined` for an unrecognised role, with the comment "unknown role (schema drift) — dropped rather than crashing a resume" — the only deliberate forward-compat gesture in the whole persistence layer. `db.test.ts:19-23` asserts the round-trip over a fixture conversation that includes a `raw` thinking block.

*Files:* `src/store/session-store.ts`, `src/store/db.test.ts`

### SessionStore writes are a side-effect mirror of the in-memory turn array

`Agent.push` (`src/agent/agent.ts:351-354`) pushes onto the in-memory `turns: Turn[]` and then, only if a `sessionId` exists, calls `this.store?.appendMessage(...)`. The comment at 349-350 is explicit: "the in-memory array still drives the model call; the store append is a side-effect mirror (no session → no mirror, behaviour identical to before)". Sessions are created at `agent.ts:181` (`kind: "task"`, carries `taskId`) and `agent.ts:291` inside `subLoop` (kind comes from the caller: `"ask"` at :260, `"fork"` at :272, both with `parentSessionId` and no `taskId`). Terminal status is written by `setStatus` at agent.ts:230/243/249/319/322.

*Files:* `src/agent/agent.ts`, `src/store/session-store.ts`

### Checkpoints implement undo/rewind entirely inside SessionStore

`checkpoint()` (`session-store.ts:249-251`) stores the absolute path and the pre-write content. `undoLast()` (:256-270) pops the newest row, deletes it, then either `rmSync(row.path, {force:true})` when content is NULL or `writeFileSync(row.path, row.content)`. `rewindN()` (:285-296) wraps N `undoLast()` calls in `this.db.transaction(...)`, and `listCheckpoints()` (:273-280) is the read-only preview. The comment at :254-255 explains the placement: doing the filesystem work here "keeps every caller (CLI, server, TUI) from re-implementing it". The write side is called from `agent.ts:467`, deliberately inside the per-path lock and after the approval gate (comment at :465-466: "nothing can slip in between the snapshot and the change it's meant to undo").

*Files:* `src/store/session-store.ts`, `src/agent/agent.ts`

### stats() is pure SQL over the same rows the agent loop writes

`SessionStore.stats()` (`session-store.ts:173-199`) runs three queries: per-day tokens via `strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime')` (localtime bucketing is deliberate — comment at :171-172), per-model totals via `messages m JOIN sessions s`, and a session aggregate with `COALESCE(MAX(updated_at - created_at), 0) AS longest`. The design comment at :168-171 notes there is deliberately "no separate ledger to keep in step". `src/server/server.ts:~225-231` consumes this for `GET /stats`, layering price lookup on top and tracking a `costComplete` flag when a model has no price.

*Files:* `src/store/session-store.ts`, `src/server/server.ts`

### Config is six independent readers over one YAML file, all cwd-relative

`src/config/config.ts` exports `loadAgents`, `loadOptions`, `loadInstructions`, `loadPermissions`, `loadLspServers`, `loadMcpServers`, `saveAgents`, `setTheme` — each with `path = ".amux/agents.yaml"` as its default and each performing its own `readFileSync` + `parse`. `buildEngine` (`cli.ts:164-188`) and `serveMain` (`server/main.ts:21-57`) therefore read and YAML-parse the same file five times per boot. Severity of malformation differs by reader on purpose: `loadAgents` throws on anything missing (`validate`, :140-168), while `loadLspServers` (:79-89) and `loadMcpServers` (:92-101) `flatMap` malformed entries away — the comment at :77-78 states "a malformed entry is skipped rather than blocking startup, exactly like mcpServers above".

*Files:* `src/config/config.ts`, `src/cli.ts`, `src/server/main.ts`

### Agent validation is hand-rolled, not zod — with a provider-catalog cross-check

`validate()` (`config.ts:140-168`) uses a local `str(k)` closure that throws `${path} agent[${i}]: missing '${k}'` for any absent/empty string field, requires `id`/`provider`/`model`/`role`/`systemPrompt`, cross-checks `CATALOG[provider]` against the generated provider catalog and lists known keys in the error, and enforces that `provider: custom` carries a `baseURL`. Permissions are delegated to `parsePermissions` (`src/permissions.ts:83-101`) which throws with the exact offending key path (e.g. `permissions.shell["git *"] must be one of allow, ask, deny (got "maybe")`). No zod anywhere in this path; the messages are as good as a schema library's, but only for the fields listed.

*Files:* `src/config/config.ts`, `src/permissions.ts`

### Config writes are read-merge-write to protect hand-written blocks

`saveAgents` (`config.ts:109-129`) re-parses the existing file and spreads it (`{...existing, agents: [...]}`) so only the `agents:` key is replaced. The comment at :106-108 gives the reason: the team picker runs on every launch and "rewriting the file from scratch would silently delete the permissions/lsp/mcpServers blocks". `setTheme` (:134-138) does the identical merge for the single `theme` key, driven by the TUI's theme carousel and `POST /theme` (`server.ts:247-254`). `config.test.ts:135-160` guards exactly this: after `saveAgents`, it asserts `theme`, `maxTurns`, `permissions` and `mcpServers` all survive.

*Files:* `src/config/config.ts`, `src/server/server.ts`, `src/config/config.test.ts`

### Global vs project config: only credentials are global

There is no global `agents.yaml`, no XDG config dir, and no ancestor search for a project root. The only home-directory path in `src/` is `src/auth/auth-store.ts:16`: `process.env.AMUX_AUTH_FILE || join(homedir(), ".config", "amux", "auth.json")`. Everything else — agents, options, permissions, lsp, mcpServers, skills (`.amux/skills`), commands (`.amux/commands`), the DB (`.amux/amux.db`), the task board (`.amux/session.json`), reports (`.amux/reports/`), worktrees (`.amux/worktrees/<id>`) — is a bare relative path resolved against `process.cwd()`. `Engine.root` is likewise `opts.root ?? process.cwd()` (`engine.ts:73`).

*Files:* `src/auth/auth-store.ts`, `src/store/db.ts`, `src/engine.ts`

### MCP: namespaced tool routing over stdio child processes

`McpManager.connect` (`src/mcp/mcp.ts:34-54`) loops servers serially, builds an SDK `Client({name:"amux", version:"0.0.1"})` per server over `StdioClientTransport`, lists tools, and registers each as `mcp__<server>__<tool>` in both a `routes` map (namespaced name → {server, tool}) and a flat `specs: ToolSpec[]`. A connect failure is caught and handed to the optional `onError` callback — callers pass a `console.error` (`cli.ts:173`, `server/main.ts:33`), so an unavailable MCP server is never fatal. `call()` (:72-77) looks up the route and flattens the result through `extractText` (:20-25), which maps `{type:"text"}` blocks to their text and `JSON.stringify`s anything else. The `McpTools` interface (:12-17) exists so `Agent` depends on the surface, not the class, and `servers?()` is marked optional "so test fakes needn't implement it".

*Files:* `src/mcp/mcp.ts`

### LSP: hand-rolled JSON-RPC framing, one shared client per language

`src/lsp/client.ts` implements Content-Length framing directly (`onData`, :190-211, with a resync path for unparseable headers at :197-199 and a partial-body early return at :202). `dispatch` (:213-234) handles three cases: a server→client request gets `result: null` back (comment at :215-216: "silence would hang some servers"), a reply resolves/rejects the `pending` entry and clears its timer, and `textDocument/publishDiagnostics` fills `diagnosticsByUri` and wakes any `waiters`. `start()` (:88-91) memoizes the handshake in `this.starting` so "two agents asking for diagnostics at once share one handshake". `LspRegistry` (`registry.ts`) maps extension → server config and lazily constructs one `LspClient` per server name — `clientFor("/x/one.ts")` and `clientFor("/x/two.ts")` return the same object (asserted at `client.test.ts:50-57`) because "diagnostics are a property of the project, not of whoever asked".

*Files:* `src/lsp/client.ts`, `src/lsp/registry.ts`

### LSP tests run against a real subprocess, not a mock

`src/lsp/fake-server.ts` is a ~50-line stdio LSP server (initialize → capabilities, didOpen/didChange → a fixed diagnostic at 0-based 1:4, hover → an echo of the position, catch-all `result: null`). `client.test.ts:9-10` spawns it as `process.execPath` + the file path, so the framing, request/response pairing and diagnostics push are exercised end to end without requiring gopls or tsserver on the test machine. The 1-based conversion is pinned exactly: the server publishes `{line:1, character:4}` and the test asserts `{line:2, column:5}` (`client.test.ts:22`).

*Files:* `src/lsp/fake-server.ts`, `src/lsp/client.test.ts`

### File graph: regex import scanning, three language families, no AST

`buildFileGraph(root, maxFiles = 400)` (`src/graph/filegraph.ts:17-42`) walks the tree collecting files whose extension is in `SRC_EXT` (`.ts .tsx .js .jsx .mjs .cjs .py .go`), skipping any dot-entry and any directory in `IGNORE` (`node_modules .git dist build .amux vendor .next out target coverage old-tech`), then regex-scans each file for import specifiers. JS/TS uses one combined regex (:82) covering static imports, re-exports, dynamic `import()` and `require()`; bare specifiers are dropped as external (`resolveJs`, :91-99) after trying seven extension candidates plus `index` fallbacks. Python handles relative dots in `resolvePy` (:101-113). Go maps a package import to the first `.go` file in the matching directory (`resolveGo`, :132-140). `normalizeRel` (:158-166) is a hand-rolled `..`/`.` collapser, kept because `path.resolve` "would anchor to an absolute cwd we don't want here". Consumed synchronously by `GET /graph` at `server/server.ts:209`. Measured on this repo: 109 nodes, 217 edges, 13 ms.

*Files:* `src/graph/filegraph.ts`, `src/server/server.ts`

### Resume flattens every stored session for a task into one conversation

`resumeConversation(store, taskId)` (`src/session.ts:24-26`) is a one-liner: `store.listSessions({ taskId }).flatMap((s) => store.loadTurns(s.id))`. `Engine.resume()` (`engine.ts:169-177`) passes it as `priorTurns: (taskId) => resumeConversation(store, taskId)` into `resumeProject`, and `Agent.run` seeds `const turns: Turn[] = [...(opts.priorTurns ?? [])]` (`agent.ts:180`) with the comment that prior turns "are already persisted under their original session" so they are not re-mirrored. Because `listSessions` defaults to excluding archived rows and only `task`-kind sessions carry a `task_id`, `ask`/`fork` sub-sessions are correctly excluded from a resume.

*Files:* `src/session.ts`, `src/engine.ts`, `src/agent/agent.ts`

### Skills and user commands reuse the same frontmatter shape as config

`loadSkills` (`src/skills/skills.ts:13-30`) reads `.amux/skills/<name>/SKILL.md`, matches `/^---\n([\s\S]*?)\n---/` and YAML-parses the frontmatter for `name`/`description`, falling back to the directory name. `skillsPrompt` (:32-36) renders one line per skill into the system prompt with the file path so the agent can `read_file` the full text on demand. `loadCommands` (`src/commands/registry.ts:272-294`) uses a near-identical parser for `.amux/commands/<name>.md`, substituting `$ARGUMENTS` into the body — the comment at :268-271 says this is "deliberately the same shape as .amux/skills/<name>/SKILL.md rather than a second config format to learn". User commands are loaded last and win name clashes over built-ins (`registry.ts:298-300`).

*Files:* `src/skills/skills.ts`, `src/commands/registry.ts`

### Observations, edge cases and minor notes (23)

- `src/store/session-store.ts:210` — `SessionStore.archiveSession` (session-store.ts:210-212) has zero production callers — grep for `archiveSession` outside session-store.ts returns only db.test.ts:46. The `time_archived` column and the `includeArchived` filter branch (`:163`) are therefore permanently dead: nothing in the CLI, server, TUI or command registry can ever set it.
- `src/store/db.ts:38` — `messages.reasoning_tokens` and `messages.cache_tokens` (db.ts:38-39) are dead columns. `Usage` (providers/provider.ts:46-49) only has `inputTokens`/`outputTokens`, and `appendMessage` hardcodes `0, 0` for both in the INSERT VALUES list at session-store.ts:125.
- `src/store/session-store.ts:6` — `SessionKind` includes `"respond"` (session-store.ts:6, and the schema comment at db.ts:20) but no code path ever creates one — grep for `kind: "` in src/ shows only `"task"` (agent.ts:183), `"ask"` (agent.ts:260) and `"fork"` (agent.ts:272). Same for the `"file_ref"` PartType (session-store.ts:8): `toParts` never emits it.
- `src/store/session-store.ts:120` — `appendMessage` computes the next `seq` with `SELECT COALESCE(MAX(seq),-1)+1` at line 120, OUTSIDE the transaction that starts at line 121. Harmless in-process (Bun is single-threaded and the whole function is synchronous), but there is no `UNIQUE(session_id, seq)` constraint on `messages`, so two processes on the same DB can silently write duplicate seq values and `loadTurns`'s `ORDER BY seq` becomes ambiguous.
- `src/store/session-store.ts:164` — `listSessions` orders only by `created_at` (line 164), an integer millisecond timestamp. Two sessions created in the same millisecond (entirely plausible when the orchestrator fans out to several agents at once) come back in unspecified order, which makes `resumeConversation`'s flattened transcript non-deterministic.
- `src/store/db.ts:90` — `PRAGMA user_version` on the live `.amux/amux.db` reads 0 — it is never set. There is no version marker of any kind, so even a future migration runner would have nothing to branch on for databases created before it existed.
- `src/store/session-store.ts:190` — `stats().perModel` reports `msgs: COUNT(*)` over all messages joined to a session, which counts user and tool turns too, not just assistant replies. The /stats dashboard label ('msgs') is accurate but the number is roughly 3x what a reader expecting 'model responses' would assume.
- `.amux/amux.db-wal` — The live database is 118 KB while `.amux/amux.db-wal` is 1.96 MB (mtimes: db Aug 2 18:53, WAL Aug 3 02:13). The main file has not been checkpointed in a day of use because nothing ever calls `db.close()` and the WAL has not yet crossed SQLite's 1000-page auto-checkpoint threshold.
- `src/config/config.ts:11` — `loadAgents` (config.ts:11-12) does no `existsSync` guard and calls `readFileSync` directly, unlike every other loader in the file. It relies entirely on `surfaceStartupError`'s ENOENT regex to turn the raw Node error into a user-facing message — and `serveMain` (server/main.ts:24) has to guard with its own `existsSync` before calling it.
- `src/config/config.ts:21` — Duplicate agent ids are accepted silently. `loadAgents` on a file with two agents both `id: a` returns `["a", "a"]` (verified by running it). `Engine.byId` is a Map, so the second agent silently shadows the first and one configured teammate never runs.
- `src/skills/skills.ts:22` — `loadSkills` calls `parse(m[1]!)` on SKILL.md frontmatter with no try/catch (skills.ts:22); `loadCommands` does the same at registry.ts:279. One malformed `.amux/skills/foo/SKILL.md` throws a raw YAMLParseError out of `buildEngine`/`serveMain` and takes down boot — the same class of failure the config loaders were carefully written to avoid.
- `src/session.ts:18` — `loadTasks` (session.ts:18) calls `JSON.parse` with no try/catch, and `saveTasks` (:13) writes with a plain `writeFileSync` — no temp-file-plus-rename. Since the Go TUI terminates the core with `cmd.Process.Kill()` (SIGKILL, tui/cmd/amux/main.go:39), a kill landing inside that write leaves a truncated session.json, and the next core boot dies with a raw SyntaxError at server/main.ts:52 — before the handshake, so the TUI can only report "core did not hand shake".
- `src/graph/filegraph.ts:54` — `walk` skips every entry whose name starts with `.` via `if (e.name.startsWith(".") && e.name !== ".")` — the `&& e.name !== "."` clause is dead, `readdirSync` never returns `.` or `..`. Also means `.github/`, `.claude/` and dotfile-named sources are invisible to the graph regardless of IGNORE.
- `src/graph/filegraph.ts:136` — `resolveGo` (filegraph.ts:136-138) does a linear scan of the entire file `Set` for every Go import, checking `dirname(id) === dir`. That is O(imports × files) per Go file — invisible at 400 files but the only quadratic path in the scanner.
- `src/lsp/client.ts:184` — `LspClient.send` (client.ts:184-188) writes to `this.proc?.stdin` with no `'error'` listener registered on the stdin stream anywhere in the file. If the language server dies between the `exit` event dispatch and a queued `notify`, the EPIPE surfaces as an unhandled stream error rather than being folded into the existing `die()` path.
- `src/lsp/client.ts:10` — `DIAGNOSTICS_WAIT_MS` is 3000 and `REQUEST_TIMEOUT_MS` is 10000 (client.ts:10-11), both hardcoded with no config knob. gopls or rust-analyzer on a cold cache routinely exceeds both on a large repo, so the `diagnostics` tool will report an empty (i.e. falsely clean) result to the model.
- `src/lsp/client.ts:116` — `waitForDiagnostics` (client.ts:152-164) resolves on timeout and `diagnostics()` then returns `this.diagnosticsByUri.get(uri) ?? []` — an empty array. The tool output is indistinguishable from a genuinely clean file, so a slow server makes the agent believe its code compiles.
- `src/mcp/mcp.ts:35` — `McpManager.connect` awaits each server serially in a `for` loop (mcp.ts:35). With three MCP servers each taking ~1s to hand shake, boot is ~3s of dead time before the handshake line the Go TUI is blocking on. `Promise.allSettled` over the same body would be the same code shape.
- `src/mcp/mcp.ts:75` — `McpManager.call` uses a non-null assertion: `this.clients.get(ref.server)!.callTool(...)` (mcp.ts:75). The route map and the client map are populated together so it holds today, but nothing enforces it structurally.
- `src/cli.ts:165` — `buildEngine` reads and YAML-parses `.amux/agents.yaml` five separate times per boot (loadAgents, loadOptions, loadMcpServers, loadPermissions, loadLspServers at cli.ts:165-183). Beyond the wasted work, an edit landing mid-boot yields an engine built from two different versions of the file.
- `src/config/config.ts:18` — `AmuxOptions.maxAgents` is documented as a knob (config.ts:33) but is only enforced inside `loadAgents` (:18-20), never re-checked when the dashboard POSTs a new roster to `/agents` — so the cap can be exceeded by writing the file through the API and only bites on the next boot.
- `.gitignore` — `.amux/agents.yaml` is NOT in .gitignore (which lists `.amux/session.json`, `.amux/amux.db*`, `.amux/reports/`), so the agent roster is committed — visible in git status as a modified file. Fine for a project-shared team, but `baseURL` for a self-hosted endpoint also lands in the repo.
- `.amux/agents.yaml:7` — The current `.amux/agents.yaml` is a single-agent roster (`id: a`, `provider: google`, `model: gemini-flash-latest`, `role: A`, `lead: true`) whose systemPrompt reads "You are the A. A Implement your assigned tasks directly" — the `${role}` template from `runInit` (cli.ts:~254) with a one-letter role produces that stutter. Ships as the repo's example config.


---

## 7. The Go TUI — the primary user-facing surface

### Two-process architecture: Go TUI parent, Bun core child, HTTP+SSE between them

`main()` in tui/cmd/amux/main.go:156 calls `startCore()` (line 45), which either attaches to an already-running server via `AMUX_SERVER_URL`/`AMUX_SERVER_TOKEN` (line 46-48) or spawns `exec.Command(bunBin, "run", entry)` where `bunBin`=`AMUX_BUN` or "bun" and `entry`=`AMUX_CORE_ENTRY` or "src/server/main.ts" (lines 49-51). It then blocks on `r.ReadString('\n')` (line 61) reading one line of JSON from the child's stdout, unmarshals it into `handshake{AmuxServer{URL,Token}}` (line 25-30), and builds `api.New(url, token)`. The core side is src/server/main.ts:56, `process.stdout.write(JSON.stringify({amuxServer:{url,token}})+"\n")`. There is no fixed port: src/server/server.ts:128 uses `port: opts.port ?? 0` (ephemeral) and returns `http://127.0.0.1:${port}` at line 385, so the handshake is the only way the TUI learns where to connect. A goroutine at main.go:71-81 drains any further child stdout into stderr so the pipe can never fill and block the core.

*Files:* `tui/cmd/amux/main.go`, `src/server/main.ts`, `src/server/server.ts`

### Launch sequence: core → picker → core restart → session, with two separate Bubbletea programs

`main()` runs two `tea.NewProgram(...).Run()` calls in sequence, both with `screenOpts()` (main.go:143-149 = `tea.WithAltScreen()` plus `tea.WithMouseCellMotion()` unless `AMUX_NO_MOUSE` is set). First `wizard.NewPicker(c.client)` (line 172); if the returned model isn't a `wizard.Picker` with `Completed==true`, `main` simply `return`s (lines 176-178) and amux exits. On success the picker has already POSTed the roster to `/agents`, so main.go:180-183 kills the core and re-spawns it to pick up the rewritten `.amux/agents.yaml` (the server explicitly refuses to hot-reload — src/server/server.ts:245 returns `note: "saved to .amux/agents.yaml — restart the session to apply"`). Then `sess.Theme` from `/session` is applied via `theme.Use` (line 189), an SSE pump goroutine is started, and `session.New(...)` runs as the second program.

*Files:* `tui/cmd/amux/main.go`, `src/server/server.ts`

### SSE reconnect state machine with seq-based replay

`streamWithReconnect` (main.go:90-129) owns an outer `events chan api.Event` that is never closed. Each attempt allocates a fresh buffered `tap` channel plus a forwarder goroutine that records `fromSeq = e.Seq` as it copies events across, so a reconnect issues `GET /events?from=<lastSeq>` and the server replays only the gap. `api.Client.StreamEvents` (client.go:392-442) distinguishes deliberate shutdown (`ctx.Err()` → returns `ctx.Err()`) from anything else (`ErrStreamDisconnected`, client.go:384), including a clean server-side close, so the loop knows whether to retry. Backoff doubles from 1s to a 15s cap (lines 92-93, 125-127). The SSE parser is a `bufio.Scanner` with a deliberate 32MB line cap (client.go:410-414, carrying a `ponytail:` comment naming the ceiling), accumulating `data:` lines into a `strings.Builder` and flushing on a blank line.

*Files:* `tui/cmd/amux/main.go`, `tui/internal/api/client.go`

### Session model: one Elm-style Model, event application separated from rendering

`session.Model` (session.go:89-125) holds `order []string` (roster order), `agents map[string]*agentState`, plus `tasks`, `messages`, `feed`, `approvals`, and five mutually-exclusive popup structs (`car carousel`, `sett settings`, `out output`, `diffv diffview`, `tp themePicker`). `Update` (195-264) dispatches by message type; `eventMsg` calls `m.apply` (526-569) and immediately re-arms `waitFor(m.events)` (line 259) — a self-perpetuating single-item read from the SSE channel, which is why one channel receive equals exactly one `Update`+`View` cycle. `apply` fans out to `applyAgentEvent` (571-605) and `applyOrch` (628-659). Per-agent transcript state lives in `agentState.push` (58-66, capped at `agentLogMax=60`) and `feedDelta` (73-87), which buffers streamed chunks in `pending` and flushes on `\n` or at `maxPendingLine=400`.

*Files:* `tui/internal/session/session.go`

### Key routing is a strict priority ladder in onKey

`Model.onKey` (session.go:266-373) resolves keys in a fixed order: ctrl+c first (two-press arm/quit with `quitGrace=3s`, lines 269-278), then `m.out` pager, `m.sett` settings, `m.car` carousel, `m.tp` theme picker (280-291), then the approval gate (295-318, which routes to the full-screen `diffViewKey` when `approvalDiff` matches and otherwise handles y/a/n on a one-line bar), then the slash menu when open (322-348), then the global switch (tab/ctrl+p/shift+tab/ctrl+t/enter, 350-368), and finally the textinput. Each popup handler returns a `tea.Cmd` and swallows everything else, so keystrokes cannot leak into the prompt underneath (asserted by TestCarouselSwitchesTheModel, session_test.go:294-297).

*Files:* `tui/internal/session/session.go`

### Layout is a top-down height budget; the body is the only flexible row

`View` (view.go:42-137) allocates fixed chrome first: `headerRows=2`, then optional `tasksRows` (only if `h>=14`) and `feedRows` (2 at `h>=26`, 1 at `h>=16`), then `menuRows` (up to 6), and `bodyH = h - headerRows - tasksRows - feedRows - menuRows - 2` where the -2 is the input row plus the footer. Two successive fallbacks drop the optional strips and then the menu if `bodyH<1` (lines 89-95). The sidebar appears only when `w >= sidebarHide (76)` and is then `clamp(w/5, 22, 32)` (lines 97-100). Everything is joined and passed through one `lipgloss.NewStyle().MaxWidth(w).MaxHeight(h)` (line 125) as the single overflow guarantee — then popups are composited on top via `ui.Overlay` (128-135).

*Files:* `tui/internal/session/view.go`

### Every style carries an explicit background because the TUI paints its own canvas

view.go:144-146 defines `txt(fg,bg)` as the only styled-text constructor, with the comment explaining that an inner style setting only a foreground resets the background and punches a hole in the painted surface. This is why the sidebar/main-pane divider is a `BgPane`→`BgDeep` step rather than a drawn border (view.go:311-314), why `ui.Overlay` repaints the right-hand gap in `BgDeep` and preserves the left half with `ansi.Truncate` so the sidebar background survives (list.go:221-243), and why `padVis`/`padRight` render their filler through a background style (stats.go:310-315, output.go:93-98). `TestOverlayKeepsTheSidebarPainted` (popup_test.go:46-72) pins this invariant.

*Files:* `tui/internal/session/view.go`, `tui/internal/ui/list.go`

### ui.List is the one shared selection widget behind three surfaces

`internal/ui/list.go` implements a zero-value-usable filtered list used by the team picker, the ctrl+p model carousel, and the slash-command menu. `refilter` (56-77) matches on Label and Value only — never Desc — and ranks prefix matches ahead of substring matches by collecting the latter into `loose` and appending them (lines 63-73). `Move` wraps at both ends (80-85). `Render` (131-167) reserves the last row for a "+N more" counter, scrolls `top` to keep the cursor inside `[top, top+body)`, and deliberately does not pad to `rows` so callers can size frames to content via `Rows()` (99-107) and `NaturalWidth()` (111-125).

*Files:* `tui/internal/ui/list.go`

### Theme system: mutable package globals swapped by Use(), sourced from an embedded JSON shared with the web dashboard

`internal/theme/theme.go` embeds `palettes.json` via `//go:embed` (line 39-40) and parses it at package init into `Themes map[string]Theme` (line 59). `Use(name)` (110-121) repoints every exported color global at once; call sites read `theme.Accent` and never learn a theme exists. Per-agent identity colors are derived, not authored: the seven semantic colors are reused and `AgentColor(i)` takes `palette[index%len(palette)]` (lines 68-74, 152). The file lives inside the Go module because `//go:embed` cannot escape it, and src/server/server.ts:88 resolves that same path (`../../tui/internal/theme/palettes.json`) to serve the web dashboard, so both surfaces share one source of truth. The mutable-globals choice is justified in the package doc (lines 1-3) by Bubbletea's single-goroutine Update/View.

*Files:* `tui/internal/theme/theme.go`, `tui/internal/theme/palettes.json`

### The wizard is a staged state machine over one textinput and one list

`wizard.Picker` (picker.go:34-54) walks `stage` through loading → size → provider → (key) → model → role → desc → (repeat) → orchestrator. `advance` (154-247) is the forward transition table; `back` (251-280) is the reverse and uniquely, on the provider stage with roles already collected, pops the last completed teammate and releases its id from `usedIDs` (lines 256-261) — so esc undoes a whole teammate rather than restarting a 20-answer flow. `listStage()` (137-143) decides whether typing filters the list or is read literally, and `choice()` (147-152) makes a typed value usable when nothing in the catalog matches, so an unlisted model id is still reachable. Agent ids come from `sanitize()` (401-418), which lowercases, keeps alphanumerics, collapses runs to single dashes, and falls back to "agent".

*Files:* `tui/internal/wizard/picker.go`

### Two-pass content-driven sizing for the setup card and every popup

`Picker.View` (picker.go:446-489) measures first and draws second: `cardW := fit(m.width, widest(head,hint,fixed,roles,placeholder)+2, m.list.NaturalWidth())`, then renders the list into exactly `cardW-2`, then sizes the textinput to `inner-2` so an untyped placeholder cannot blow the card to full width (line 487, pinned by TestPlaceholderDoesNotWidenTheCard). `chrome.screen` (chrome.go:48-95) paints the brand bar and stripe, then `lipgloss.Place`s the card in the remainder with `WithWhitespaceBackground(theme.BgDeep)`, and if the card is taller than the terminal it drops the middle and keeps the last line (83-85) so the input is never pushed off-screen. The same content-first idea drives `carouselView` (carousel.go:203), `outputView` (output.go:77-81) and `themePickerView` (themepicker.go:105).

*Files:* `tui/internal/wizard/picker.go`, `tui/internal/wizard/chrome.go`

### Approvals: a FIFO queue where only head-of-line is answerable, with an optimistic local pop

`apply` sets `m.approvals = e.Requests` wholesale on each `approval_request` snapshot (session.go:566-567). Answering pops locally *before* the round trip (session.go:315, diffview.go:159) with an explicit comment that a stray extra keypress in the round-trip window must not re-answer or answer the wrong, shifted request. `diffview.go` adds batch preview: tab/shift+tab cycle `m.diffv.idx` through pending items but the guard at lines 143-145 returns early for `idx != 0` because the server only ever resolves `pending[0]`; the header and key hints change to "(preview N/M, read-only)" accordingly (diffview.go:190-192, 232-234). In-place editing seeds a textarea from `editSeed` and stores the result under `editedField(tool)` ("content" for write_file, "newString" for edit, lines 35-46), previewing it with `crudeDiff` which deliberately diffs the user's edit against the model's proposal rather than the true prior file content (lines 55-69).

*Files:* `tui/internal/session/diffview.go`, `tui/internal/session/session.go`

### Slash commands are split between a server registry and a small local set

`fetchCommands` pulls `GET /commands` into `m.commands` on Init (session.go:156, 161-169). `menuItems` (390-413) unions that registry with the commands only the client can service — /help, /graph, /dashboard, /settings, /config, /stats, /theme, /quit — deduping by name. `submit` (443-524) intercepts /quit-/exit-/q, /theme (bare opens the picker, with an argument applies directly), the five settings tabs via `settingsTabFor`, /help, bare /model, /graph and /dashboard (which shell out through `openBrowser` with the bearer token as a query param, lines 492 and 499), and only then dispatches to the server, guarded by `knows()` (664-674) which fails open before the registry has arrived. Results are routed by shape in `show()` (output.go:28-38): one line goes to the footer status, multi-line opens the scrollable pager.

*Files:* `tui/internal/session/session.go`, `tui/internal/session/output.go`

### The stats overlay is pure rendering over one /stats payload

`fetchStats` (session.go:178-183) runs once when the overlay opens and lands in `statsMsg`. Everything in stats.go is a pure function over `api.Stats.PerDay`/`PerModel`: `heatmap` (36-118) builds a GitHub-style year grid, winding back from the Sunday that starts this week so the rightmost column is the current week, quantising into five shade glyphs at peak/4 boundaries, and placing month labels only when ≥3 columns from the last one to avoid "JAug" collisions; `dayChart` (121-172) is a vertical bar chart with a guaranteed-one-cell floor for any nonzero day; `streaksAt` (190-219) sorts parsed dates and allows the current run to end yesterday. The split into `streaks`/`streaksAt` and `activeSpan`/`activeSpanAt` exists purely so `time.Now()` can be injected in tests (settings_test.go:51-87).

*Files:* `tui/internal/session/stats.go`, `tui/internal/session/settings.go`

### Test posture: strong on the session/wizard render invariants, absent on api/ui/main

`go test ./...` passes; `go build ./...` and `go mod tidy -diff` are both clean on Go 1.26.5. The session and wizard packages carry real invariant tests — the view must exactly fill the terminal and never exceed it at 40x10 through 200x60 (session_test.go:68-96, 341-364; picker_test.go:216-235), the sidebar must be dropped rather than squeezed (99-112), popups must hug their content (popup_test.go:23-42), the overlay must not blank the sidebar (46-72), esc must revert a live theme preview (themepicker_test.go:14-36), and batch preview must be read-only (diffview_test.go:34-60). But `internal/api`, `internal/ui` and `cmd/amux` have zero test files, which leaves `ui.List`'s filter/scroll math, `ui.Overlay`'s row surgery, `api.StreamEvents`' SSE parser and `streamWithReconnect`'s backoff/seq-replay loop — the four trickiest pieces of logic in the module — covered only indirectly or not at all.

*Files:* `tui/internal/session/session_test.go`, `tui/internal/wizard/picker_test.go`, `tui/go.mod`

### Observations, edge cases and minor notes (22)

- `tui/go.mod:4` — go.mod's header comment is factually wrong and has been for a while: it claims "this module was authored in an environment without a Go toolchain, so it has NOT been compiled or `go mod tidy`'d". I ran `go build ./...` (exit 0), `go test ./...` (all packages ok) and `go mod tidy -diff` (no diff) on Go 1.26.5. go.sum exists at 3881 bytes. The comment should be deleted; it actively misleads a reader into distrusting a working build.
- `tui/go.mod:3` — No `toolchain` directive and `go 1.22` while the local toolchain is 1.26.5. Nothing pins the build. Also no vendor/ directory, so a build requires network access to the module proxy — worth deciding deliberately before publish.
- `tui/internal/ui/list.go:18` — Version skew: `ui.Version = "0.2.0"` is what the header bar, the setup card and the /settings Status tab all print, but package.json says "version": "0.0.1". Two hand-maintained numbers for one product; the header comment even argues the version matters for bug-report screenshots, which makes the skew worse.
- `tui/internal/theme/theme.go:136` — `theme.Next()` has no production caller. `grep -rn theme.Next` across the module returns nothing — ctrl+t now opens the swatch picker (session.go:360-362) instead of cycling. The function survives only because theme_test.go:24-42 tests it, and that test's comment still claims "the ctrl+t contract". Dead code kept alive by its own test.
- `tui/internal/wizard/picker.go:3` — The picker's package doc refers to "Model (the first-run onboarding wizard)" as a sibling type. It does not exist — `internal/wizard/` contains only picker.go, chrome.go and picker_test.go, and `grep -rn "type Model" internal/wizard/` returns nothing. Stale reference to a deleted type.
- `tui/internal/session/output.go:43` — `output.outputKey` lists `ctrl+c` as a close key, but `onKey` intercepts ctrl+c at line 269 before any popup handler runs, so that branch is unreachable. The comment at session.go:268 claiming "ctrl+c is the escape hatch from any popup" is also wrong — ctrl+c arms/quits the whole app, it never closes a popup.
- `tui/internal/session/view.go:532` — `m.status` has no TTL and is never cleared. Once something like "unknown command: /foo" lands there it stays in the footer for the rest of the session until some other code path overwrites it — including across a completed run, so a stale error can sit under a green session indefinitely.
- `tui/internal/session/carousel.go:134` — `carouselKey`'s printable-character test is `len([]rune(s)) == 1 || s == " "`. The second clause is dead: a space key's `String()` is already the single rune " ", so `len([]rune(s)) == 1` covers it.
- `tui/internal/session/settings.go:405` — `detectUser()` runs `exec.Command("git", "config", "user.name")` at package-variable initialisation time, i.e. before `main()` and inside every `go test` binary for the session package. It's a subprocess spawn on import for a cosmetic greeting. The `ponytail:` comment defends caching it, which is right, but init-time is heavier than lazily on first greeting.
- `tui/internal/session/settings.go:22` — `const version = ui.Version` is a redundant alias — settings.go is the only file that does this, while view.go:202 and chrome.go:58 use `ui.Version` directly. Three files, two spellings.
- `tui/internal/session/settings.go:369` — `pad()` and `padLeft()` measure with `len(s)` (bytes), not display cells, unlike the ANSI-aware `padVis()` two files over. Currently safe because every caller passes ASCII labels and `fmtTok` output, but it's a latent trap if a label ever gains a glyph.
- `tui/internal/session/carousel.go:55` — `fetchSwitchableModels` fans out `client.Models(provider)` serially, one blocking 30s-timeout HTTP call per credentialed provider (carousel.go:54-62). With eight providers stored the ctrl+p carousel can sit on "loading models…" for minutes with no cancel path and no progress. The calls are independent and could run concurrently.
- `tui/internal/api/client.go:177` — `api.Client.do` uses a single 30s `http.Client.Timeout` for everything including `POST /commands/<name>`. A slash command that legitimately takes longer (e.g. an export over a large history) will fail client-side while the server keeps running it, and the user sees "/export failed: context deadline exceeded".
- `tui/internal/session/session.go:492` — `/graph` and `/dashboard` put the bearer token in the URL query string handed to the OS browser, so it lands in browser history and in any referrer. The server's own dashboard does the same, so this is a consistent design choice rather than a TUI slip, but it's worth a conscious decision before publish.
- `tui/cmd/amux/main.go:109` — `streamWithReconnect` reads `fromSeq` as the argument to `client.StreamEvents` at line 109 while the forwarder goroutine spawned at line 97 writes it. In practice ordering saves it — nothing can be sent on `tap` until `StreamEvents` starts, and `<-forwardDone` at line 111 provides a happens-before edge for the next iteration — but there is no explicit synchronisation, so this is fragile to any future change that pre-fills `tap`.
- `tui/internal/session/session.go:199` — `m.input.Width = msg.Width - 4` goes negative on a terminal narrower than 4 columns. I tested `View()` down to 1x1 and it does not panic (bubbles clamps internally), but the assignment is unguarded and every other size computation in this codebase is wrapped in `max`/`clamp`.
- `tui/internal/session/view.go:85` — `agentBlock` appends `st.pending` to a copy of `st.log` on every frame (`append(append([]string{}, body...), st.pending)`) — a fresh 60-element slice allocation per agent per frame while any agent is mid-stream, which is exactly when frames are most frequent.
- `tui/internal/session/stats.go:46` — `heatmap`'s week count is `clamp(w-labelW-1, 8, 53)` with a floor of 8, so on a terminal narrower than ~13 columns the grid is wider than the pane. The settings overlay has `Width(w).Height(h).MaxHeight(h)` but no `MaxWidth(w)` (settings.go:111), so nothing clips it there. I measured no actual overflow at 20x20 and above, but the floor + missing MaxWidth combination is unguarded rather than proven safe.
- `tui/internal/session/stats.go:296` — `bookQuip` returns "" below 416k tokens, and settStatsOverview appends it unconditionally as a line — so the Stats overview always carries a trailing blank row for new users. Harmless, but it's a magic constant (416_000, "~320k words · ~1.3 tokens/word") driving visible copy.
- `tui/go.mod:16` — `github.com/muesli/termenv v0.15.2` sits in the non-indirect require block but is imported only by popup_test.go:12. Correct as far as go.mod semantics go, just worth knowing it's a test-only direct dependency.
- `tui/internal/api/client.go:203` — `api.Client.do` swallows the body-decode error when a 4xx/5xx response isn't JSON (`json.NewDecoder(resp.Body).Decode(&e)` with no error check, line 203) and falls back to `resp.Status`. Fine behaviour, but the unchecked Decode reads as an oversight rather than a decision.
- `tui/internal/session/session.go:526` — `Model.apply` handles event kinds session/agent_event/orchestration/agent_message/usage/approval_request. The server publishes `{kind:"theme"}` too (src/server/server.ts:253) — the TUI silently ignores it, so a theme change made from the web dashboard does not reach a running TUI even though the reverse direction works.


---

## 8. Distribution — what shipping this to NPM actually involves

### There is no shippable artifact today: the package declares one bin, and it points at raw TypeScript

package.json lines 7-9 declare exactly one bin entry: `"amux-core": "./src/cli.ts"`. src/cli.ts line 1 is `#!/usr/bin/env bun`. I installed the packed tarball into a throwaway project (`npm i /tmp/.../amux-0.0.1.tgz`, exit 0, 148 packages) and npm created `node_modules/.bin/amux-core -> ../amux/src/cli.ts` — a symlink straight to the .ts source. With bun on PATH it actually runs (`amux: no agents configured. Run 'amux-core init' …`). With `env PATH=/usr/bin:/bin` it produces `env: bun: No such file or directory`. So the bin works only as a bun-shebang script; Node never enters the picture. There is no build step between `src/` and the published bin, no `prepublishOnly`, no `dist/`.

*Files:* `package.json`, `src/cli.ts`

### The 'compiled single binary' distribution path is architecturally dead, not merely stale

`bun run build` = `bun build --compile ./src/cli.ts --outfile amux-core` (package.json:13). I ran a fresh compile (bundle 704 modules, 290ms, exit 0, 64,652,432 bytes) and it crashes identically to the committed `./amux-core` — from the repo root and from an empty foreign dir alike, exit 1: `error: Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/darwin-arm64: ResolveMessage: Cannot find module './prebuilds/darwin-arm64//pty.node' from 'node_modules/@napi-rs/keyring/index.js'` at `/$bunfs/root/amux-core:34547`. I isolated the cause with two one-import probe binaries: a `@napi-rs/keyring`-only compile runs clean (`keyring ok function`, exit 0); a `node-pty`-only compile dies with the same loader error (exit 1). node-pty's `.node` addon is the sole blocker to `bun --compile`, and because src/cli.ts:27 imports `serveMain` from `./server/main.ts`, which pulls in `src/server/server.ts:4 import * as pty from "node-pty"` at module scope, *every* amux-core subcommand loads it — including `amux-core "say hi"`.

*Files:* `package.json`, `src/server/server.ts`, `src/cli.ts`

### Runtime is Bun-locked at five distinct API surfaces — a Node install can never work without a rewrite

Exhaustive grep of src/ (excluding *.test.ts) for `Bun.`/`bun:` yields exactly these non-negotiable Bun dependencies: `bun:sqlite` at src/store/db.ts:1 (`import { Database } from "bun:sqlite"`) and src/store/session-store.ts:2 (type-only); `Bun.serve<TerminalSocketData>` at src/server/server.ts:127 (the entire HTTP+SSE+WebSocket server, including `server.upgrade()` at :160); `new Bun.Glob(...).match(...)` at src/approval.ts:38 and src/permissions.ts:47 (the permission engine); `Bun.spawn([cmd, url], …)` at src/cli.ts:272 (browser open). `scripts/gen-catalog.ts:126` also uses `Bun.write`. Everything else is `node:`-prefixed stdlib (37 import sites across fs/path/child_process/crypto/events/os/url), so the port surface is small but the four runtime items are load-bearing: sqlite persistence, the server, the permission matcher, and the browser opener.

*Files:* `src/store/db.ts`, `src/server/server.ts`, `src/approval.ts`, `src/permissions.ts`, `src/cli.ts`

### The tarball is assembled by .gitignore fallback, which inverts what should ship

`npm pack --dry-run` emits `npm warn gitignore-fallback No .npmignore file found, using .gitignore for file exclusion.` There is no `files` field in package.json and no .npmignore. Result: 135 files, 268.8 kB packed / 860.6 kB unpacked. By directory: src 77 files (including every *.test.ts), tui 24 (Go source + go.mod + palettes.json + *_test.go), old-tech 13 (the dead Ink TUI, ~47 kB), web 11 (including web/*.test.ts), scripts 2, plus README.md (16.2 kB), project_context.md (21.8 kB), bun.lock (39.3 kB), LICENSE, tsconfig.json, and two dot-dirs — `.amux/agents.yaml` (the maintainer's own roster) and `.claude/settings.local.json`. Meanwhile the two things a user actually needs — `./amux` (10,874,738 B, Mach-O arm64) and `./amux-core` (64,652,432 B, Mach-O arm64) — are in .gitignore lines 2-3 and therefore excluded. The package ships the source of everything and the executable of nothing.

*Files:* `package.json`, `.gitignore`

### Two front ends, two incompatible bootstrap models, and only one of them is even a candidate for npm

README.md lines 13-20 describe `amux` (Go TUI) as the primary front end and `amux-core` as what it spawns. tui/cmd/amux/main.go:49-51 is the actual coupling: `entry := envOr("AMUX_CORE_ENTRY", "src/server/main.ts")`, `bunBin := envOr("AMUX_BUN", "bun")`, `cmd := exec.Command(bunBin, "run", entry)`. It never invokes the compiled `amux-core` binary — it shells out to `bun run` on a **cwd-relative TypeScript path**. Running `amux` from /tmp/amux-probe-pkg produced exit 1 with `error: Module not found "src/server/main.ts"` then `amux: core did not hand shake: EOF` (main.go:64). The Go TUI is therefore only runnable from inside a checkout that has both bun and node_modules — it is not distributable via this npm package at all, and npm has no mechanism to ship a Go binary from a `dependencies`-only package anyway.

*Files:* `tui/cmd/amux/main.go`, `README.md`

### Asset resolution is import.meta.url-relative and only two of the three paths survive an npm install

src/server/server.ts resolves three asset roots off `import.meta.url`: line 53 `const webDir = opts.webDir ?? new URL("../../web", import.meta.url).pathname`, line 75 `const nodeModulesDir = new URL("../../node_modules", import.meta.url).pathname`, line 88 `const palettesFile = new URL("../../tui/internal/theme/palettes.json", import.meta.url).pathname`. From `<root>/node_modules/amux/src/server/server.ts` these become `<root>/node_modules/amux/{web,node_modules,tui/…}`. I booted the installed copy for real (handshake `{"amuxServer":{"url":"http://127.0.0.1:61736",…}}`) and curled it: `/` → 200, `/palettes.json` → 200 (works only because tui/ accidentally ships), `/xterm.js` → **404** with body `{"error":"not found"}`, because npm hoists deps to `<root>/node_modules/@xterm/*` and `node_modules/amux/node_modules` does not exist (verified: `ls: node_modules/amux/node_modules: No such file or directory`).

*Files:* `src/server/server.ts`

### The xterm/node-pty terminal subsystem has no client anywhere in the repo and is self-documented as non-functional

`VENDOR_FILES` (src/server/server.ts:20-24) serves `/xterm.js`, `/xterm.css`, `/xterm-addon-fit.js`, and route `/terminal/ws` (:159) upgrades to a WebSocket that spawns a pty (:333-350). Grepping web/, tui/, and src/ for `xterm`, `terminal/ws`, `new Terminal(`, or `FitAddon` returns **zero hits outside server.ts itself** — web/index.html, web/app.js and web/graph.js never load those scripts and nothing ever opens that socket. The handler's own comment at src/server/server.ts:332-341 says: "KNOWN BLOCKER (confirmed by direct testing, not theoretical): a node-pty child spawned in any process where Bun.serve() is running gets killed (SIGHUP, or exits immediately) within single-digit milliseconds … This code is therefore not yet functional end-to-end under Bun." So three of the ten runtime dependencies (node-pty, @xterm/xterm, @xterm/addon-fit) plus the entire `postinstall` script exist to support a feature with no caller that does not work.

*Files:* `src/server/server.ts`, `web/index.html`, `web/app.js`

### The postinstall hook is a hard Bun dependency in the one lifecycle phase npm controls

package.json:19 — `"postinstall": "bun run scripts/fix-pty-perms.ts"`. scripts/fix-pty-perms.ts:6 imports `{ Glob } from "bun"` and line 8 scans `node_modules/node-pty/prebuilds/*/spawn-helper` relative to cwd, chmod 0755. Run under a bun-less PATH it exits **127** (`bash: bun: command not found`). npm runs postinstall in the *installing project's* directory tree, so even with bun present the cwd-relative glob targets the consumer's node_modules — which for a hoisted install is `<root>/node_modules/node-pty`, one level up from where the script assumes. In my install npm 11.17.0 deferred it entirely (`npm warn allow-scripts amux@0.0.1 (postinstall: bun run scripts/fix-pty-perms.ts)`), so it silently never ran.

*Files:* `scripts/fix-pty-perms.ts`, `package.json`

### Two native modules with opposite packaging strategies and opposite risk profiles

`@napi-rs/keyring@1.3.0` (src/keystore/keystore.ts:1) uses the modern napi optionalDependencies pattern — 12 per-platform packages listed in its package.json optionalDependencies (darwin-arm64/x64, linux gnu/musl arm64/x64/arm/riscv64, win32 x64/arm64/ia32, freebsd-x64); npm picks the right one, no compiler needed, and it survives `bun --compile`. `node-pty@1.1.0` ships prebuilds inside the package (`node_modules/node-pty/prebuilds/{darwin-arm64,darwin-x64,win32-arm64,win32-x64}` — note: **no linux prebuilds**) and its install script is `node scripts/prebuild.js || node-gyp rebuild`, i.e. any Linux consumer falls through to a node-gyp compile requiring python3 + a C++ toolchain. That is the single largest install-failure surface in the dependency set, and it exists for the dead terminal feature.

*Files:* `src/keystore/keystore.ts`, `src/server/server.ts`

### Every one of the ten declared dependencies is genuinely imported — the weight problem is not unused packages

Exact import sites: @anthropic-ai/sdk → src/providers/anthropic.ts:1; @google/genai → src/providers/gemini.ts:1; @modelcontextprotocol/sdk → src/mcp/mcp.ts:1-2 (client/index.js, client/stdio.js); @napi-rs/keyring → src/keystore/keystore.ts:1; node-pty → src/server/server.ts:4-5; openai → src/providers/openai.ts:1; yaml → src/config/config.ts:3, src/commands/registry.ts:3, src/skills/skills.ts:3; zod → src/orchestrator/planner.ts:1 (RawTask/RawPlan/RawRemediation schemas at :26-34 and :184-191). @xterm/xterm and @xterm/addon-fit are never `import`ed — they are read off disk by path in src/server/server.ts:21-23. So there is no unused-dependency cleanup available; the reduction available is *feature* deletion (node-pty + both @xterm packages) worth 148 installed packages down to roughly 145 and, more importantly, the removal of the only compile-from-source dependency.

*Files:* `src/providers/anthropic.ts`, `src/providers/openai.ts`, `src/orchestrator/planner.ts`, `src/server/server.ts`

### Config discovery is cwd-relative by design, which is correct for a per-project tool but has no project-root search

src/config/config.ts defaults every loader to a bare relative path: `loadAgents(path = ".amux/agents.yaml")` (:11), `loadOptions(path = ".amux/agents.yaml")` (:37), and likewise loadPermissions/:69, loadLspServers/:80, loadMcpServers/:93. src/server/main.ts:24 gates on `existsSync(".amux/agents.yaml")`. src/store/db.ts:5 `export const DEFAULT_DB = ".amux/amux.db"`. Engine root is `opts.root ?? process.cwd()` (src/engine.ts:73), mirrored in src/agent/agent.ts:141, src/tools/tools.ts:49, src/lsp/registry.ts:25, src/lsp/client.ts:80. This is the right shape for a global install (state follows the project, not the binary), and the failure mode is friendly — from an empty /tmp dir the source CLI printed `amux: no agents configured. Run 'amux-core init' to set up providers and roles.` and exited 1. What is missing is any walk-up-to-git-root behaviour, so invoking amux from a subdirectory of a configured project silently starts a fresh unconfigured session.

*Files:* `src/config/config.ts`, `src/engine.ts`, `src/server/main.ts`

### Credentials live outside the package, correctly — this part is publish-safe

src/auth/auth-store.ts:15-17 resolves `process.env.AMUX_AUTH_FILE || join(homedir(), ".config", "amux", "auth.json")` — global, home-relative, env-overridable, chmod'd (chmodSync imported at :3, rmSync at :77). src/keystore/keystore.ts uses the OS keychain via `new Entry("amux", provider)` with a documented env-var fallback (`envKey`) for headless CI. Nothing credential-bearing is cwd-relative and nothing secret appears in the tarball: I read the shipped `.amux/agents.yaml` (14 lines: one google/gemini-flash-latest agent, `theme: neon graveyard`) and `.claude/settings.local.json` (3 MCP tool allowlist entries) — embarrassing to ship, but not a secret leak.

*Files:* `src/auth/auth-store.ts`, `src/keystore/keystore.ts`, `.amux/agents.yaml`

### The npm `private` guard moved into the workspace branch in npm 11, so --dry-run gives a false green

`npm publish --dry-run` in this repo exits **0** and prints `+ amux@0.0.1` after listing 136 files — it does *not* refuse. Reading /opt/homebrew/lib/node_modules/npm/lib/commands/publish.js:153, the local guard is `if (workspace && manifest.private)` — gated on the workspace path, which a plain `npm publish .` never takes. The real enforcement is one layer down in /opt/homebrew/lib/node_modules/npm/node_modules/libnpmpublish/lib/publish.js:15 (`if (manifest.private) throw … EPRIVATE`), which is only reached on a non-dry-run publish. So `private: true` at package.json:4 *does* block a real publish, but the standard pre-flight check reports success — exactly the trap that produces a surprise failure in a release script.

*Files:* `package.json`

### The CLI's own argument parsing has no --help or --version and misnames itself in error text

src/cli.ts:33 is `const args = process.argv.slice(2)` followed by a chain of top-level `if (args[0] === …)` blocks (keys/:40, login/:51, auth/:61, serve/:82, --web/:97, init/:115) with no flag parser. `bun run src/cli.ts --help` falls through to the usage banner (`amux-core: no task given.` + 4 lines) and exits **0**; bare `bun run src/cli.ts` also exits 0. There is no `--version`. Naming is inconsistent across the surface: the banner and cli.ts:1-15 header say `amux-core`, but src/server/main.ts's missing-key error says `Run: amux auth login` — a command that does not exist under either binary name.

*Files:* `src/cli.ts`, `src/server/main.ts`

### README documents a git-clone workflow exclusively — there is no published-install story to be inconsistent with yet

README.md:24-40 ("Quickstart") says `Requires Bun ≥ 1.3 and Go ≥ 1.22`, then `bun install` / `bun run build:tui` / `./amux`, and for scripting `bun run src/cli.ts …`. Grepping the whole README for npm/npx/bunx returns only line 190 (`bunx tsc --noEmit` in a dev section). No `npm i -g`, no `npx amux`. That is at least honest, but it means shipping to npm requires writing the install story from scratch, and every command string in README, in cli.ts's header comment, and in the Go TUI's error messages currently assumes a checkout.

*Files:* `README.md`

### Observations, edge cases and minor notes (20)

- `package.json:2` — `npm view amux` returns a real package: amux@0.0.0, MIT, deps: none, unpackedSize 273 B, maintainer donavon <github@donavon.com>, published over a year ago. The name is squatted by a 273-byte placeholder. `npm view amux-core` returns E404 — that name is free.
- `package.json:21` — package.json has no `files`, `repository`, `homepage`, `bugs`, `keywords`, `author`, `publishConfig`, `os`, or `cpu`. `engines` (line 21-23) declares only `bun: >=1.3.0` — there is no `node` key, so npm has nothing to check and a Node-only user gets no engine warning before the install breaks.
- `package.json:24` — LICENSE says `Copyright (c) 2026 Shubhadeep Datta` and package.json declares `"license": "MIT"`, but there is no `author` field, so the npm page would show no owner.
- `bun.lock:1` — bun.lock (39,278 B) ships in the tarball. There is no package-lock.json anywhere in the repo — a Node consumer's `npm ci` story does not exist.
- `scripts/fix-pty-perms.ts:8` — `npm i` of the tarball on npm 11.17.0 deferred all four install scripts: `npm warn allow-scripts   amux@0.0.1 (postinstall: bun run scripts/fix-pty-perms.ts)`, plus @google/genai preinstall, node-pty install+postinstall, protobufjs postinstall. On npm ≥11 the pty permission fix silently never runs, so the bug fix-pty-perms.ts exists to work around comes back.
- `package.json:32` — node-pty's prebuilds directory contains only darwin-arm64, darwin-x64, win32-arm64, win32-x64 — no Linux. Every Linux install falls through to `node-gyp rebuild`.
- `package.json:13` — The committed `./amux-core` (Aug 3 10:30, 64,652,432 B) and a freshly built one differ byte-for-byte (`cmp` → DIFFERENT) yet crash identically — so the committed binary is not merely stale, the build itself is broken.
- `.gitignore:2` — Both binaries are `Mach-O 64-bit executable arm64` only. There is no darwin-x64, linux-x64, linux-arm64 or win32 artifact, and no CI/release workflow in the repo to produce one.
- `.gitignore:3` — `git ls-files amux amux-core` returns 0 files — confirmed both binaries are untracked, so a `git clone` user gets no executable either and must run `bun run build:all` (which additionally needs Go ≥1.22).
- `tsconfig.json:9` — tsconfig.json sets `allowImportingTsExtensions: true` and `noEmit: true` with `types: ["bun"]` and `include: ["src"]`. Every internal import carries an explicit `.ts` extension (e.g. src/cli.ts:16-31). This compiles under bun/tsc but is not resolvable by Node's ESM loader without a rewrite or a bundler step.
- `package.json:39` — devDependencies pins `"typescript": "^7.0.2"` — the native-port TypeScript. Worth pinning exactly for a published package since 7.x is still moving.
- `.gitignore:6` — `.gitignore` excludes `.amux/session.json` and `.amux/amux.db*` but not `.amux/agents.yaml`, which is git-tracked (`git ls-files .amux` → .amux/agents.yaml) and therefore lands in the npm tarball along with `.claude/settings.local.json`.
- `README.md:21` — old-tech/ink-tui/ contributes 13 files (~47 kB) to the tarball including its own package.json and tsconfig.json — a nested package.json inside a published tarball is a common source of tooling confusion.
- `scripts/gen-catalog.ts:126` — scripts/gen-catalog.ts writes to the cwd-relative literal `"src/providers/catalog.generated.ts"` via `Bun.write` and fetches https://models.dev/api.json at runtime. Dev-only, but it ships in the tarball and would silently write into a consumer's tree if invoked.
- `src/server/server.ts:4` — node-pty's own loader builds a double-slashed path in the error: `Cannot find module './prebuilds/darwin-arm64//pty.node'`. Upstream cosmetic bug, but useful as a fingerprint when searching issues.
- `src/server/main.ts:24` — src/server/main.ts's startup errors are well-worded (`amux serve: .amux/agents.yaml agent[0]: missing 'systemPrompt'`, `amux serve: no API key for 'anthropic'. Run: amux auth login (or export ANTHROPIC_API_KEY)`) — the failure UX from source is genuinely good; it is only the compiled/global paths that produce raw stack traces.
- `tui/cmd/amux/main.go:46` — The Go TUI's escape hatches exist and work: `AMUX_SERVER_URL`/`AMUX_SERVER_TOKEN` skip spawning entirely (main.go:46-47), and `AMUX_CORE_ENTRY`/`AMUX_BUN` override the hardcoded path and binary (main.go:49-50). A shipping strategy can lean on these instead of changing the handshake.
- `src/server/server.ts:76` — `serveFile` guards traversal with `normalize(rel).replace(/^(\.\.[/\\])+/, "")` then `if (!file.startsWith(webDir))` (server.ts:63-65), but `serveVendor` (:76-82) has no such guard — it is safe only because it indexes a fixed 3-entry VENDOR_FILES map. Worth a comment so nobody later makes that map dynamic.
- `src/cli.ts:33` — `bun run src/cli.ts --help` and bare `bun run src/cli.ts` both exit 0 while printing the 'no task given' banner to **stderr** (via console.error at cli.ts:35 path / the banner). Scripts checking exit codes cannot distinguish 'ran fine' from 'did nothing'.
- `scripts/gen-catalog.ts:42` — README.md:6 markets '150 more via Models.dev', but scripts/gen-catalog.ts:42-64 hard-filters to a 21-entry ALLOW_IDS set plus the three hand-maintained providers. The generated header comment in catalog.generated.ts records the real counts.

---

## 9. Cross-cutting: what the subsystem readers missed

*This section is the completeness critic's pass — it enumerated the file tree, diffed it against what the eight readers had opened, and then went and read the gaps itself.*

### The test suite is 41 files, but only 36 of them are amux — 5 are the dead Ink TUI, and they are not excluded from anything

`bun test` at the repo root runs 275 tests across 41 files. `bun test src web` runs 258 across 36. The difference is exactly `old-tech/ink-tui/{App,GraphView,ModelSelector,UsageView}.test.tsx` and `theme.test.ts` — 17 tests, 5 files. Both `old-tech/ink-tui/README.md` lines 9-11 ("It is excluded from the root project's `tsc --noEmit`/`bun test`") and `project_context.md`'s two-front-ends section ("Has its own package.json/tsconfig.json so it doesn't affect the root project's deps or tsc/bun test") assert this exclusion. Half of it is true: root `tsconfig.json` has `"include": ["src"]`, so `tsc --noEmit` genuinely skips old-tech. The `bun test` half is false — bun's test runner does not read tsconfig `include` and globs the whole working tree. The archived TUI is a live member of the root suite.

*Files:* `old-tech/ink-tui/README.md`, `project_context.md`, `tsconfig.json`, `package.json`

### old-tech/ is not archived code — it is a compile-time dependency edge pointing back into src/

Every one of the 13 tracked files under `old-tech/ink-tui/` imports from `../../src/`: `AgentConfig` from `src/agent/agent.ts`, `Task` from `src/orchestrator/task.ts`, `ApprovalQueue`/`ApprovalRequest` from `src/approval.ts`, `LockRegistry` from `src/orchestrator/locks.ts`, `loadSkills` from `src/skills/skills.ts`, `Bus`/`AgentEvent` from `src/events/bus.ts`, `Orchestrator` from `src/orchestrator/orchestrator.ts`, `UsageTracker` from `src/usage.ts`, and `CATALOG`/`providersByCategory`/`contextWindow`/`Category` from `src/providers/catalog.ts`. Because those test files execute under root `bun test`, renaming or reshaping any of those exports breaks the root suite from a directory the docs describe as not part of the build. Its own README even predicts this ("it will silently drift out of sync") while believing the drift would be silent — it would not be; it would be a red suite.

*Files:* `old-tech/ink-tui/App.tsx`, `old-tech/ink-tui/UsageView.test.tsx`, `old-tech/ink-tui/GraphView.test.tsx`, `old-tech/ink-tui/theme.ts`

### src/orchestrator/runner.ts holds two orchestration loops: one production, one that exists only so tests can run

`runProject` (line 60) and `resumeProject` (line 103) are the live entry points, called from `src/engine.ts:164` and `:172`. Both delegate to `schedule()` from `scheduler.ts`. Alongside them, `worker` (lines 29-47) is a flat claim→execute→complete polling loop with a 30ms sleep and a `MAX_ATTEMPTS = 3` failover retry, and `parseTaskList` (lines 13-22) is a tolerant JSON-array extractor. Line 129 is `export { worker as runWorker };` with the comment "Exposed for testing the flat concurrency/claim path without a planning call." A repo-wide grep for `parseTaskList|runWorker` outside runner.ts returns only `src/orchestrator/orchestrator.test.ts` (lines 5, 21-24, 44) and `src/orchestrator/failover.test.ts` (lines 5, 35). Neither symbol has a production caller.

*Files:* `src/orchestrator/runner.ts`, `src/orchestrator/failover.test.ts`, `src/orchestrator/orchestrator.test.ts`

### src/orchestrator/failover.test.ts is an orphan test — the only test file in the repo with no source sibling

An automated pass over `src/` and `web/` looking for a `.ts`/`.js` sibling of every `*.test.ts` returns exactly one orphan: `src/orchestrator/failover.test.ts` — there is no `failover.ts`. Its 5 tests exercise `Agent.run`'s 429/529 exhaustion classification (lines 10-18), `runWorker`'s requeue-and-cap behaviour (lines 20-41), cross-agent handover through `Orchestrator.requeue`/`claimTask` (lines 43-61), and the self-reclaim/backoff invariants (lines 63-84). Everything it asserts is real behaviour of `Orchestrator` and `Agent`, but the loop it drives — `runWorker` — is the dead flat path, which is why the DAG scheduler's failover story diverges from what the file name promises.

*Files:* `src/orchestrator/failover.test.ts`, `src/orchestrator/runner.ts`

### src/events/bus.ts is 39 lines and is the entire agent event fabric

`Bus` (lines 23-39) is a typed wrapper over one `node:events` `EventEmitter`, with `setMaxListeners(0)` in the constructor (line 28, unlimited — the comment explains this is so a slow subscriber does not trip backpressure warnings). `publish` is a bare synchronous `emitter.emit("event", e)`; `subscribe` returns an unsubscribe closure. The `EventType` union (lines 3-13) is 10 members: thought, tool_call, file_edit, delta, message, failover, warning, external_change, done, error. Note that `approval` is not among them — approvals travel a separate path — and `failover` is emitted only by the dead `runWorker`. Because `emit` is synchronous, a subscriber that throws propagates the throw back into whichever agent called `publish`; there is no try/catch anywhere in this file. `src/cli.ts:148-152` is a direct consumer, filtering `delta` and splitting `error` to stderr.

*Files:* `src/events/bus.ts`, `src/cli.ts`

### src/orchestrator/task.ts encodes the whole flat-vs-DAG duality as an optional-field widening

26 lines. `Task` (lines 3-18) carries the flat-queue fields (`attempts`, `lastFailedBy`, `availableAt` for backoff, `replans`) plus the DAG fields as optional (`role`, `dependsOn`, `handoffTo`, `acceptance`, `output`). `TaskNode` (lines 23-26) re-declares `role: string` and `dependsOn: string[]` as required. The comment on lines 20-22 states the reason plainly: "Task keeps those fields optional so the flat/legacy path and session persistence still type-check." This is why `resumeProject` (runner.ts:112-118) can backfill `node.role = t.assignedTo ?? lead.config.id` and `node.dependsOn = []` and cast a `Task` to `TaskNode` with no runtime validation — the persisted JSON board holds `Task`, the scheduler wants `TaskNode`.

*Files:* `src/orchestrator/task.ts`, `src/orchestrator/runner.ts`

### Slash commands are owned by two registries with a documented supersession, and the split is invisible from the server side

`src/commands/registry.ts` defines 19 named commands plus a synthesized `/help` (lines 296-316, injected only `if (!this.byName.has("help"))`): cancel, undo, rewind, branch, model, sessions, agents, tasks, skills, mcp, lsp, permissions, cost, status, debate, export, resume, clear, init. The Go TUI adds 7 purely client-side entries in `menuItems()` (session.go:401-411): help, graph, dashboard, settings, config, stats, theme, quit. Of those, `settingsTabFor` (settings.go:28-42) maps settings→tab 0, status→1, config→2, usage→3, stats→4 — so `/status` is intercepted client-side before ever reaching the server registry that also defines it, and `/usage` exists *only* as a settings tab, in no registry at all. session.go:470 states this outright: "This supersedes the plain-text /status and /usage the registry still offers." `m.knows(name)` at session.go:506 rejects anything else with "unknown command".

*Files:* `src/commands/registry.ts`, `tui/internal/session/session.go`, `tui/internal/session/settings.go`

### tui/internal/session/diffview.go is a full-screen approval reviewer with in-place editing, not just a yes/no bar

246 lines. When the head approval carries a `diff` (attached server-side by write_file and edit — see the header comment lines 14-18), the one-line approval bar is replaced by a full-screen pager. `approvalDiff` (30-33) reads `r.Input["diff"]`; `editedField` (36-41) picks `content` for write_file and `newString` for edit. Pressing `e` on the head request (line 134-138) opens a Bubbles `textarea` seeded with the model's proposal; `ctrl+s` (91-95) stores `m.diffv.edited` as a `map[string]any` that is then sent to `client.Approve(ok, scope, edited)` at line 162 — so the human's rewrite, not the model's, is what executes. `crudeDiff` (60-69) renders the human's change as a whole-block +/- against the model's proposal, and the comment is explicit that it cannot show the true prior file content because write_file approvals never send it to the client. `tab`/`shift+tab` (122-133) cycle a read-only preview of other pending approvals; only `idx == 0` is answerable (lines 141-145), matching the server resolving only `pending[0]`.

*Files:* `tui/internal/session/diffview.go`

### tui/internal/session/output.go is the multi-line command pager, and it routes by shape rather than by command name

98 lines. `show(title, message)` (28-38) is the single funnel for every command result: a message containing no `\n` becomes the one-line footer status; anything multi-line opens a scrollable centred box. The header comment (13-17) records the motivation — five-row answers used to be pushed into the footer and the agent feed as "five stacked lines of debris". `outputRows()` clamps the viewport to 3..24 rows (line 61), `outputMaxTop()` bounds scrolling (62), and every key branch in `outputKey` (40-59) clamps against `outputMaxTop()` at press time. `outputView` sizes the box to the widest of title/hint/content, capped at `w-6` (81), and `padRight` (93-98) fills each row so the pager renders as a solid block on the pane background.

*Files:* `tui/internal/session/output.go`

### web/avatar.js is the shared 12x12 sprite renderer behind both browser canvases

71 lines, loaded as a classic script before app.js in `web/index.html:73` and before graph.js in `web/graph.html:109`, with `AVATAR_COLORS` and `drawPixelAvatar` as deliberate globals (comment lines 7-9). One `AVATAR_BODY` grid built from a `stripe(left, mid, right)` helper (15-32) — square head, full-width ear band, four leg prongs — filled in one of six identity colors, with one of six `AVATAR_FACES` ink overlays (35-42) so each color also reads as a distinct face. Two defensive details are documented in-place: `cell` is `Math.round(size / 12)` because fractional cell sizes made anti-aliasing round rows and columns differently and the same sprite looked squashed at different sizes (47-51); and a non-finite `colorIndex` defaults to slot 0 rather than indexing `AVATAR_FACES` out of bounds, because the previous NaN throw "silently killed the whole caller's animation loop" (53-58).

*Files:* `web/avatar.js`, `web/index.html`, `web/graph.html`

### The TUI's first-thing-you-see surface is settings.go's welcome pane, and it personalizes itself by shelling out to git at package init

`welcomeView` (settings.go:324-337) is what the empty work pane renders before any task: a time-of-day greeting, `amux v<version>`, the agent count and mode, an `avatarRow` joining every teammate's avatar with `⇄` (341-352), and two hint lines pointing at the prompt and `/settings`. `settWelcome` (117-131) mirrors it inside the settings overlay so "the two read as one product". `greeting()` (387-401) buckets `time.Now().Hour()` into Late night / Morning / Afternoon / Evening. The name comes from `var userName = detectUser()` at line 405 — a package-level variable initializer that runs `exec.Command("git", "config", "user.name")` (408), takes the first whitespace field, and falls back to `$USER` then `"there"`. `version` is `ui.Version` (settings.go:22).

*Files:* `tui/internal/session/settings.go`

### The uncommitted working tree cuts the provider catalog from 161+ to 34, and the README has not followed

The staged-but-uncommitted diff adds an `ALLOW_IDS` allowlist to `scripts/gen-catalog.ts` (comment: models.dev's registry is "149+ wide and mostly small resellers/gateways … noise in a picker a new user sees on first launch"), deletes 908 lines from `src/providers/catalog.generated.ts`, rewrites the catalog-breadth test from `toBeGreaterThan(100)` to `toBeGreaterThan(20) && toBeLessThan(60)`, and updates the `catalog.ts:33` comment from "161+ providers" to "a curated slice of models.dev". Loading the live catalog confirms the result: 34 providers, 181 models. `custom` remains the escape hatch for anything trimmed.

*Files:* `scripts/gen-catalog.ts`, `src/providers/catalog.ts`, `src/providers/catalog.test.ts`, `src/providers/catalog.generated.ts`

### What git actually tracks, and the two artefacts that are conspicuous by their status

`.gitignore` is 10 lines: `node_modules/`, `amux`, `amux-core`, `*.log`, `.DS_Store`, `.amux/session.json`, `.amux/amux.db*`, `.amux/reports/`, `.env`, `.env.*`. `git ls-files .amux/` returns exactly one path: `.amux/agents.yaml` — the maintainer's live team config is a tracked, shipped file. `git ls-files tui/` returns 24 paths and `tui/cmd/amux/main.go` is not among them, because the bare pattern `amux` on line 2 matches the *directory* `tui/cmd/amux/`. Root also carries `LICENSE` (MIT, "Copyright (c) 2026 Shubhadeep Datta"), `project_context.md` (21,752 bytes, referenced twice from README), and the two gitignored 10.8MB/64MB binaries. There is no `.github/` directory anywhere in the repo.

*Files:* `.gitignore`, `LICENSE`, `package.json`

### Browser launching is implemented twice with different Windows correctness

`tui/internal/session/browser.go` (28 lines) switches on `runtime.GOOS`: `open` on darwin, `cmd /c start "" url` on windows — the empty string is the title argument that `start` requires when the URL is quoted — and `xdg-open` otherwise. It wraps launch failure in a descriptive error and reaps the launcher in a goroutine (`go func() { _ = cmd.Wait() }()`, line 26) so it does not linger as a zombie. `src/cli.ts:269-276` implements the same function with a bare `start` as the executable name and swallows all errors. Callers: session.go:494 for `/graph` and :501 for `/dashboard` on the Go side; cli.ts:104 for `--web`.

*Files:* `tui/internal/session/browser.go`, `src/cli.ts`

### scripts/fix-pty-perms.ts is 10 lines of documented workaround for a Bun extraction bug

The postinstall hook globs `node_modules/node-pty/prebuilds/*/spawn-helper` relative to `.` and chmods each to 0o755. The comment (lines 1-4) records the exact diagnosis: node-pty@1.1.0's darwin-arm64/darwin-x64 prebuilds land as `-rw-r--r--` after bun's package extraction, "which makes posix_spawnp fail at runtime with no other symptom". It is a no-op on win32, which uses conpty. It uses `Glob` from `bun` and `chmodSync` from `node:fs` — a hard Bun-runtime dependency in the one lifecycle phase a package manager controls.

*Files:* `scripts/fix-pty-perms.ts`, `package.json`

### Observations, edge cases and minor notes (21)

- `src` — 14 non-test modules under src/ have no `.test.ts` sibling: cli.ts, events/bus.ts, lsp/fake-server.ts, lsp/registry.ts, orchestrator/runner.ts, orchestrator/task.ts, providers/anthropic.ts, providers/catalog.generated.ts, providers/factory.ts, providers/openai.ts, server/events.ts, server/main.ts, store/session-store.ts, tools/lsp-tools.ts. Two of those — providers/anthropic.ts and providers/openai.ts — are the transport for every non-Gemini model amux can talk to.
- `tui/internal/api/client.go` — tui/internal/api/client.go and tui/internal/ui/list.go have no `_test.go` sibling; every other package under tui/internal/ has at least one. api/client.go is the entire HTTP+SSE seam between the two processes.
- `.amux/reports/2026-08-02T19-36-29-649Z.md` — `.amux/reports/` currently contains one generated `/export` artefact, `2026-08-02T19-36-29-649Z.md` (3,726 bytes). It is gitignored as of commit f8d854c, so this is correctly untracked — but the directory name is hard-coded nowhere in .gitignore's sibling docs, so a rename of the export path silently re-exposes it.
- `README.md:152` — README.md line 152's slash-command list omits eight commands that exist in the registry: /rewind, /branch, /skills, /debate, /export, /settings, /config, /stats. A reader of the README will not discover /export at all, despite it being one of the more substantial commands.
- `tui/internal/session/settings.go:369` — `pad(s, n)` in settings.go uses `len(s)` (bytes) where every neighbouring helper uses `lipgloss.Width`. Every current caller passes an ASCII literal label, so this is latent rather than broken — but `kv`'s 16-column label gutter will misalign the moment a label carries a non-ASCII character.
- `src/events/bus.ts:32` — `Bus.publish` (bus.ts:32) is a bare synchronous `emitter.emit`. There is no try/catch in the file, so subscriber exceptions surface inside whichever agent published — the mechanism behind the separately-reported 'a throwing event subscriber aborts the entire run'.
- `src/events/bus.ts:9` — `EventType` declares `failover` (bus.ts:9) but the only `type: "failover"` publisher in src/ is runner.ts:42, inside the dead `worker` loop. The Go TUI renders a `failover` case at session.go:619 that production can never reach.
- `web/index.html:74` — `web/index.html` loads theme.js *after* app.js (lines 74-75), and graph.html does the same (110-111). Both are classic non-deferred scripts, so any top-level theme global read during app.js/graph.js parse would be undefined. It happens to work today because the reads are inside functions, but the ordering is backwards from the dependency direction — avatar.js, which app.js does depend on, is correctly loaded first.
- `bun.lock` — `bun.lock` is 39,278 bytes and contains zero occurrences of the strings 'react' or 'ink'. `node_modules/` on the maintainer's machine contains ink@7.1.1, react@19.2.8, ink-testing-library, ink-text-input and auto-bind — five packages installed but unlocked and undeclared.
- `old-tech/ink-tui/package.json` — `old-tech/ink-tui/package.json` declares its own dependencies (ink ^7.1.1, react ^19.2.8, chalk ^5.3.0, ink-text-input, ink-testing-library) but there is no `old-tech/ink-tui/node_modules` directory and no workspaces field in the root package.json, so nothing ever installs them into the location its own README tells you to install them from.
- `tui/internal/session/session.go:492` — The `/graph` handler in session.go opens the browser at `BaseURL + "/graph/view?token="` — i.e. the token is placed in a URL that lands in browser history and any referer header. Same for `/dashboard` at line 499 and for cli.ts:102's `--web` URL.
- `tui/internal/session/session.go:352` — `helpLines()` ends with a hardcoded key hint line: 'keys — tab: usage · shift+tab: plan mode · ctrl+p: models · ctrl+t: theme'. `tab` in fact toggles `m.view` between the string literals "panes" and "usage" via a map lookup at session.go:352 — the only place those two view names are enumerated, and a lookup miss silently yields the empty string.
- `tui/internal/session/diffview.go:55` — `crudeDiff`'s header comment states it deliberately mirrors `src/tools/tools.ts`'s editDiff/writeFileDiff format by hand. Two independent implementations of one diff format across a language boundary, with no shared fixture test on either side.
- `tui/internal/session/diffview.go:211` — `m.diffv.edited` is not cleared when `tab` moves the preview to a different pending approval (diffview.go:122-127 only resets `top` and `idx`), so the `m.diffv.edited != nil` branch at line 211 renders a diff of approval N's seed against approval 0's edited text.
- `tsconfig.json` — `tsconfig.json` sets `"types": ["bun"]` and `"include": ["src"]` — so `web/*.test.ts` (four browser-script test suites that DO run under bun test) are never typechecked, and neither is `scripts/gen-catalog.ts` or `scripts/fix-pty-perms.ts`.
- `package.json` — `package.json` declares `"license": "MIT"` and the LICENSE file names 'Shubhadeep Datta', but package.json has no `author` field, no `repository`, no `bugs`, no `homepage`, and no `keywords`.
- `.claude/settings.local.json` — `.claude/settings.local.json` is tracked in git and contains the maintainer's local MCP permission allowlist and `enabledMcpjsonServers: ["code-review-graph"]` — a per-developer tool config committed to the shared repo.
- `project_context.md` — `README.md:184` calls the intentional-ceiling list 'deliberate, not gaps' and points at project_context.md for the full list. project_context.md is 21,752 bytes and is the only place several of those ceilings are written down; it is a tracked root file with no `files` field to exclude it from a tarball.
- `src/orchestrator/runner.ts:35` — `runner.ts:35` carries a `ponytail:` debt marker — 'naive poll wait, fine for a handful of agents' — on a 30ms sleep inside the dead `worker` loop. Tracked technical debt on unreachable code.
- `tui/internal/session/settings.go:176` — `settings.go:176` carries a second `ponytail:` marker ('no fake switches — a config row for a value nothing reads is just decoration') and `settings.go:404` a third ('computed at package load, not per-frame'). These are the only three ponytail markers found across the files reviewed here.
- `src/orchestrator/task.ts:9` — `Task.availableAt` and `Task.lastFailedBy` (task.ts:9-10) exist solely to serve `Orchestrator.claimTask`'s backoff/self-reclaim logic, which is only driven by the dead `worker` loop and its tests. The DAG scheduler path does not consult them.

---

# Appendices

## A. Complete surface inventory

### `amux-core` subcommands (all of them)

Parsed by hand in `src/cli.ts` as a chain of non-exclusive top-level `if` blocks — there is no
dispatcher, no `--help`, and no `--version`.

| Invocation | Effect | Notes |
| --- | --- | --- |
| `amux-core "<task>"` | one-shot headless run, plain-text progress, exit | **always `exit 0`**, even if every task failed |
| `amux-core resume` | re-run unfinished tasks with stored history | |
| `amux-core init` | interactive setup wizard | plain `prompt()`, keys echoed |
| `amux-core serve [--port=N]` | start the core server | dead in the TUI flow; the TUI runs `src/server/main.ts` instead |
| `amux-core --web ["<task>"]` | server + open the browser dashboard | silently forces `interactive:false`; ignores `--auto`/`--worktree`/`--port=` |
| `amux-core auth login\|list\|logout <p>` | credential management | |
| `amux-core keys set <provider>` | legacy BYOK key store | no catalog validation on `<provider>` |
| `amux-core login copilot` | GitHub device flow | |
| *(anything else)* | **submitted to a paid model as task text** | a typo'd subcommand is a billable run |

Flags: `--auto`, `--worktree`, `--web`, `--port=N`. Unknown flags are silently discarded, never
rejected. `--port 3000` (space form) is silently ignored.

### HTTP routes (25)

Public, no token: `/health`, `/`, `/dashboard`, `/dashboard/*`, `/app.js`, `/style.css`,
`/theme.js`, `/avatar.js`, `/graph.js`, `/graph/view`, `/palettes.json`, `/xterm.js`,
`/xterm.css`, `/xterm-addon-fit.js`.

Token-gated: `GET /events` (SSE), `GET /terminal/ws` (WebSocket pty — non-functional),
`POST /session`, `POST /prompt`, `POST /cancel`, `POST /undo`, `GET /commands`,
`POST /commands/<name>`, `GET /graph`, `GET /stats`, `GET /sessions`, `GET|POST /agents`,
`POST /theme`, `GET /providers`, `GET /models`, `POST /model`, `GET|POST|DELETE /auth`,
`GET /worktree`, `POST /worktree/merge`, `POST /agents/<id>/message`, `POST /approval`.

### Slash commands (21)

`/cancel /undo /rewind /branch /model /sessions /agents /tasks /skills /mcp /lsp /permissions
/cost /status /debate /export /resume /clear /init /help /usage` — plus user-defined commands from
`.amux/commands/*.md`, which override same-named builtins.

The README documents `/graph` and `/panes`, which no longer exist, and omits eight that do
(`/rewind`, `/branch`, `/debate`, `/export`, `/skills`, `/status`, `/stats`, `/dashboard`).

### Agent tools

Sandbox: `read_file`, `write_file`, `edit`, `shell`. Coordination: `send_message`, `ask_agent`,
`spawn_fork`. LSP: `diagnostics`, `hover`. Plus every MCP server's tools, namespaced
`mcp__<server>__<tool>`.

---

## B. Test coverage

**41 Bun test files, 275 tests, 3,225 assertions** — plus 7 Go `_test.go` files across 4 packages.
Density is high in the orchestration core (`scheduler.test.ts` alone is 367 lines).

**14 `src/` modules have no test sibling.** The two that matter most are marked:

| Module | Note |
| --- | --- |
| `src/providers/openai.ts` | **the transport for every non-Gemini, non-Anthropic model** |
| `src/providers/anthropic.ts` | **the transport for all Anthropic + compatible endpoints** |
| `src/orchestrator/runner.ts` | the production entry into the scheduler |
| `src/store/session-store.ts` | 297 lines; exercised only indirectly via `db.test.ts` |
| `src/server/main.ts` | the real production bootstrap the TUI spawns |
| `src/server/events.ts` | the SSE hub and its 2,000-event replay ring |
| `src/cli.ts` | the entire CLI argument surface |
| `src/events/bus.ts`, `src/lsp/registry.ts`, `src/lsp/fake-server.ts`, `src/tools/lsp-tools.ts`, `src/providers/factory.ts`, `src/providers/catalog.generated.ts`, `src/orchestrator/task.ts` | |

There is **no CI of any kind** — no GitHub Actions workflow, no pipeline, no pre-commit hook — for
a repository with three toolchains whose suite is currently red on a clean checkout.

---

## C. Dependency census

All ten runtime dependencies are imported somewhere; none is unreferenced. But four exist solely
for the one feature the code documents as broken.

| Dependency | Files | Verdict |
| --- | --- | --- |
| `yaml` | 17 | core — config, skills, commands, frontmatter |
| `openai` | 16 | core — the OpenAI-compatible transport for most providers |
| `@google/genai` | 3 | core — Gemini, the current default |
| `@anthropic-ai/sdk` | 1 | core |
| `@modelcontextprotocol/sdk` | 1 | core — MCP |
| `zod` | 2 | core |
| `@napi-rs/keyring` | 2 | core — OS keychain; **native module, blocks `--compile`** |
| `node-pty` | 2 | **only** `/terminal/ws`; native module; **the sole cause of the compiled binary's crash** |
| `@xterm/xterm` | 1 | **only** the browser terminal |
| `@xterm/addon-fit` | 1 | **only** the browser terminal |

Dev: `typescript@^7.0.2`, `@types/bun`. Go: 3 direct Charm deps + 13 indirect, `go 1.22`, no
`toolchain` directive, no vendoring.

**Phantom dependencies:** `ink` and `react` are present in `node_modules/` and imported by 5 test
files under `old-tech/ink-tui/`, but appear in neither `package.json` nor `bun.lock`.

---

## D. The uncommitted working tree

Five files are modified and uncommitted at audit time. This is not incidental — it is an
unfinished, materially breaking change sitting in the tree immediately before a publish.

```
 .amux/agents.yaml                  |  21 +-
 scripts/gen-catalog.ts             |  34 +-
 src/providers/catalog.generated.ts | 908 +------------------------------------
 src/providers/catalog.test.ts      |   5 +-
 src/providers/catalog.ts           |   2 +-
 5 files changed, 46 insertions(+), 924 deletions(-)
```

Counted directly: the generated catalog went from **149 providers at `HEAD` to 21 in the working
tree** — the file's own header now reads `21 providers included, 158 skipped`. Meanwhile
`README.md` advertises "150+ providers" in **four** places, and the model ids in the new catalog
(`glm-5p2-fast`, `kimi-k3-fast`, `qwen3p7-plus`, `deepseek-v4-flash`) are a different generation
from the ones the docs and tests reference.

Either the regeneration's `ALLOW_IDS` filter is over-aggressive and this is a regression to be
reverted, or the catalog was deliberately trimmed and the README is now wrong in four places.
It cannot ship in the current in-between state.

---

## E. Deliberate simplifications the code itself declares

The codebase marks its own shortcuts with `ponytail:` comments naming the ceiling and the upgrade
path. They are listed here because they are *known* debt, not discovered debt, and they should be
read as design decisions rather than oversights.

| Location | Shortcut | Stated upgrade path |
| --- | --- | --- |
| `tools/tools.ts:17-18` | path-prefix jail only; symlinks out of the root are not caught | real OS sandboxing (realpath/chroot/seccomp) |
| `agent/agent.ts:28-29` | one global `SHELL_LOCK` for every shell call | per-path extraction if contention appears |
| `store/db.ts:11-13` | `CREATE TABLE IF NOT EXISTS` instead of versioned migrations | numbered migrations when a column must change |
| `engine.ts:186-188` | a fresh worktree per run, off current HEAD | stack/rebase onto the pending worktree branch |
| `server/server.ts:289-291` | credentials stored without a live provider ping | cheap models-list ping per client kind |

Every one of these is a reasonable v1 call. Two of them (the DB migration story and the shell lock)
appear in `lastminutechanges.md` because the ceiling is now being reached.

---

## F. Audit provenance

| | |
| --- | --- |
| Readers | 8, one per subsystem, high reasoning effort |
| Adversarial verifiers | 58, one per critical/high finding, instructed to refute |
| Completeness critic | 1, coverage-diffed against the file tree |
| Total agents | 67 · 1,422 tool calls · 3,218,318 tokens · 58 min |
| Findings recorded | 144 (7 critical, 37 high, 75 medium, 25 low) |
| Architecture notes | 119 |
| Observations | 179 |
| Verification outcome | 0 refuted · 30 downgraded · 28 upheld at original severity |

Hand-re-verified directly, outside the agent pipeline: the `.gitignore`/`tui/cmd/amux` exclusion,
the compiled-binary crash, the npm name registration, the phantom `ink`/`react` dependencies, the
catalog 149→21 collapse, the Bun-only API census, the cwd-relative path census, the dependency
usage census, and the list of modules without tests.
