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
| **Relay** | `niti-relay/` | A Cloudflare Worker + Durable Object (or Bun, self-hosted): devices register under an email (only a name), forwards end-to-end encrypted frames between a Mac's core and a phone, sends pushes. Never sees content. |
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
                                                       src/server   niti-relay ◀─ push
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
   Malformed calls are answered, never run blind (`agent/toolcalls.ts`): arguments are repaired when
   they are nearly JSON and otherwise refused with the parse error; a missing or mistyped required
   argument is named; a tool that doesn't exist gets the nearest real one.
   **Profiles** (`agent/profile.ts`): how the harness talks to a model. `standard` (cloud) is the
   above unchanged. `local` (provider `local`, `ollama`, `lmstudio`, or `profile: local` on the agent)
   is for 4–30B models on a laptop: a short `LOCAL_GUIDANCE` instead of `TOOL_GUIDANCE` (one call at a
   time, no batching or forks), project instructions capped at 6k characters with a pointer to the
   file, a 12-file map, no `list_dir`/`repo_map`/`hover`/`spawn_fork` and only named MCP tools,
   warning at 65% and compacting at 75% of the real window, 16k-character results, a repeat guard
   (the same call 3× is nudged, 5× ends the run), tool calls written as text (`<tool_call>`,
   `<function=…>`, `<function>{…}</function>`, or a JSON call on its own line after a sentence) run as
   real ones, and the planner, replanner, integrate and goal judge get JSON (grammar-constrained on
   llama.cpp, sampled at 0.2 everywhere). A local task runs the **action protocol**
   (`actionProtocol`, `Agent.localTurn`): every turn is one tool call and `finish({summary})` is the
   only way to end the task. A model its check found to call tools only when made to is forced from
   the first turn (llama.cpp `tool_choice: "required"`; on MLX the reply is started with its call
   opener, `probe.prefill`). For any other model, a reply without a call is handled in order:
   - a fenced file labelled with its name is saved through `write_file` (`salvageFiles`);
   - a bare "done" becomes `finish`;
   - anything else is asked again with the call forced.
   A turn that still isn't an action (or a `finish` before any work, or a second checklist instead of
   work) is refused: a stub replaces it in the history, the chat never shows it, and three in a row
   fail the task. Silence after real work counts as `finish`. Thinking is on for a task's first turn
   and right after a refusal only. A chat-only model (`probe.verdict`) runs without the protocol.
   A local lead plans in stages (`makeLocalPlan`), with plain-line asks recorded and sampled at 0.2:
   - it says what the message is in one line (`work`, `question: …`, `chat: …`; `parseRoute`);
   - it writes one line per ready teammate, `<id>: <task naming its files>` (`parsePlanLines`);
   - niti builds the graph: the parts in parallel, each carrying the whole request, then an
     integration task on the lead that checks the seams (linked files, routes, run steps).
   If the lines don't come, `rolePlan` splits the goal by role (UI, server and deployment, tests,
   docs) from the goal's own words. A cloud lead's failed plan falls back to the same split. The
   lead plans unless its model couldn't split work in its check and a teammate's could. Chat-only
   teammates are offered to the planner as "answers and reviews only", and a file-changing task
   given to one moves to the best-fitting ready teammate (`keepOffChatOnly`).
   **Acceptance checks** (`agent/accept.ts`) replace a local model's word that it's done. When a
   local task that wrote files calls `finish` (and always for the integration task), niti reads
   what was written and runs it:
   - pages: linked files exist, no placeholder copy, the business named in the request appears,
     some styling; then a palette of its own, its own fonts, enough CSS, and for a polished or
     responsive request media queries, a viewport and hover states; title, `lang`, one `<h1>`;
   - the server: started in the sandbox (network off, localhost on) with `PORT`, it must answer
     within 10 s, serve the site's `index.html` at `/` and answer the routes the task names;
   - the seams: the page's `fetch` paths against the server's routes;
   - when deployment was asked for: run steps in the README.
   A split task's server and deploy checks follow its own part (`ownPart`); the look and the name
   follow the whole request. Failures go back as the next turn, naming file and fix, three times.
   After that, a must failure leaves the task `unverified`, and quality failures are shown with the
   finished task. Each run of the checks is published as `protocol: "checks"` with the list.
   **Briefs** (`agent/briefs.ts`): a local task's first message carries the quality briefs its own
   part calls for. They are `web-page` (palette as variables, a Google Fonts pair, hero, spacing
   scale, responsive grid, hover and focus states, real copy), `server-api` (built-in modules,
   `PORT`, serve the site and `/api/` JSON, a start script), `deploy` (package.json, README run and
   deploy steps), `tests` and `cli`. Each pairs with the checks above. A project replaces one with
   `.niti/skills/<name>/SKILL.md`. An
   engine that dies
   under a request (the MLX server's generation thread) is restarted and the request retried once;
   the MLX server's errors go to `mlx-server.log`, and agents batch on it only when two contexts fit.
   `/model` rebuilds the prompt for the new model's profile.
4. **Interrupting one agent.** Each agent has its own abort controller and step counter on top of the
   run's: `Engine.interruptAgent` stops the agent that owns an in-progress task mid-call, denies its
   pending approvals, and it carries on from your message. Cancel stops the whole run.
5. **Failover.** Rate limits, context exhaustion or quota requeue a task with backoff and same-agent
   exclusion; failed for good after 3 attempts.
6. **Safety.** Writes and shell go through `approval.ts` (session grant → agent `permissions:` →
   project `permissions:` → ask; most specific pattern wins). Destructive shell patterns always ask,
   even under `--auto`. A request nobody answers is refused on its own after `approvalTimeout`
   seconds (default 300, `0` waits forever); `approval_request` carries each one's `expiresAt` and
   every client counts down to it. Paths are jailed (`safePath`); shell spawns with array args; `sandbox.ts` puts
   shell commands in an OS sandbox (Seatbelt on macOS, bubblewrap on Linux): writes confined to the
   project, credential stores unreadable; for a local-profile agent also no network but localhost,
   unless a person approved that command (`shellNetwork`; `OFFLINE_NOTE` tells the model why).
   Always asked, even under `--auto`: any recursive `rm`, `sudo`/`doas`/`su`, any `git push`,
   `kill`/`pkill`/`killall`, `chmod|chown -R`, installing a named package (npm/pnpm/yarn/bun add,
   pip/uv/poetry/pipx, brew, cargo, go install, gem, composer, npx/bunx), and writes to `.niti/`,
   `.git/`, `.claude/`, `.cursor/`, `.mcp.json` or `.vscode/{mcp,settings,tasks}.json`. `trust/` asks once per folder before reading its config,
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
    only. `/awake off` checks `pmset` itself, because lid-closed sleep is Mac-wide and survives a
    reboot or a dead watchdog: if it is still off, it asks for admin once and turns it back on.
12. **LSP and MCP** side by side in the tool list; a missing server is a message, never a crash.
    `watch.ts` reports edits made outside niti.
    **The web** (`tools/web.ts`, `web` in `allowedTools` grants all three): `web_fetch` reads a page
    as markdown (main content only, 3 MB and 12k characters by default, public addresses only:
    names are resolved and private, loopback and link-local answers refused on every redirect hop);
    `lookup` answers from npm, PyPI, crates.io, the Go proxy, GitHub (repo, `owner/repo#n`, a file),
    Stack Overflow and Wikipedia with no key; `web_search` (Tavily, basic depth, one credit) is offered
    only once a key is saved under `tavily` (`POST /websearch`, `niti-core auth login tavily`, or
    `TAVILY_API_KEY`). The free plan is 1,000 credits a month with no card, so it can't bill; past
    that, searches fail until the month resets. Every web call asks, even under `--auto` (the auto
    layer is skipped for them); a session or agent grant, or a `permissions:` rule, can allow them.
13. **Local models** (`local/*`, provider `local`). niti downloads GGUF models from the Hugging Face
    Hub and runs them itself with llama.cpp's `llama-server`, bundled beside `niti-core` (no Ollama or
    LM Studio). `catalog.ts` reads the Hub live (one list request with `expand[]=gguf` carries
    parameters, architecture, context and chat template; cached 15 min); a model can call tools when
    its chat template renders `tools`. `fit.ts` says Runs well / Tight / Won't fit from the Mac's
    memory and the GPU working-set cap (about ⅔ of memory up to 36 GB, ¾ above), and `bestQuant` picks
    the download (Q4_K_M unless there's room to step up or a need to step down). `downloads.ts`
    resumes with Range requests, verifies each file's sha256, and writes the manifest last, so only
    whole models count as installed; it also saves the authors' `generation_config.json` sampling.
    `runtime.ts` starts one server per model on first use (127.0.0.1, a free port, a random `--api-key` only this core knows, `--jinja`,
    `--reasoning-format deepseek`, f16 KV cache because a quantized one hurts tool calls), one
    full-context slot per agent using it (`-np N --no-kv-unified`) so each agent's prompt prefix stays
    cached, learns the real per-slot context from `/props`, and unloads after 15 idle minutes or when
    the core exits. `provider.ts` sends the model's sampling (never greedy), the agent's `id_slot`,
    the thinking switch and an 8k output cap on every request. The model id is `<repo>:<quant>`.
    **MLX** (`mlx.ts`, Apple Silicon): models published in MLX format (safetensors) run on Apple's
    `mlx_lm.server` instead. Its engine is Python, so it isn't bundled: the first MLX model fetches a
    standalone CPython (python-build-standalone, pinned by URL and sha256) and installs mlx-lm with
    `pip --require-hashes` against `mlx-lock.ts` (34 packages, every Apple Silicon wheel's sha256;
    regenerate with `bun scripts/mlx-lock.ts`) into `<models>/.engines/mlx-<version>/`: about 140 MB
    down, 520 MB on disk, once per Mac. It runs under niti's wrapper (`WRAPPER`), which requires the
    per-launch key (passed in the environment) on everything but `/health` and pins the started
    model, since the stock server loads any model a request names. MLX ids are `<repo>:mlx`;
    requests send `model: "default_model"` and ask for stream usage; the server batches agents and
    caches prefixes itself. The catalogue lists both formats (MLX only where it runs), one upload
    per model family in Recommended.
    **The model check** (`probe.ts`): before a local model's first agent request (and with
    `niti-core models check <id>`, `POST /local/models/check`), niti tests it once: whether it calls
    tools through the API (`native`), only when forced (llama.cpp `tool_choice: "required"`, or on MLX
    a reply started in its own call shape, `prefill`), only as text niti reads (`text`), or not at all;
    whether it can split work one line per teammate (`planMode`); which template tokens it leaks
    (`stops`, sent as stop sequences from then on). The verdict (`ready`, `partial`, `chat-only`) and
    the notes are on the manifest's `probe`; `models doctor` prints them with the engines' recent
    errors. Local requests always stop at template tokens and strip any that slip through.
    **Found on this Mac** (`discover.ts`): models in LM Studio's folders and the Hugging Face cache
    (MLX folders, and GGUF files whose own header gives architecture, context and chat template).
    Adding one writes a manifest with its `path`; the files stay where they are, are never copied,
    and removing it from niti only drops the manifest.

**Where things are**

| Path | Responsibility |
|---|---|
| `cli.ts` | `niti-core`: one-shot runs, `serve`, `--web`, `init`, `resume`, `auth` (incl. `tavily`), `models` (local: recommended, search, get, list, rm), `login copilot`, `audit verify`, `trust` |
| `engine.ts` | Wires agents, orchestrator, messaging, approvals, usage, locks, store, watcher, goal and remote into one `EventHub`: `submit`, `resume`, `cancel`, `interruptAgent`, `switchModel`, `rewind` |
| `config/config.ts` | `.niti/agents.yaml`: agents, permissions, LSP, MCP, options (`loadOptions`); `saveAgents` rewrites only `agents:` |
| `agent/*` | The agent loop and its parts (above) |
| `orchestrator/*` | Planner, scheduler, runner, the task queue, file and shell locks, worktrees |
| `messaging/message-bus.ts` | Agent ↔ agent messages |
| `providers/*` | Model clients, the catalog, pricing |
| `tools/*` | `read_file`, `write_file`, `edit`, `shell`, `grep`, `glob`, `list_dir`, LSP tools; output condensing; the web tools (`web.ts`) |
| `approval.ts`, `permissions.ts`, `sandbox.ts`, `secrets.ts`, `trust/` | The safety layer |
| `store/*` | SQLite sessions, checkpoints, the audit log; `.niti/.gitignore` |
| `goal.ts`, `awake.ts` | `/goal` and `/awake` |
| `commands/registry.ts` | Slash commands, shared by every front end; project commands from `.niti/commands/*.md` |
| `server/*` | The HTTP + SSE API (`server.ts`), the event hub with replay (`events.ts`), the headless core and its handshake line (`main.ts`) |
| `remote/*` | Remote control: the wire protocol, this Mac's identity, the bridge to the relay |
| `local/*` | Local models (`scripts/llama.ts` fetches the pinned, checksum-verified `llama-server` both packagings ship: `bin/llama/` in the macOS npm packages, `Contents/Resources/llama` in the app): the Hub catalogue, fit, downloads, the installed store, the `llama-server` runtime, the `local` provider, `/local/*` routes |
| `graph/filegraph.ts` | The project's import graph; its `IGNORE` set also bounds the project map every agent sees |

## Data on disk

```
<project>/.niti/
  agents.yaml        the team and options (below); meant to be committed
  niti.db            sessions (task, fork, ask, respond, and "plan": every JSON ask of the lead —
                     plan, replan, integrate, judge — with its raw reply), messages, parts,
                     checkpoints, audit log (SQLite, WAL)
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
  version.json       the last niti version the TUI ran, so an update can say what's new
~/Library/Application Support/niti/models/      (NITI_LOCAL_MODELS_DIR; ~/.local/share/niti/models elsewhere)
  <owner>__<repo>/   a downloaded model's .gguf files, or an MLX repo's files (.part while
                     downloading), and one manifest.<quant>.json per installed quant; an added
                     model's manifest points at its files elsewhere (`path`)
  .engines/mlx-<v>/  the MLX engine: Python, mlx-lm and niti's server wrapper
  runtime.pids       servers this core started, so the next one can stop orphans
  llama-server.log   the local runtime's log
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
    profile: local|standard # how the harness talks to it; default from the provider
    permissions: {tool: {pattern: allow|ask|deny}}
permissions: {tool: {pattern: allow|ask|deny}}   # project default
lsp: {name: {command, args?, extensions}}
mcpServers: [{name, command, args?}]
# options, all optional
theme · auto · watch · instructions: [files] · maxTurns · maxAgents · worktree · verify: [cmds]|false
approvalTimeout: seconds   # unanswered approvals are refused after it; 0 = never; default 300
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
- **Web search**: `GET /websearch` (`{configured, saved}`), `POST /websearch {key}` (tested with one
  search, then saved; the key never comes back out), `DELETE /websearch`.
- **Local models** (never on the phone bridge): `GET /local/device`, `GET /local/catalog?tab=recommended|all&q&sort&tools&fits&size`,
  `GET /local/catalog/model?repo=`, `GET /local/models` (installed + active downloads),
  `DELETE /local/models?id=`, `POST /local/download {repo, quant}`, `POST /local/download/cancel {id}`,
  `POST /local/unload {model}`, `GET /local/discover` (found on this Mac), `POST /local/import {id}`,
  `POST|DELETE /local/engine/mlx` (install ahead of time, remove). `/local/catalog` also takes
  `format=gguf|mlx|any`; `/local/device` reports the MLX engine. `GET /models?provider=local` lists installed model ids.

Events (`server/events.ts`, kind): `agent_event`, `agent_message`, `orchestration`, `approval_request`,
`usage`, `turn_summary`, `lock`, `session`, `session_reset`, `goal`, `awake`, `remote`, `theme`,
`local_download` (progress live-only, the end replayed), `local_runtime`, `resync`. The Go TUI decodes all of them into one flat struct, so a field name shared with another
event must keep that event's type: nest new data rather than adding top-level fields.

Slash commands (`commands/registry.ts`): `/goal /cancel /awake /remote /auto /manual /rewind /branch
/model /agents /tasks /status /cost /sessions /skills /models /mcp /lsp /permissions /debate /export /resume
/clear /init /help`, plus each client's own (`/theme`, `/quit`…) and project commands.

## Remote control (`src/remote/`, `niti-relay/`, `niti-mobile/`)

- **Signing in**: `/remote on <email>` registers the Mac's ed25519 key at the relay under that email,
  which is only a name grouping your devices: nothing is sent to it or checked. Registering is signed
  by the device's key (`registerMessage`), so knowing a public key can't move a device elsewhere. From
  then on the key is the credential: each connection signs the relay's challenge. The relay address
  is built in (`DEFAULT_RELAY` in `identity.ts`, `extra.relay` in the app); `--relay` is for your own.
  Shared by every core on the Mac (`~/.config/niti/remote.json`).
- **Pairing**: the Mac shows a 6-digit code (`/remote on <email>`, `/remote pair` for another); the
  phone types the email and the code, once per Mac. The code never travels: both sides run CPace, a
  password-authenticated key exchange over X25519 (`protocol.ts` `Pake`), bound to the two device
  ids, and swap tags over both signing keys. A passive relay learns nothing to test guesses against;
  each guess needs a live try, and a code allows 5 tries and lives 10 minutes. The Mac then allows the
  phone, and the phone pins the Mac's key: it only ever opens Macs it paired with. Anyone can register
  under your email, so the relay makes room at its 20-device cap from devices nobody allowed, and the
  phone shows only paired Macs.
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
`NITI_TRUST_FILE`, `NITI_REMOTE_FILE`, `NITI_LOCAL_MODELS_DIR`…) in `scripts/e2e/*` and
`niti-app/scripts/fixture.ts`. Local models are tested without a model or a GPU:
`scripts/e2e/fakellama.ts` stands in for `llama-server` (`NITI_LLAMA_SERVER`), `fakemlx.ts` for the
MLX engine (`NITI_MLX_SERVER`), the Hub is a fixture (`NITI_HF_URL`, or an injected fetch), and
`NITI_DISCOVER_DIRS` replaces the folders "Found on this Mac" scans (empty in every harness).

| What | Command |
|---|---|
| Engine and dashboard unit tests | `bun test ./src ./web` · `bun run typecheck` |
| The whole CLI, end to end (core API, remote path, CLI, TUI, a real terminal, relay) | `zsh scripts/e2e/run.sh` |
| Desktop app (typecheck, tests, build, live, smoke, audit, perf) | `cd niti-app && npm run check` |
| Relay | `cd niti-relay && bun test && bunx tsc --noEmit` |
| Mobile | `cd niti-mobile && npm run typecheck && bun test ./src && npx expo export --platform ios` |
| Agent quality (before and after any agent-loop or tool change) | `bun run scripts/eval/run.ts --repeat 3` (cloud) · `--provider local --model <repo>:<quant>` or `--base-url <url> --profile local` (a local model; adds the `suite: local` tasks) |

## Releasing

The CLI and the desktop app have separate version lines: the CLI is `0.4.x` on npm, tagged `v*`;
the app is `0.1.x`, a DMG on GitHub, tagged `app-v*`. Never bump one to match the other, and never
tag the app `v*` (that tag triggers the npm workflow).

**CLI to npm.** `@slenderbuilds/niti` is a Node shim (`bin/`) that loads one of five unscoped
platform packages (`niti-darwin-arm64`, `niti-darwin-x64`, `niti-linux-x64`, `niti-linux-arm64`,
`niti-win32-x64`), each carrying both binaries and the dashboard.

```sh
bun run bump 0.4.9                   # package.json, its platform pins, the TUI's Version, bun.lock,
                                     # and a drafted what's-new entry: edit tui/internal/whatsnew/changelog.json
git commit -am "Bump version to 0.4.9"
bun run build:release                # all five platforms into npm/
npm login
npm publish ./npm/darwin-arm64 --access public   # each platform package first
npm publish ./npm/darwin-x64 --access public
npm publish ./npm/linux-x64 --access public
npm publish ./npm/linux-arm64 --access public
npm publish ./npm/win32-x64 --access public
for p in darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64; do npm view niti-$p@0.4.9 version; done
npm publish --access public          # the root package last, only once all five show the version
git tag v0.4.9 && git push origin v0.4.9 && gh release create v0.4.9 --notes "…"
```

The order matters: a root package published before its platform packages pins versions that don't
exist, and every install breaks. `.github/workflows/release.yml` runs on a `v*` tag, checks the
versions agree, tests and builds; it publishes only if the repo has an `NPM_TOKEN` secret, which it
doesn't today, so publishing is by hand as above. Add `--otp=<code>` to `npm publish` if npm asks.

**Desktop app to GitHub.**

```sh
(cd niti-app && npm version 0.1.3 --no-git-tag-version)
git commit -am "niti-app: version 0.1.3"
(cd niti-app && npm run dist)        # bundles the core, builds → niti-app/release/niti-0.1.3-arm64.dmg
git tag app-v0.1.3 && git push origin app-v0.1.3
gh release create app-v0.1.3 niti-app/release/niti-0.1.3-arm64.dmg --title "niti desktop v0.1.3" --notes "…" --latest
```

The DMG is Apple Silicon only and not notarized; its notes say so (right-click → Open the first
time). Run the full checks (`zsh scripts/e2e/run.sh`, `cd niti-app && npm run check`) before either.

## Known ceilings

- One global shell lock rather than per path; the tool sandbox is path-jailed plus the OS sandbox,
  not a container.
- Same-agent retry on exhaustion rather than live reassignment.
- File watching has no debounce or full `.gitignore` parsing.
- MCP servers are shared by the team, not per agent.
- A core lives as long as the TUI or app that started it: a phone can't start niti on a Mac (no daemon yet).
- No refresh tokens: the device key is the credential. A relay that knows your email can list your
  devices' names and when your Macs are online, never what they do.
- Not yet built: Live Activity, approving from the lock screen without opening the app, Android.

## History worth knowing

- **October 2026:** `/goal`, interrupting one agent, remote control (relay + iPhone app), and the
  pairing by code: first a code compared on both screens behind an email sign-in (commit-then-reveal,
  after a first version whose code was a hash of public keys alone, which anyone could match by trying
  keys), then the email check and the compare step dropped for a code typed on the phone, checked by
  CPace so the relay still can't learn it. The archived v1 Ink TUI (`old-tech/`), a VS Code fork
  (`ide/`) and an earlier Electron app (`desktop/`) were deleted; none of them exists.
- **Bugs found in review, kept as lessons:** `compactTurns()` could split a tool call from its result
  (the cut now walks back); cancel didn't stop retry backoff or the final integrate; a reused task id
  could mis-resolve a dependency (now dropped); switching a busy agent's provider mid-loop could send
  one provider's history to another (now refused); the server's token check wasn't constant-time
  (now `timingSafeEqual`); `saveAgents()` used to rewrite the whole `agents.yaml` (now only `agents:`);
  the TUI's SSE reader couldn't tell a stop from a disconnect (now reconnects with seq replay).
