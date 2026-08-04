# lastminutechanges.md

**Ranked, actionable pre-publish findings for `amux`.** 143 items.

Audit date: 2026-08-04 · Branch `main` · HEAD `a861b44` · working tree dirty (5 files)

The descriptive counterpart — how every subsystem actually works, plus 200 observations and 134
architecture notes — is [`EVERYTHING.md`](./EVERYTHING.md). This file is only the things to *do*.

---

## DECISIONS — settled by the maintainer, 2026-08-04

**Read this before touching anything.** These three questions were open when the audit landed.
They are now answered, and the answers change what several findings mean. Do not re-litigate them.

### 1. Package name — **rename**

`amux` is taken on npm (`npm view amux` → maintainer `donavon`, v0.0.0). The decision is to
**rename, not to scope it** — so `@scope/amux` is off the table.

> ⚠️ **The replacement name has not been chosen yet.** Ask for it before writing `package.json`.
> It is the only unresolved input to the publish work.

Scope note: only the **npm package name** must change. The local binaries (`amux`, `amux-core`),
the Go module path, the `.amux/` state directory and the repo itself can all keep the name — this
is a registry collision, not a project rename. Confirm that reading when you ask for the new name.

### 2. Browser terminal — **remove completely**

No breadcrumb, no roadmap note, no deferred-feature TODO. Delete it outright.

That means, in one pass: `src/server/server.ts` lines 4-5 (`import * as pty` / `import type
{ IPty }`), the `TerminalSocketData` interface (:26-28), the three `VENDOR_FILES` entries
(:20-24), the `serveVendor` function and its `nodeModulesDir` (:75-82), the `p in VENDOR_FILES`
route (:141), the `/terminal/ws` route (:159-162), and the entire `websocket: { open, message,
close }` block (:328-380). Then drop `node-pty`, `@xterm/xterm` and `@xterm/addon-fit` from
`package.json` (:30-32), delete the `postinstall` hook (:19) and `scripts/fix-pty-perms.ts`.

Verified safe: the feature has **zero clients** — `grep -rn -iE 'xterm|terminal/ws' web/ tui/`
returns nothing. The browser half was never written. Nothing that currently works is lost.

This resolves findings **#2** and **#3** together, and is the single highest-leverage change in
the audit: it repairs the compiled binary *and* removes 3 of 10 runtime dependencies.

Knock-on: finding **#12** shrinks but does not disappear — `nodeModulesDir` goes away with
`serveVendor`, but `webDir` (`server.ts:53`) and `palettesFile` (`:88`) still use the
percent-encoded `new URL(...).pathname` and still need `fileURLToPath()`.

### 3. Provider catalog trimmed to 21 — **intentional, keep it**

The uncommitted 149 → 21 collapse is a deliberate trim, not a regression. **Do not revert it.**
Fix the documentation to match reality instead:

- `README.md` claims "150+ providers" in **four** places — all four are now wrong (finding **#42**).
- Finding **#84** (`github-models` is in `ALLOW_IDS` but gone upstream) and finding **#109** (the
  same vendor appearing twice in the first-launch picker with different labels and model counts)
  stop being artifacts of an in-progress edit and become **live bugs in the shipped catalog**.
  Treat them as real work, not noise.
- The five uncommitted files (`scripts/gen-catalog.ts`, `src/providers/catalog.generated.ts`,
  `catalog.test.ts`, `catalog.ts`, `.amux/agents.yaml`) are keepers and should be committed —
  except `.amux/agents.yaml`, which per finding **#40** must be **un-tracked**, not committed.

---

## The one-paragraph verdict

The engine is good. The orchestration core, the layered permission model, the sandbox boundary, the
token-gated loopback server and the 275-test suite are all better than most projects at this stage,
and the code documents its own shortcuts honestly. **The distribution layer, by contrast, does not
exist yet.** Each of the three artefacts a global NPM install would need is independently broken
today: `package.json` is `private` with a `bin` pointing at a raw `.ts` file, the compiled
`amux-core` binary crashes at module load on *every* command, and the Go TUI can only locate its
core through a repo-relative path. On top of that, two repository-integrity bugs mean a fresh clone
cannot build the primary binary at all and its test suite goes red. Fix P0 and P1 and this is
shippable; publishing as-is would ship a package that cannot execute a single command.

## Severity, and how to read it

Every critical/high finding was handed to an adversarial verifier told to *refute* it and to default
to "refuted" when it could not concretely confirm the claim. **58 were tested: none were refuted,
but 30 were downgraded.** Severities below are post-verification, and any downgrade is stated
inline on the item. Items marked *adversarially verified* survived that pass; the rest are
single-reader findings at medium/low, where the verification spend was not worth it.

| Priority | Count | Meaning |
| --- | --- | --- |
| **P0** | 6 | Nothing works until these are fixed |
| **P1** | 37 | Would generate immediate bug reports from real users |
| **P2** | 75 | Real, bounded — fix on the next pass |
| **P3** | 25 | Papercuts and polish |

One editorial note on the ranking. The verifiers downgraded several packaging items (`"private": true`,
the taken npm name, the `.ts` `bin` target) to medium/low on the grounds that each is a one-line
fix. That is true individually and misleading collectively: **together they are an absolute
publish blocker.** They are consolidated into the shipping strategy at the end of this document
rather than being argued back up the severity scale.

## The critical path, in order

If you do nothing else, do these, in this sequence. The first two are prerequisites for anyone
other than you being able to build the project at all.

1. **Un-ignore the Go TUI's `main.go`** — finding **#1**. One character in `.gitignore`. Without it
   a clean clone contains no `func main()` and `bun run build:tui` fails outright.
2. **Get `old-tech/ink-tui/` out of the test path** — finding **#6**. It pulls phantom `ink`/`react`
   imports into `bun test`, so the suite is red on a clean clone even though it is green here.
3. **Delete `node-pty`, `@xterm/*` and the `postinstall` hook** — findings **#2** and **#3**. They
   exist only for a browser-terminal route the code itself documents as non-functional under Bun,
   and `node-pty` is the sole reason the compiled binary crashes. This one deletion fixes the build
   product *and* removes 4 of 10 runtime dependencies.
4. **Give the shell tool a timeout, an output cap and a closed stdin** — finding **#5**. One
   un-terminated command currently hangs an agent forever.
5. **Make the TUI locate its core via `os.Executable()` + `exec.LookPath`** — finding **#4**.
6. **Resolve the uncommitted catalog change** — finding **#42**. The working tree drops the
   provider catalog from 149 to 21 while `README.md` still advertises "150+" in four places.
   (Counted directly: `git show HEAD:src/providers/catalog.generated.ts` has 149 provider keys,
   the working tree has 21, and the generated header now says `21 providers included, 158 skipped`.)
7. **Rewrite `package.json` for publication** — see [the shipping strategy](#the-shipping-strategy)
   at the end.

Then work the P1 list, which is mostly error handling and first-run UX.

---

# P0 — Blockers. Do not publish until these are fixed (6)

## 1. `tui/cmd/amux/main.go` is untracked by git — .gitignore line 2 (`amux`) ignores the Go TUI's entire main package, so a fresh clone cannot build `./amux`

`.gitignore:2` · **packaging** · adversarially verified

**Evidence**

```
$ git check-ignore -v tui/cmd/amux/main.go
.gitignore:2:amux	tui/cmd/amux/main.go

$ git ls-files tui/cmd/
(empty)

$ git ls-files tui/ | wc -l
      24
$ find tui -name "*.go" | wc -l
      22

21 .go files + go.mod + go.sum + palettes.json = 24 tracked. The missing 22nd .go file is tui/cmd/amux/main.go — the file that contains startCore(), the handshake parser, and func main().
```

**Impact.** `git clone <repo> && cd tui && go build -o ../amux ./cmd/amux` fails with `no Go files in .../tui/cmd/amux`. `bun run build:tui` (package.json:14) runs exactly that command, so the documented build of the primary user-facing binary is broken for every clone. The pattern `amux` on line 2 is unanchored, so git treats it as 'any path component named amux' — it was meant to ignore the compiled `./amux` binary and caught the source directory too.

**Fix.** Anchor the binary patterns in .gitignore: change `amux` → `/amux` and `amux-core` → `/amux-core` (leading slash = repo-root only). Then `git add -f tui/cmd/amux/main.go` and verify with `git ls-files tui/ | wc -l` → 25. Confirm nothing else was silently dropped with `git status --porcelain --ignored | grep '^!!'`.

## 2. `bun build --compile` produces a binary that crashes on startup on every command, on every machine, including the build machine — node-pty is the sole cause

`package.json:13` · **packaging** · adversarially verified

**Evidence**

```
Fresh build succeeded (`bundle 704 modules`, `compile`, exit 0, 64,652,432 B). Running it from /tmp and from the repo root both give exit 1:
'''
error: Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/darwin-arm64: ResolveMessage: Cannot find module './prebuilds/darwin-arm64//pty.node' from 'node_modules/@napi-rs/keyring/index.js'
      at loadNativeModule (/$bunfs/root/amux-core:34547:11)
Bun v1.3.10 (macOS arm64)
'''
Isolation probes: a binary compiled from only `import { Entry } from "@napi-rs/keyring"` runs clean (`keyring ok function`, exit 0). A binary compiled from only `import * as pty from "node-pty"` fails with the same error (exit 1). node-pty alone breaks `bun --compile`.
The import is unconditional and top-level: src/server/server.ts:4 `import * as pty from "node-pty";`, reached from src/cli.ts:27 `import { serveMain } from "./server/main.ts";`.
```

**Impact.** `amux-core "say hi"` from any directory → raw 12-line Bun stack trace, exit 1. Not a task-specific failure: the module loads before argv is even parsed, so *every* subcommand (init, auth, serve, resume, --web) is dead. The committed ./amux-core and ./amux-core produced by `bun run build`/`build:all` are both non-functional, meaning the entire 'ship a single compiled binary' distribution plan currently produces a guaranteed 100%-failure artifact.

**Fix.** Delete the terminal feature and node-pty with it (see the next finding — it has zero clients and is documented as non-functional). Concretely, in src/server/server.ts: remove lines 4-5 (`import * as pty`/`import type { IPty }`), the `TerminalSocketData.pty` field (:26-28), the `/terminal/ws` route (:159-162), and the whole `websocket: { open/message/… }` block (:326+); drop `node-pty` from package.json:32; delete package.json:19 postinstall and scripts/fix-pty-perms.ts. Then re-run `bun build --compile` and verify from an empty dir. If the pty is wanted later, do it as the file's own comment prescribes — a separate helper process — and lazy-`await import("node-pty")` inside the route handler so it can never break startup or the compile.

## 3. node-pty + @xterm/xterm + @xterm/addon-fit + the postinstall hook all exist for a feature with zero callers that the code itself documents as broken

`src/server/server.ts:332` · **maintainability** · adversarially verified

**Evidence**

```
The handler's own comment:
'''
// KNOWN BLOCKER (confirmed by direct testing, not theoretical): a node-pty child spawned in
// any process where Bun.serve() is running gets killed (SIGHUP, or exits immediately) within
// single-digit milliseconds ... This code is therefore not yet functional end-to-end under Bun;
'''
Grep for `xterm`, `terminal/ws`, `new Terminal(`, `FitAddon` across /web, /tui, /src returns zero hits outside server.ts:20-24, :159 and three Go *test* files matching the word 'Terminal'. web/index.html and web/app.js never reference /xterm.js.
Live proof the vendor route is dead on an npm install: booted the installed package's server, `curl /xterm.js` → `xterm.js=404`, body `{"error":"not found"}` (while `/` → 200 and `/palettes.json` → 200).
```

**Impact.** Three of ten runtime dependencies, the only compile-from-source native module (node-pty has no Linux prebuild → `node-gyp rebuild` on every Linux install), and the bun-only postinstall script are all carried for dead weight. Every Linux user's `npm i -g` risks failing on a C++ toolchain for a WebSocket nobody opens. And it is what breaks `bun --compile`.

**Fix.** Delete it. Remove `node-pty`, `@xterm/xterm`, `@xterm/addon-fit` from package.json dependencies (lines 30-32); delete `VENDOR_FILES` and `serveVendor` from src/server/server.ts (:20-24, :75-82) and the `/xterm.js|/xterm.css|/xterm-addon-fit.js` route dispatch; delete the `/terminal/ws` route and the `websocket:` block; delete package.json:19 postinstall and scripts/fix-pty-perms.ts. This is a pure-deletion diff that simultaneously fixes the compile, removes the native-install risk, and drops the Bun requirement in postinstall.

## 4. The TUI can only find the core via a repo-relative path — a globally installed amux is dead on arrival

`tui/cmd/amux/main.go:49` · **packaging** · adversarially verified

**Evidence**

```
main.go:49-51:
	entry := envOr("AMUX_CORE_ENTRY", "src/server/main.ts")
	bunBin := envOr("AMUX_BUN", "bun")
	cmd := exec.Command(bunBin, "run", entry)

No PATH lookup for `amux-core`, no `exec.LookPath`, no resolution relative to `os.Executable()`, and `cmd.Dir` is never set. Reproduced from a scratch directory:

  $ cd /tmp/amux-audit-cwd && amux
  error: Module not found "src/server/main.ts"
  amux: core did not hand shake: EOF

The repo already builds a self-contained 64MB `./amux-core` (package.json "build": "bun build --compile ./src/cli.ts --outfile amux-core") and README.md:16 describes it as "what `amux` spawns under the hood" — but nothing in the Go module ever mentions the string "amux-core".
```

**Impact.** `amux` works only when the process cwd is the amux git checkout. A user who installs the package and runs `amux` in their own project gets two lines of noise (`Module not found`, `core did not hand shake: EOF`) and exits. It also means the compiled binary is dead weight: the shipped TUI requires a Bun runtime plus the full TypeScript source tree on disk, contradicting both the README and the existence of the --compile build step.

**Fix.** In `startCore`, resolve the core in this order and take the first that exists: (1) `AMUX_CORE_ENTRY` if set, (2) an `amux-core` binary next to the TUI executable — `filepath.Join(filepath.Dir(os.Executable()), "amux-core")`, (3) `exec.LookPath("amux-core")`, (4) the current `bun run src/server/main.ts` as the dev fallback, and only reach it if `src/server/main.ts` actually exists. Spawn the binary as `amux-core serve` (src/cli.ts already documents that subcommand). Set `cmd.Dir` to the user's cwd deliberately so the core roots itself at the project being worked on. When every candidate fails, print which paths were tried instead of "did not hand shake: EOF".

## 5. The shell tool has no timeout, no output cap and no kill path

`src/tools/tools.ts:34` · **correctness** · adversarially verified

**Evidence**

```
'''
const child = spawn(command, args, { cwd: root });
let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => (stdout += d));
child.stderr.on("data", (d) => (stderr += d));
child.on("close", (code) => res({ stdout, stderr, code: code ?? -1 }));
'''
No `timeout`, no `killSignal`, no byte budget. `grep -rn "timeout|maxBuffer|kill(" src/tools/ src/agent/` returns nothing.
```

**Impact.** A model that runs `npm run dev`, `tail -f`, `docker compose up` or anything that waits on stdin never returns. The `await runTool(...)` at agent.ts:470 never settles, so: the SHELL_LOCK is held (reclaimed after 60s by LockRegistry, meaning a *second* agent then starts a concurrent shell), the agent's `run()` never returns, `Engine.busy` stays true forever, and no further `submit()` is possible (`a task is already running`, engine.ts:180). Separately, `find / -type f` or `cat` on a large binary accumulates unbounded into `stdout` — first blowing process memory, then being returned wholesale as a tool result that is pushed into `turns` and resent on every subsequent iteration.

**Fix.** In src/tools/tools.ts:35, `spawn(command, args, { cwd: root, timeout: 120_000, killSignal: "SIGKILL" })` — node/Bun's spawn honors both. Cap accumulation in the two data handlers: `if (stdout.length < 100_000) stdout += d;` and append `\n[output truncated]` when the cap is hit. Report a timed-out command as `exit -1\n[timed out after 120s]` so the model can react. Make the limit configurable via `agents.yaml` if any project needs long builds.

## 6. `bun test` fails on a clean clone: 5 of 41 test files cannot resolve their imports, because ink/react are installed on the maintainer's machine but absent from bun.lock and package.json

`package.json:21` · **packaging**

**Evidence**

```
`grep -n 'react\|"ink' bun.lock` returns nothing (0 matches in 39,278 bytes), and root package.json declares neither. On the maintainer's tree `node_modules/ink@7.1.1`, `node_modules/react@19.2.8`, `ink-testing-library`, `ink-text-input` and `auto-bind` all exist — stale from an install predating the v2 overhaul.\n\nI cloned the repo locally and ran a real install:\n'''\n$ git clone --local … clone && cd clone && bun install\n150 packages installed [810.00ms]\n$ ls -d node_modules/ink node_modules/react\nls: node_modules/ink: No such file or directory\nls: node_modules/react: No such file or directory\n$ bun test\nerror: Cannot find module 'react/jsx-dev-runtime' from '…/old-tech/ink-tui/UsageView.test.tsx'\nerror: Cannot find module 'react/jsx-dev-runtime' from '…/old-tech/ink-tui/GraphView.test.tsx'\nerror: Cannot find package 'chalk' from '…/old-tech/ink-tui/theme.ts'\n 258 pass\n 5 fail\n 5 errors\nRan 263 tests across 41 files.\n'''
```

**Impact.** The audit's own established fact — '275 pass / 0 fail across 41 files' — is an artifact of one machine's stale node_modules. Every new contributor's first `bun test` is red with three module-resolution errors pointing at a directory the docs say is not part of the build, and README.md:189 tells them `bun test` is the way to verify their change. The moment CI is added (see the CI finding below) it goes red on commit one. The green suite is 258 tests, not 275.

**Fix.** The dead Ink TUI is self-documented as unmaintained and out of the build; make that true for `bun test` too. One line in package.json: change `"test": "bun test"` to `"test": "bun test src web"` — I verified this on the clean clone: `258 pass / 0 fail / Ran 258 tests across 36 files`. The laziest correct version is to delete `old-tech/` outright (13 files, zero production callers, its own README says it is archived); git history already preserves it. If it is kept, its README lines 9-11 and project_context.md's matching claim must be corrected — they currently assert an exclusion that does not exist.


---

# P1 — Fix before publish (37)

## 7. No `files` field and no .npmignore: the tarball ships the maintainer's dot-config, dead code and every test, and ships zero executables

`package.json:1` · **packaging** · adversarially verified · originally reported critical, downgraded on verification

**Evidence**

```
`npm pack --dry-run` warns `gitignore-fallback No .npmignore file found, using .gitignore for file exclusion.` Result: 135 files, 268.8 kB packed / 860.6 kB unpacked. Includes `.amux/agents.yaml` (the maintainer's own roster: `provider: google`, `model: gemini-flash-latest`, `theme: neon graveyard`), `.claude/settings.local.json`, `project_context.md` (21.8 kB), `bun.lock` (39.3 kB), 13 files of `old-tech/ink-tui/` (dead per README.md:21) including its own nested package.json, all 24 `tui/` Go files including `*_test.go`, and every `*.test.ts` in src/ and web/. Verified post-install: `ls -a node_modules/amux/` shows `.amux` and `.claude` present.
Meanwhile `.gitignore` lines 2-3 are `amux` and `amux-core`, so both executables are excluded — `git ls-files amux amux-core` → 0.
```

**Impact.** Users download the author's local AI config and Claude MCP allowlist; they get a dead React/Ink app with a nested package.json that confuses tooling; they get the Go source of a binary they cannot build without Go; and they get nothing that runs. The inversion is total: 100% of what ships is unnecessary, 100% of what is necessary is excluded.

**Fix.** Add an explicit allowlist to package.json and stop relying on .gitignore. Minimum viable for the current shape: `"files": ["src", "web", "bin", "README.md", "LICENSE"]`. Then verify with `npm pack --dry-run` that `.amux`, `.claude`, `old-tech`, `tui`, `project_context.md`, `bun.lock` and every `*.test.ts` are gone. If tests must stay out but src must stay in, add `"!src/**/*.test.ts"` — or better, move tests to a top-level `test/` tree. Untrack `.amux/agents.yaml` and `.claude/settings.local.json` from git entirely (`git rm --cached`) and add them to .gitignore.

## 8. There is no strategy at all for shipping two per-platform binaries; the current package ships neither

`package.json:13` · **packaging** · adversarially verified

**Evidence**

```
`ls -la amux amux-core` → 10,874,738 B and 64,652,432 B, both `Mach-O 64-bit executable arm64`. Both are in .gitignore (lines 2-3), untracked (`git ls-files` → 0), and absent from the 135-file tarball. `build:all` (package.json:15) requires Go ≥1.22 plus Bun on the user's machine. There is no CI workflow, no `optionalDependencies` for platform packages, no `os`/`cpu` fields.
```

**Impact.** An npm consumer gets neither binary and cannot build them (Go is not an npm dependency). A darwin-x64, Linux, or Windows user could not use the arm64 artifacts even if they were shipped. Publishing today ships 860 kB of source that requires a Bun install, a Go install, and a clone to become usable — i.e. npm adds nothing over `git clone`.

**Fix.** Copy the pattern real agentic CLIs use (@anthropic-ai/claude-code, esbuild, opencode): a thin JS launcher package plus per-platform binary packages. Concretely: (1) delete node-pty so `bun --compile` works again; (2) CI matrix builds `bun build --compile --target=bun-{darwin,linux}-{arm64,x64} --outfile amux-core` and `GOOS/GOARCH go build` for the TUI, four to six pairs; (3) publish each pair as `@scope/amux-darwin-arm64` etc., each with matching `"os"`/`"cpu"` fields; (4) the root package lists them all in `optionalDependencies` — npm installs only the matching one — and its `bin` is a 20-line Node CJS launcher that resolves the platform package and `execFileSync`s `amux` (TUI) or `amux-core`. Interim, if that is too much for v0.1: publish source-only, keep `private: false` off, and document `bun x` / clone-and-build honestly — but do not publish a package whose bin cannot run.

## 9. `amux-core --web` disables tool approvals entirely, while the dashboard it opens ships a full approval UI that can never fire

`src/cli.ts:100` · **security** · adversarially verified

**Evidence**

```
cli.ts:100-101: `// The web dashboard is read-only (no approver in this process), so run headless/auto-approve.` then `const { engine, server } = await serveMain({ interactive: false });`. engine.ts:118 wires the approver only when interactive is true: `approve: opts.interactive ? (tool, input, forceAsk) => this.approvals.request(...) : undefined`. Meanwhile web/index.html:61-71 defines the approval overlay and app.js:289-308 implements the whole yes/always/no flow against `POST /approval`, and the dashboard is demonstrably not read-only: it can `POST /prompt` (app.js:318), `POST /model` (app.js:277) and `POST /agents/:id/message` (app.js:257).
```

**Impact.** `amux-core --web "do the thing"` — the advertised one-command dashboard entry point (cli.ts:12) — runs every agent with write_file and shell auto-approved, and nothing in the browser UI says so. A user who has seen the approval dialog while attached via the TUI will reasonably assume the same gate applies here. The stale "read-only" comment is what makes this look intentional.

**Fix.** Pass `interactive: true` in cli.ts:101 (the approval queue is answered over `POST /approval`, which the dashboard already implements — that is exactly the point of the FIFO shared with the TUI), and delete the stale comment. If auto-approve is genuinely wanted, require the existing explicit `--auto` flag and render a persistent banner in the dashboard header when `/session` reports it.

## 10. Every agents.yaml validation error is swallowed and replaced by a wrong, destructive suggestion

`src/cli.ts:190` · **ux** · adversarially verified · originally reported critical, downgraded on verification

**Evidence**

```
surfaceStartupError:

  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOENT|agents\.yaml/.test(msg)) die(`no agents configured. Run 'amux-core init' to set up providers and roles.`);
  die(msg);

Every error `config.ts` throws embeds the config path, and the path IS `.amux/agents.yaml` — e.g. `${path} agent[${i}]: unknown provider '${provider}'` (config.ts:149), `${path} agent[${i}]: missing '${k}'` (:144), `${path}: ${agents.length} agents configured but maxAgents is ${max}` (:19). So the regex matches all of them. Reproduced with a real config containing `provider: cohere`:

  $ cd /tmp/amuxroot && bun src/cli.ts "hello"
  amux: no agents configured. Run 'amux-core init' to set up providers and roles.

The actual error — `unknown provider 'cohere' (known: anthropic, openai, google, …)` — was thrown and discarded.
```

**Impact.** A user with a one-character typo in agents.yaml is told their config does not exist and is instructed to run `init`. `runInit` ends in `saveAgents(roles)` (cli.ts:265), which overwrites `agents:` — so following the advice destroys the roster they were trying to fix, and they still never learn what was wrong. This is the single most likely first-run failure and the error message actively misleads on it.

**Fix.** In `src/config/config.ts:11`, guard the read so 'missing' is distinguishable from 'invalid': `if (!existsSync(path)) throw new Error(\`ENOENT: ${path}\`)` before the readFileSync. Then narrow the regex in cli.ts:191 to `/ENOENT/` only, so every validation error falls through to `die(msg)` and prints the real, already-excellent message. Two-line diff, no new abstraction.

## 11. The compiled binary cannot start the server at all — node-pty's native module is unresolvable inside `bun build --compile`, and server.ts is its only importer

`src/server/server.ts:4` · **packaging** · adversarially verified · originally reported critical, downgraded on verification

**Evidence**

```
server.ts:4 `import * as pty from "node-pty";` is a top-level static import, and `grep -rn node-pty --include=*.ts` shows server.ts is the ONLY source file that imports it. I rebuilt from current source (`bun build --compile ./src/cli.ts --outfile /tmp/amuxprobe/amux-core-new`, 704 modules, succeeded) and ran it: `error: Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/darwin-arm64: ResolveMessage: Cannot find module './prebuilds/darwin-arm64//pty.node' ... at /$bunfs/root/amux-core-new:34547`. Exit before any output; `curl http://127.0.0.1:8793/health` → connection refused (curl exit 7). The committed ./amux-core (64MB) fails identically, both from the repo root and from an unrelated cwd.
```

**Impact.** `amux-core serve`, `amux-core --web`, and every headless CLI mode are dead in the compiled binary — the artifact a user would actually download. The failure is at module-load time, before any argument parsing, so there is no partial functionality and no useful error message. The only feature that needs node-pty is /terminal/ws, which server.ts:329-339 already documents as non-functional under Bun.

**Fix.** Delete the pty import and the whole `/terminal/ws` route + `websocket` handler from server.ts (lines 4-5, 26-28, 159-162, 328-380), drop `node-pty`, `@xterm/xterm`, `@xterm/addon-fit` from package.json dependencies, and delete `scripts/fix-pty-perms.ts` + the `postinstall` hook that exists only for it. That is a pure deletion that unbreaks the binary and removes ~150 lines plus three deps. If the terminal is wanted later, the comment already prescribes the architecture (a separate helper process), which will need a dynamic `await import("node-pty")` inside that helper anyway — never a top-level import in the server module.

## 12. web/, node_modules/ and palettes.json are located via `new URL(...).pathname`, which is percent-encoded — the entire dashboard 404s if amux is installed under a path containing a space or non-ASCII character

`src/server/server.ts:53` · **portability** · adversarially verified · originally reported critical, downgraded on verification

**Evidence**

```
server.ts:53 `const webDir = opts.webDir ?? new URL("../../web", import.meta.url).pathname;` (same pattern at line 75 for node_modules and line 88 for palettes.json). Reproduced directly: a module at `/tmp/amux probe space/src/server/t.ts` running that exact expression prints `webDir = /private/tmp/amux%20probe%20space/web` and `existsSync(join(webDir,"index.html")) = false`.
```

**Impact.** Installed into `~/My Projects/amux`, `C:\Users\a b\...`, `~/Développement/`, or macOS's `~/Library/Application Support/...`, every static route fails the `existsSync` check and returns `{"error":"not found"}` 404: `/dashboard` is blank, `/graph/view` is blank, `/palettes.json` 404s so theme.js silently returns at its `catch` and every palette silently reverts to the CSS fallback. The server still starts and the handshake still succeeds, so the failure looks like a broken dashboard rather than a bad install path.

**Fix.** `import { fileURLToPath } from "node:url"` and replace all three with `fileURLToPath(new URL("../../web", import.meta.url))` etc. Three-line change. Add a startup `existsSync(webDir)` check that logs a loud stderr warning, since silently 404-ing static assets is what makes this so hard to diagnose.

## 13. POST /agents writes unvalidated client input straight into agents.yaml and can brick the config

`src/server/server.ts:245` · **security** · adversarially verified

**Evidence**

```
  const { agents } = (await req.json().catch(() => ({}))) as { agents?: AgentConfig[] };
  if (!Array.isArray(agents) || !agents.length) return json({ error: "expected agents[]" }, 400);
  saveAgents(agents);

The only check is 'is a non-empty array'. `validate()` from config.ts is never invoked on the write path — it exists only on the read path. Reproduced by calling `saveAgents([{} as any], path)` on a valid config:

  --- after saveAgents([{}]) ---
  theme: neon
  agents:
    - {}

  reload ERR: /tmp/save.yaml agent[0]: missing 'provider'

On the real path that reload error contains the string `agents.yaml`, so it is then swallowed by surfaceStartupError's regex (see the separate finding) and reported as "no agents configured. Run 'amux-core init'".
```

**Impact.** A malformed request body — a dashboard bug, a partially-filled onboarding form, a stale client after a schema change — permanently corrupts the user's committed config file. There is no backup and no undo. The next boot fails, and the error message the user sees instructs them to run `init`, which overwrites what is left. The asymmetry is the tell: the read path validates carefully and the write path validates nothing, yet the write path is the one facing untrusted input.

**Fix.** Validate before persisting. Export the existing `validate` from config.ts (rename to `validateAgent`) and have `saveAgents` map every entry through it, so all three writers (`POST /agents`, `runInit`, the TUI team picker) get the same guarantee for free — one guard where all callers route through, not three. `saveAgents` then throws on garbage and the handler returns 400 with the real message instead of writing it to disk.

## 14. No migration story at all: an older amux.db crashes newer code at boot with a raw SQLiteError

`src/store/db.ts:90` · **correctness** · adversarially verified · originally reported critical, downgraded on verification

**Evidence**

```
db.ts:11-13 claims: "ponytail: idempotent CREATE TABLE IF NOT EXISTS instead of a versioned migration table — adding a table or column stays a no-op replay." That claim is false. I created a database whose `sessions` table predates the `parent_session_id` and `time_archived` columns, then called `openDb()` on it:

  SQLiteError: no such column: parent_session_id
        at run (bun:sqlite:336:21)
        at openDb (src/store/db.ts:90:6)

`CREATE TABLE IF NOT EXISTS sessions (...)` is a silent no-op against the old table, but the very next statement, `CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_session_id)` (db.ts:29), references a column that does not exist and hard-fails. `PRAGMA user_version` on the live DB reads 0 — there is no version marker to branch on either.
```

**Impact.** Any user who runs amux, then updates to a build that adds a column (which the schema comment explicitly invites: "adding a table or column stays a no-op replay"), gets a dead tool. Boot fails inside `buildEngine`, `surfaceStartupError` prints `amux: no such column: parent_session_id`, and the only recovery is deleting `.amux/amux.db` — which throws away every session transcript AND every undo checkpoint. Post-publish this is unfixable retroactively: v0.0.2 cannot repair a v0.0.1 database it can no longer open.

**Fix.** Before publish, add the smallest thing that makes the promise true. In `openDb`, after `db.exec(PRAGMA ...)` and before `db.exec(SCHEMA)`:

  const v = (db.query("PRAGMA user_version").get() as {user_version:number}).user_version;
  db.exec(SCHEMA);
  if (v < 1) { /* future ALTER TABLEs go here */ db.exec("PRAGMA user_version = 1"); }

and wrap the SCHEMA exec so an index-creation failure on a drifted table is survivable. Cheapest correct alternative given version 0.0.1 has no installed base yet: split SCHEMA into per-statement execs, run each in its own try/catch that logs and continues, and stamp `user_version = 1` now so the next release has a hinge to migrate from. Also correct the comment at db.ts:11-13 — it currently tells the next maintainer a column add is safe when it is not.

## 15. The team picker runs on every launch and cancelling it exits amux — there is no way to reuse an existing agents.yaml

`tui/cmd/amux/main.go:172` · **ux** · adversarially verified · originally reported critical, downgraded on verification

**Evidence**

```
main.go:172-178:
	final, err := tea.NewProgram(wizard.NewPicker(c.client), screenOpts()...).Run()
	if err != nil { fatal(err) }
	if pm, ok := final.(wizard.Picker); !ok || !pm.Completed {
		return // user cancelled the picker
	}

The only exit from the picker other than completion is ctrl+c (picker.go:114-116), which sets `quitting` without `Completed` — so `main` returns and amux exits. `Picker`'s stage list (picker.go:38) is loading|size|provider|key|model|role|desc|orchestrator: there is no "keep the current team" stage, and the existing roster is never even fetched or shown. For a team of 6 that is 1 size answer + 6×(provider, model, role, description) + 1 orchestrator = 26 prompts, every single launch. README.md:51 confirms this is intentional: "`./amux` opens the picker on every launch".
```

**Impact.** Restarting amux — after a crash, after a config change, or just to reconnect to the project you were on five minutes ago — costs 26 keystroked answers, and there is no way to skip it. Pressing esc on the size stage does nothing (`back()` at picker.go:251-280 has no `size` case), and ctrl+c quits the program rather than proceeding to the session. A returning user's only route to their own saved team is to retype it from memory.

**Fix.** When `.amux/agents.yaml` already has agents (they arrive on `GET /session` as `sess.Agents`, and `main` already fetches it at line 163), open the picker on a new first stage that lists the saved roster with two options — "Continue with this team" and "Pick a new team" — defaulting to continue so `enter` launches straight into the session. Make ctrl+c/esc on that stage mean "continue", not "exit amux". Skip the core restart at main.go:180-183 entirely on the continue path, since agents.yaml is unchanged.

## 16. When the core dies the TUI shows a live-looking frame forever and never says anything

`tui/cmd/amux/main.go:90` · **error-handling** · adversarially verified · originally reported critical, downgraded on verification

**Evidence**

```
`streamWithReconnect` (main.go:90-129) consumes every error itself. `err := client.StreamEvents(...)` is examined only to decide whether to retry; nothing is ever pushed onto `events`, and the doc comment at line 88 states `events` "is never closed here". So when the core process dies:
  - `StreamEvents` returns `ErrStreamDisconnected` (client.go:402/439/441)
  - the loop sleeps, retries, gets connection-refused, doubles the backoff to the 15s cap (lines 120-127), forever
  - `waitFor(m.events)` (session.go:185-193) blocks on a channel nobody will ever write to again, so its `errMsg{"event stream closed"}` branch is unreachable
  - `m.status` keeps whatever it last said ("connected", "running") and the header keeps its progress bar

Nothing anywhere calls `cmd.Wait()` on the core process, so the TUI also has no way to observe the child exiting.
```

**Impact.** The core crashes (OOM, an uncaught provider error, a `kill`) and the TUI keeps painting a normal session: agents shown as "working", progress bar frozen mid-bar, status "running". The user waits. The only way to discover the truth is to type a slash command and get "/agents failed: connection refused" — which requires already suspecting something is wrong. Combined with the picker's 26-question relaunch cost, this is the worst possible failure mode for the primary surface.

**Fix.** Give `streamWithReconnect` a `chan<- api.Event`-adjacent status channel, or simply synthesise a status event onto `events` on each transition: emit one on the first failed attempt ("lost the core — reconnecting…") and one on a successful reconnect ("reconnected"). Add a `case statusMsg` in `Update` that writes `m.status` and flips a `connected bool` that `header()` renders as a red dot. Separately, run `go func(){ err := cmd.Wait(); ... }()` in `startCore` and surface "the core exited (status N)" as a terminal error state, since a dead process will never reconnect no matter how long the backoff runs.

## 17. Every startup failure path orphans the spawned Bun core, because fatal() calls os.Exit and skips the deferred stop

`tui/cmd/amux/main.go:151` · **correctness** · adversarially verified

**Evidence**

```
main.go:151-154:
	func fatal(err error) {
		fmt.Fprintln(os.Stderr, "amux:", err)
		os.Exit(1)
	}

main.go:161 registers the only cleanup:
	defer func() { c.stop() }() // closure → stops whichever core is current at exit

`os.Exit` does not run deferred functions. Every subsequent error path calls `fatal` while a core is running: line 165 (`c.client.Session()` failed — "cannot reach core"), line 174 (the picker program failed to run, e.g. not a TTY), line 182 (the restarted core failed), line 185 (the post-restart `Session()` failed).
```

**Impact.** Run `amux` with stdout redirected, or with a terminal Bubbletea can't take, or hit any transient `/session` failure, and the TUI prints one line and exits — leaving a full Bun core running in the background, holding its ephemeral port, its SQLite handle on .amux/amux.db, its file watcher, and any MCP/LSP children it spawned. Repeat the mistake three times and there are three orphaned cores. The user has no idea they exist and no PID to kill, since the port was ephemeral and never printed.

**Fix.** Make `fatal` a method that cleans up, or restructure `main` into `run() error` with `defer c.stop()` and a `main` that does `if err := run(); err != nil { fmt.Fprintln(os.Stderr, "amux:", err); os.Exit(1) }`. The second shape is the standard Go idiom and removes the entire class of bug rather than patching four call sites.

## 18. The core is SIGKILLed with no process group and never reaped, orphaning its MCP/LSP children and leaving a zombie after the picker restart

`tui/cmd/amux/main.go:37` · **correctness** · adversarially verified

**Evidence**

```
main.go:37-41:
	func (c *core) stop() {
		if c != nil && c.cmd != nil && c.cmd.Process != nil {
			_ = c.cmd.Process.Kill()
		}
	}

`Kill()` is SIGKILL — uncatchable, so the core runs no cleanup. `cmd.SysProcAttr` is never set, so no `Setpgid`, so the signal reaches only the direct child. `cmd.Wait()` is never called anywhere in the module, so the killed process stays a zombie until the TUI itself exits. The core demonstrably spawns grandchildren: src/mcp/mcp.ts:38 `client.connect(new StdioClientTransport({command: s.command, args: s.args ?? []}))` and src/lsp/client.ts:94 `spawn(this.command, this.args, {cwd: this.root, ...})`. `grep -rn "SIGTERM|SIGINT|SIGHUP" src` finds no handler in server/main.ts at all.

This fires on the normal happy path, not just on error: main.go:180-183 kills core #1 and starts core #2 on every single launch, right after the picker.
```

**Impact.** Each launch leaks one full set of MCP server processes and any LSP servers core #1 had started, plus a zombie bun process that survives for the whole session. Nothing about this is visible to the user; they accumulate in `ps` across a day of restarts. Because core #1 dies to SIGKILL, it also never flushes or closes its SQLite session store cleanly — every launch leaves the WAL to be recovered by the next process.

**Fix.** Set `cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}` when spawning, then in `stop()` signal the whole group: `syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)`, wait up to ~2s on a `cmd.Wait()` done-channel, and escalate to `syscall.Kill(-pid, syscall.SIGKILL)` only if it hasn't exited. Always call `cmd.Wait()` so the process is reaped. On the core side add a `process.on("SIGTERM")` handler that closes the MCP manager, the LSP registry and the DB before exiting, so the graceful path is actually graceful.

## 19. Core stderr is wired to the TUI's terminal under the alt screen, so runtime errors paint over the UI — and for a failed submit that garbage is the only report

`tui/cmd/amux/main.go:52` · **error-handling** · adversarially verified

**Evidence**

```
main.go:52 `cmd.Stderr = os.Stderr`, plus the forwarder at main.go:71-81 which pushes any post-handshake core *stdout* to stderr too:
		for { l, e := r.ReadString('\n'); if len(l) > 0 { fmt.Fprint(os.Stderr, l) }; ... }

Both Bubbletea programs run with `tea.WithAltScreen()` (main.go:144), so the TUI owns that same tty. The core writes to stderr during a live session — src/server/server.ts:186:
		engine.submit(text, { planOnly: mode === "plan" }).catch((err) => console.error("submit error:", err));

That `.catch` is the *only* handling of a failed submit: the failure is not published to the event hub, so it never reaches the TUI over SSE. `POST /prompt` has already returned 200 by then, so `Client.Prompt` reports success.
```

**Impact.** An orchestrator failure prints a raw Node error (potentially a multi-line stack trace) directly onto the alt screen, corrupting the frame until the next full repaint, with no way for the user to scroll back and read it. Worse, that corrupted text is the entire error report: the prompt was accepted, the UI shows no error, agents just never start. Any core-side `console.error` (MCP unavailable, provider warnings) has the same effect at any moment during a session.

**Fix.** Two parts. In the TUI, stop handing the core the terminal: `cmd.Stderr` should be a log file (`.amux/core.log`) or an `io.Pipe` drained into a ring buffer that a `/logs` command can display, and the stdout forwarder at lines 71-81 should write there too. In the core, publish submit failures onto the event hub as an `agent_event` of type `error` so the TUI can render them in the transcript — `console.error` is not an error-reporting channel when a TUI owns the tty.

## 20. Running the Go TUI from any directory other than a repo checkout fails with a raw module-not-found and a handshake EOF

`tui/cmd/amux/main.go:49` · **ux** · adversarially verified

**Evidence**

```
'''
$ cd /tmp/amux-probe-pkg && amux </dev/null
error: Module not found "src/server/main.ts"
amux: core did not hand shake: EOF
EXIT:1
'''
Source: `entry := envOr("AMUX_CORE_ENTRY", "src/server/main.ts")` (main.go:49), `bunBin := envOr("AMUX_BUN", "bun")` (:50), `cmd := exec.Command(bunBin, "run", entry)` (:51). The error text comes from main.go:64 `fmt.Errorf("core did not hand shake: %w", err)`.
```

**Impact.** The binary README.md:14-16 calls 'the primary, interactive front end … what you run day to day' works only when cwd happens to be a checkout of the amux source tree. A user who copies ./amux onto their PATH — the obvious thing to do with a 10.8 MB self-contained-looking executable — gets two lines of jargon naming a TypeScript file they do not have. It also means the Go TUI cannot be distributed at all: it hard-requires bun AND the source tree AND node_modules.

**Fix.** Resolve the core relative to the TUI binary, not to cwd, and prefer a real executable. In main.go startCore(): `self, _ := os.Executable(); dir := filepath.Dir(self)`; then try, in order, `filepath.Join(dir, "amux-core")` (exec it directly, no bun), then `AMUX_CORE_ENTRY`, then `filepath.Join(dir, "src/server/main.ts")` via bun. On total failure print an actionable message instead of `EOF`: `amux: could not start the core (looked for amux-core next to this binary, and src/server/main.ts under the current directory). Install it with: npm i -g <pkg>`. Also stop passing `bun run` a relative path from cwd — join it to `dir`.

## 21. Hitting the turn cap is reported as success, and the task inherits the previous run's output text

`src/agent/agent.ts:243` · **correctness** · adversarially verified

**Evidence**

```
'''
      }                                   // for-loop over maxTurns falls through here
      if (sessionId) this.store?.setStatus(sessionId, "done");
      this.bus.publish({ agentId: id, type: "done", payload: "(turn cap reached)", time: Date.now() });
      return "done";
'''
and `this.lastText` (line 128) is only ever assigned inside `if (reply.text)` at line 202 — it is never reset at the start of `run()`. The scheduler consumes both: `t.output = runner.output; t.status = outcome === "done" ? "done" : "failed";` (src/orchestrator/scheduler.ts:217-218).
```

**Impact.** An agent that spends all 12 turns calling tools without ever finishing is marked `done`, its dependents are released with whatever `t.output` holds, the review gate (if any) reviews stale text, and the final integrate pass reports the project as complete. Worse: if the capped run emitted no text at all, `runner.output` is still the last text from a *previous* run of that same agent — so task `t2` can be recorded with task `t1`'s output verbatim. The only signal is a `done` event whose payload string differs, which nothing downstream parses.

**Fix.** Add `"capped"` to `RunOutcome` (or reuse `"failed"`) and return it at agent.ts:245 with `this.lastError = "turn cap reached without a final answer"`, so scheduler.ts:218 marks the task failed and `attemptReplan` gets a real reason. Independently, reset `this.lastText = ""` at the top of `run()` (after line 176) so a run can never report a stale predecessor's output.

## 22. The approval-time `diff` is injected into the live ToolCall and echoed back to the model forever on OpenAI-compatible providers

`src/agent/agent.ts:437` · **perf** · adversarially verified

**Evidence**

```
'''
    if (call.name === "write_file") {
      call.input.diff = writeFileDiff(before ?? null, String(call.input.content ?? ""));
    }
'''
`writeFileDiff` (src/tools/tools.ts:100-104) builds an all-minus copy of the prior file plus an all-plus copy of the new content. That same mutated `call` object is then pushed into `turns` at agent.ts:240, and src/providers/openai.ts:53 serializes it verbatim: `function: { name: c.name, arguments: JSON.stringify(c.input) }`. Anthropic (anthropic.ts:44) and Gemini escape this because they replay `Turn.raw` instead; every OpenAI-compatible provider — which per src/providers/catalog.ts is the majority of the catalog — does not.
```

**Impact.** Overwriting a 1,500-line file sends that file three times in a single assistant turn (`content`, plus `diff`'s minus half and plus half) and re-sends all three on every subsequent iteration of the loop, and on every resumed run (the diff is also persisted via `toParts`, session-store.ts:47). A handful of write_file calls will drive a task into the 95% compaction path — and therefore into an extra billed summarization call — purely from a field the model never produced. It also shows the model a `diff` argument in its own tool-call history that is not in the tool's JSON schema, which invites it to start emitting one.

**Fix.** Keep the diff off the model-visible payload. Compute it into a separate variable and hand it to the approver only — change `this.approve(call.name, call.input, dangerous)` (agent.ts:448) to pass `{ ...call.input, diff }`, and drop the two mutations at lines 434 and 437. `ApprovalQueue.answer`'s `edited` merge (approval.ts:67) already writes back into whatever object it was given, so pass the same shallow copy and merge the result into `call.input` after approval, minus `diff`.

## 23. Lock keys are raw model-supplied path strings, so two agents editing the same file often take different locks

`src/agent/agent.ts:460` · **correctness** · adversarially verified

**Evidence**

```
`const lockPath = WRITE_TOOLS.has(sandboxCall.tool) && "path" in sandboxCall ? sandboxCall.path : ...` and `await this.locks.acquire(lockPath, id)` (agent.ts:460-462). `toSandboxCall` (tools.ts:165-179) does no normalization — `path: String(i.path ?? "")` is verbatim model output. The normalizing helper `safePath(root, p)` (tools.ts:19, uses node `resolve`) IS applied three lines later for the undo checkpoint (agent.ts:467) but NOT for the lock key.
```

**Impact.** Agent A calls write_file with `src/api.ts`; agent B calls edit with `./src/api.ts` (or `src/../src/api.ts`, or an absolute path — all of which `safePath` accepts and resolves to the same file). Three distinct Map keys, zero mutual exclusion, interleaved writes to the same file. This is the exact scenario the LockRegistry exists to prevent, and models routinely vary path spelling between turns.

**Fix.** One-line fix at agent.ts:461 — key the lock on the resolved path: `? safePath(this.root, sandboxCall.path)`. `safePath` throws on escape, so wrap or hoist the existing escape handling; `runTool` calls it again downstream so the double-resolve is idempotent. Note this also makes the lock key worktree-aware, which matters because `setRoot` repoints the root mid-session (engine.ts:190).

## 24. An empty provider reply is reported to the user as a successfully completed task

`src/agent/agent.ts:227` · **correctness** · adversarially verified

**Evidence**

```
`agent.ts:227-233`:
'''ts
if (reply.toolCalls.length === 0) {
  if (reply.text) this.push(turns, {role:"assistant", text: reply.text, ...});
  if (sessionId) this.store?.setStatus(sessionId, "done");
  this.bus.publish({ agentId: id, type: "done", payload: "", time: Date.now() });
  return "done";
}
'''
Every provider can produce `{text:"", toolCalls:[]}` without throwing. Gemini: `gemini.ts:97` reads `res.candidates?.[0]?.content?.parts ?? []` and never inspects `finishReason` or `promptFeedback.blockReason`, so a SAFETY/RECITATION block yields an empty parts array. OpenAI: `openai.ts:80` `res.choices[0]?.message` with `?.` throughout, so an empty `choices` array yields `text: ""`. All three ignore truncation entirely — `msg.stop_reason` is never read in `anthropic.ts`, `chunk.choices[0].finish_reason` is never read in `openai.ts` (streaming loop, :97-110), `finishReason` is never read in `gemini.ts`.
```

**Impact.** A Gemini safety block, an OpenAI content filter, or a reply truncated at `max_tokens` all present identically to a genuine completion: the task flips to `done`, the orchestrator marks it satisfied, dependent tasks consume `t.output` (which is empty or half a sentence), and no warning is ever published. `isExhaustion` never fires because nothing was thrown. This is the worst failure mode in the area because it is silent and it corrupts downstream work.

**Fix.** Add a stop-reason field to `ProviderReply` (`provider.ts:75-81`), populate it in all three providers (`msg.stop_reason`, `chunk.choices[0]?.finish_reason`, `chunk.candidates[0]?.finishReason`), and in `agent.ts` before the `toolCalls.length === 0` branch: if the reply is empty *or* the stop reason is not a natural stop, publish a `warning` and return `"failed"` so the scheduler's replan path engages. Minimum viable version, one guard: `if (!reply.text && !reply.toolCalls.length) { publish warning; return "failed"; }`.

## 25. No SIGINT/SIGTERM handling in the headless run path, and `Engine.close()` / `McpManager.close()` are dead code — LSP and MCP subprocesses are never reaped

`src/cli.ts:123` · **state-management** · adversarially verified · originally reported critical, downgraded on verification

**Evidence**

```
$ grep -rn "engine.close\|mcp.close\|mcp?.close" src/ tui/ web/
(no matches)

src/engine.ts:343  close(): void {
src/engine.ts:344    this.watcher?.close();
src/engine.ts:345    this.lsp?.close();

src/mcp/mcp.ts:79  async close(): Promise<void> {
src/mcp/mcp.ts:80    for (const c of this.clients.values()) await c.close();

SIGINT is registered in exactly two places, both of which only stop the HTTP server:
src/cli.ts:87   process.on("SIGINT", () => { server.stop(); process.exit(0); });
src/cli.ts:106  process.on("SIGINT", () => { server.stop(); process.exit(0); });

The headless block (cli.ts:123-161) — the path a scripted `amux-core "task"` takes — registers nothing.

Subprocess owners:
src/lsp/client.ts:94   spawn(this.command, this.args, { cwd: this.root, stdio: ["pipe","pipe","pipe"] })
src/mcp/mcp.ts:38      client.connect(new StdioClientTransport({ command: s.command, args: s.args ?? [] }))

And the only production shutdown is a SIGKILL from Go:
tui/cmd/amux/main.go:38  func (c *core) stop() { ... _ = c.cmd.Process.Kill() }
```

**Impact.** Ctrl-C during `amux-core "refactor the auth module"` with an `lsp:` block and `mcpServers:` in agents.yaml: the bun process dies, `Engine.close()` never runs, `LspRegistry.close()` never kills the language-server children, `McpManager.close()` never closes the stdio MCP clients, and the file watcher is never released. Worse in the TUI flow: `core.stop()` sends SIGKILL to the bun pid only (Go's Process.Kill targets one pid, not the process group), so every LSP server and MCP server is reparented to init and survives. Quit and relaunch the TUI five times and you have five orphaned `typescript-language-server` processes plus five orphaned MCP servers holding their own file handles and, in the MCP case, whatever remote connections they own.

**Fix.** In src/cli.ts, hoist one shutdown routine and register it on both signals in every long-lived path: `const shutdown = () => { engine.close(); engine.mcp?.close(); server?.stop(); process.exit(0); }; process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);` — including in the headless block at line 123 (where `engine` is in scope from line 137). Add the same to `src/server/main.ts`'s `import.meta.main` block, since that is the entry the Go TUI actually spawns. On the Go side, change `cmd.Process.Kill()` in tui/cmd/amux/main.go:38 to signal the whole group: set `cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}` before Start and kill with `syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)`, falling back to Kill after a short grace period so the TS handler gets a chance to run.

## 26. `--help`, `-h` and `--version` are not implemented; `-h` is submitted to a paid model as task text

`src/cli.ts:125` · **ux** · adversarially verified

**Evidence**

```
$ bun src/cli.ts -h            # in an empty dir
amux: no agents configured. Run 'amux-core init' to set up providers and roles.
$ bun src/cli.ts --help
amux-core: no task given.
$ bun src/cli.ts --version
amux-core: no task given.

src/cli.ts:125  const goal = resume ? "" : args.filter((a) => !a.startsWith("--")).join(" ").trim();

`-h` does not start with "--", so it survives the filter and becomes goal === "-h", which reaches buildEngine at line 139 and would be submitted at line 154. `--help`/`--version` are filtered out, leaving goal === "", which lands in the no-task banner at 128-133 and exits 0 — an accident, not a handler. No version string is printed anywhere in the file, and package.json's version is never read.
```

**Impact.** With a configured `.amux/agents.yaml`, `amux-core -h` starts the engine and sends the literal string `-h` to the orchestrator model. The user gets a billed LLM run, agent file writes, and possibly shell execution, from what they intended as a help request. `amux-core --version` prints a usage blurb with no version — unusable for bug reports or for a package manager's smoke test.

**Fix.** Add an explicit branch above the `keys` block in src/cli.ts (~line 39): `if (args[0] === "help" || args.includes("--help") || args.includes("-h")) { console.log(USAGE); process.exit(0); }` and `if (args.includes("--version") || args.includes("-v")) { console.log(require("../package.json").version); process.exit(0); }` (or a build-time constant, since the compiled binary won't have package.json alongside it). Promote the header comment on lines 3-15 into that `USAGE` constant so the help text and the source comment can't drift.

## 27. Unknown subcommands and misspelled flags are silently accepted — typos become billable agent runs

`src/cli.ts:123` · **ux** · adversarially verified

**Evidence**

```
$ bun src/cli.ts stauts        # typo for `status`
amux: no agents configured. Run 'amux-core init' to set up providers and roles.   # -> it reached buildEngine

src/cli.ts:123  if (args[0] !== "serve" && !args.includes("--web") && args[0] !== "init") {
src/cli.ts:125    const goal = ... args.filter((a) => !a.startsWith("--")).join(" ").trim();

There is no allow-list of flags anywhere in the file. `--auto` is only ever read via `args.includes("--auto")` (line 182) and `--worktree` via `args.includes("--worktree")` (line 186); anything else beginning with `--` is discarded by the line-125 filter without comment.
```

**Impact.** Two distinct failures. (1) `amux-core srve` or `amux-core stauts` submits the typo as a prompt: real API cost, and with `auto: true` in agents.yaml the agent may start writing files based on a one-word nonsense goal. (2) `amux-core --wortree "big refactor"` runs with worktree isolation OFF while the user believes their writes are sandboxed — the flag is silently dropped and the agent edits the real working tree directly. Same for `--atuo`, which silently leaves approvals gated (or, in a script with no TTY, hangs).

**Fix.** Validate before dispatch in src/cli.ts. Immediately after line 33: `const KNOWN_FLAGS = new Set(["--auto","--worktree","--web","--help","-h","--version","-v"]); for (const a of args) if (a.startsWith("-") && !KNOWN_FLAGS.has(a) && !a.startsWith("--port=")) die(\`unknown flag '${a}'\`);` Separately, require an explicit marker for prompts or an allow-list for subcommands: if `args[0]` matches `/^[a-z][a-z0-9-]*$/` and is not one of the known subcommands and there is only one argument, `die` with `unknown command '<x>' — did you mean a task? quote it: amux-core "<x>"`.

## 28. `--web` silently disables the approval gate for shell and write_file, and ignores `--auto`, `--worktree` and `--port=`

`src/cli.ts:101` · **security** · adversarially verified

**Evidence**

```
src/cli.ts:100  // The web dashboard is read-only (no approver in this process), so run headless/auto-approve.
src/cli.ts:101  const { engine, server } = await serveMain({ interactive: false });

src/engine.ts:27   interactive?: boolean; // gate write_file/shell behind approvals (off for one-shot/scripting)
src/engine.ts:118  approve: opts.interactive ? (tool, input, forceAsk) => this.approvals.request(...) : undefined,

Compare the `serve` branch, which forwards them:
src/cli.ts:85  await serveMain({ port: ..., auto: args.includes("--auto"), worktree: args.includes("--worktree") });

The `--web` call site passes only `interactive`. `opts.port`, `opts.auto` and `opts.worktree` are all in serveMain's signature (server/main.ts:21) and all left undefined.
```

**Impact.** `amux-core --web "clean up the repo"` runs every agent with `approve: undefined`, i.e. no human gate on `shell` or `write_file` — the same posture as `--auto` — but the user never typed `--auto`. A user who *does* type `amux-core --web --worktree "risky refactor"` gets no worktree isolation (the flag is dropped) AND no approval gate, so destructive shell commands run unsandboxed against the real tree. `--port=8080 --web` also silently binds a random port.

**Fix.** In src/cli.ts:101, forward the flags exactly as the `serve` branch does: `await serveMain({ port: portArg ? Number(portArg.slice(7)) : undefined, interactive: false, auto: args.includes("--auto"), worktree: args.includes("--worktree") })`. Then make the escalation explicit rather than implicit — print a stderr line before opening the browser: `amux: --web runs without approval gates (no approver in this process); use --worktree to isolate writes.` Hoist the `--port=` parse into a single `parsePort(args)` helper shared by the `serve` branch, the `--web` branch, and server/main.ts:61.

## 29. Headless runs always `process.exit(0)`, even when every task failed — CI and scripts cannot detect failure

`src/cli.ts:160` · **correctness** · adversarially verified

**Evidence**

```
src/cli.ts:154-160
  if (goal) await engine.submit(goal);
  else if (resume) await engine.resume();
  unsubscribe();

  console.log("\n--- tasks ---");
  for (const t of engine.orch.all) console.log(`${t.id} [${t.status}] ${t.assignedTo ?? "-"}: ${t.description}`);
  process.exit(0);

The loop on line 159 explicitly prints `t.status`, which the codebase defines to include `"failed"` (see TASK_GLYPH at registry.ts:260: `{ done: "●", in_progress: "◐", failed: "✖", pending: "○" }`), and then exits 0 regardless. `die()` (line 36) is the only exit-1 path in the file, and it is never reached from here.
```

**Impact.** The header comment on line 5 sells this binary as being 'for scripting, automation'. A CI step `amux-core "fix the failing test" && ./deploy.sh` deploys even when the agent failed every task, because the exit status is 0. Same for `resume`. A shell script has no machine-readable signal at all — it would have to grep the `--- tasks ---` block for the literal string `[failed]`.

**Fix.** Replace src/cli.ts:160 with a status-derived code: `const failed = engine.orch.all.filter((t) => t.status === "failed").length; const unfinished = engine.orch.all.filter((t) => t.status !== "done").length; process.exit(failed ? 1 : unfinished ? 2 : 0);` — 1 = something failed, 2 = ran out of turns / still pending, 0 = clean. Document the three codes in the header comment and in README, since scripts will depend on them.

## 30. A malformed YAML frontmatter in any `.amux/commands/*.md` file throws out of the `CommandRegistry` constructor and prevents the core server from starting

`src/commands/registry.ts:279` · **error-handling** · adversarially verified

**Evidence**

```
src/commands/registry.ts:277-279
  const raw = readFileSync(join(dir, entry.name), "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const fm = (m ? (parse(m[1]!) ?? {}) : {}) as Record<string, unknown>;   // <- parse() throws

Reproduced with a file containing `name: [oops`:
THREW: YAMLParseError: Flow sequence in block collection must be sufficiently indented and end with a ] at line 2, column 1

The throw propagates through the default parameter:
registry.ts:300  constructor(commands: Command[] = [...BUILTIN_COMMANDS, ...loadCommands()]) {
server.ts:54     const commands = opts.commands ?? new CommandRegistry();

Note the asymmetry: command *execution* is fully guarded (registry.ts:329-333 try/catch), command *loading* is not. `readFileSync` on line 277 is likewise unguarded (a dangling symlink or a permissions error throws the same way).
```

**Impact.** One user hand-editing `.amux/commands/review.md` and leaving a stray `[` takes down the whole product: `startServer` throws, `serveMain` throws, and the user sees `amux: Flow sequence in block collection must be sufficiently indented…` — a YAML parser error with a line number but no filename, from a CLI they were not using to edit YAML. The TUI shows `core did not hand shake`. There is no path from that message to 'delete the bad file in .amux/commands/'.

**Fix.** Wrap the per-file body of the `loadCommands` loop in try/catch and skip the bad file with a named warning: `try { ... } catch (err) { console.error(\`amux: skipping ${entry.name}: ${err instanceof Error ? err.message : err}\`); continue; }`. Same treatment for `readFileSync`. One bad command file should cost the user that one command, not the session.

## 31. Headless mode silently downgrades every `ask` to `allow` — `--auto` is not required to run unattended writes and shells

`src/engine.ts:118` · **security** · adversarially verified

**Evidence**

```
'''
        approve: opts.interactive ? (tool, input, forceAsk) => this.approvals.request(c.id, tool, input, forceAsk) : undefined,
'''
and the consumer: `if (this.approve && mustAsk && !(await this.approve(...)))` (agent.ts:448) — with `approve` undefined the whole guard is skipped. `cli.ts:139` builds the one-shot engine as `buildEngine(false)` with the comment `// headless: auto-approve gated tools, no interactive approver`, and `cli.ts:101` does the same for `--web`.
```

**Impact.** `amux-core "refactor the auth module"` runs every write_file, edit and shell call — including dangerous ones flagged by DANGEROUS_PATTERNS, since `forceAsk` is also inert without an approver — with no prompt and no `--auto` flag typed by the user. The only surviving control is an explicit `deny` in agents.yaml, which the first finding shows is bypassable with `./`-prefixed paths. The `--auto` flag is documented in cli.ts:8 as the dangerous mode, which is misleading: the default headless invocation is already more permissive than `--auto` in interactive mode (which at least still prompts for dangerous shell).

**Fix.** Make the degradation explicit rather than silent. In headless mode supply an approver that denies anything resolving to `ask` unless `--auto`/`auto: true` is set: `approve: opts.interactive ? queueApprove : async () => Boolean(opts.auto)`. That makes `amux-core "task"` safe by default and `amux-core "task" --auto` mean what its help text says. Update the comments at cli.ts:139 and cli.ts:100-101 accordingly.

## 32. The peer-review gate fails OPEN under concurrency — a reviewer running its own task corrupts the verdict

`src/orchestrator/scheduler.ts:145` · **correctness** · adversarially verified · originally reported critical, downgraded on verification

**Evidence**

```
runReviewGate calls `const outcome = await reviewer.run(...)` then `const feedback = reviewer.output;` (scheduler.ts:139-145). `Agent.output` is a getter over the single shared field `this.lastText` (agent.ts:155-157), which `run()` overwrites on EVERY provider reply inside its tool loop (agent.ts:201-204). The reviewer is invoked *outside* the `running` per-agent slot map (scheduler.ts:248,265), so an agent that is both a DAG task owner and someone's reviewer runs two loops on one Agent instance simultaneously. The approval test is fail-open: `const approved = outcome === "done" && !/VERDICT:\s*changes_requested/i.test(feedback);` — anything that isn't literally the rejection token is an approval. I reproduced this with a probe against the real scheduler: reviewer 'qa' returns `VERDICT: changes_requested — this is broken` from its review loop, while its own 3-turn task loop overwrites qa.output between turns. Result printed: `t1 (fe) status: done`. The explicit rejection was silently converted into an approval.
```

**Impact.** agents.yaml with `reviewer: qa` where qa also owns a task in the same plan. The two run concurrently. qa reviews t1, says changes_requested, but qa's own task loop writes lastText last. `feedback` is qa's task text, the regex misses, `emit review/approved` fires, the message bus posts qa's unrelated task output as 'review of t1', and broken work is marked done. The gate silently stops gating exactly when the team is busiest.

**Fix.** Make `Agent.run` return its own text instead of reading it off shared state, or give runReviewGate a dedicated non-shared entry point. Minimal fix in agent.ts: change `RunOutcome` to `{outcome, text, error}` (or add `runFor(prompt, opts): Promise<{outcome: RunOutcome; text: string; error: string}>` that keeps a local `lastText`), then in scheduler.ts:145 use the returned text rather than `reviewer.output`, and likewise at lines 154 and 217 for `runner.output`. Second, invert the approval test so it is fail-CLOSED: require `/VERDICT:\s*approve/i.test(feedback)` — a missing or garbled verdict must not approve. Third, either claim the reviewer's slot in `running` for the duration of the review, or document that reviewers must not own tasks.

## 33. There is no cross-provider failover on the shipped code path — the only failover implementation is dead code

`src/orchestrator/scheduler.ts:210` · **correctness** · adversarially verified

**Evidence**

```
The DAG retry loop reuses the same agent: `outcome = await runner.run(prompt, { taskId: t.id })` inside `while (outcome === "exhausted" && ...)` (scheduler.ts:210-215) — `runner` is never reassigned. The actual failover logic (`Orchestrator.requeue` + the same-agent exclusion in `claimTask`, orchestrator.ts:31-55) is only exercised by `worker` (runner.ts:29-47), exported as `runWorker` at runner.ts:129. `grep -rn runWorker src tui` returns three hits: the export, failover.test.ts:35, orchestrator.test.ts:44. Nothing in the runtime calls it. The five tests in failover.test.ts therefore certify a code path that never runs. Worse, the retry publishes `type: "failover"` (scheduler.ts:212) with the text 'exhausted — retry N/3', so the UI labels a same-provider retry as a failover.
```

**Impact.** A user configures Claude + Gemini + GLM specifically so one provider's rate limit doesn't stall the run — the headline reason to run multi-provider. Anthropic 429s; the scheduler sleeps 500ms and asks Anthropic again, three times, then fails the task and cascades to every dependent. The idle Gemini agent is never tried. The bus says 'failover', so the user believes it was.

**Fix.** In the exhausted-retry loop, on attempt >= 2 pick a different idle agent: `const alt = agents.find(a => a.config.id !== runner.config.id && !running.has(a.config.id)); if (alt) { runner = alt; t.role = alt.config.id; t.assignedTo = alt.config.id; }` — `runner` is already `let` (scheduler.ts:185) and the `startRole` capture at line 269 already handles a mid-flight role change. Then either delete runner.ts:29-47 + runner.ts:129 + failover.test.ts, or rewrite failover.test.ts against `schedule`. Also relabel the same-agent retry as `type: "warning"` so 'failover' means failover.

## 34. Permission patterns match the raw model-supplied path — `./x` bypasses a deny, and `a/../x` escapes an allow

`src/permissions.ts:39` · **security** · adversarially verified · originally reported critical, downgraded on verification

**Evidence**

```
`subject()` returns `typeof input.path === "string" ? input.path : ""` with no normalization, and `matches()` feeds it straight to `Bun.Glob`. Verified by executing the real module:

  resolve([undefined, {write_file:{"secret*":"deny"}}, AUTO_RULES, DEFAULT_RULES], "write_file", {path:"secret.txt"})    -> deny
  resolve(... same layers ..., {path:"./secret.txt"})                                                                 -> allow
  resolve(... same layers ..., {path:"a/../secret.txt"})                                                              -> allow

and the inverse direction:

  new Bun.Glob("src/**").match("src/../.amux/agents.yaml")  -> true

`safePath` (src/tools/tools.ts:19) resolves the path at execution time, so all three write to exactly the same file the deny was meant to protect.
```

**Impact.** A project that writes `permissions: { write_file: { "secret*": deny } }` and runs with `--auto` (or any blanket allow) is not protected: the model writing `./secret.txt` gets `allow` and the file is overwritten with no prompt and no error. Symmetrically, an agent granted `write_file: { "src/**": allow }` can silently rewrite `src/../.amux/agents.yaml` — its own permission policy, agent roster and `auto:` flag — with no approval, because the glob matches and safePath permits it (the target is inside the root). The same gap applies to approval scopes: `answer(true, "path")` on `src/components/auth/Login.tsx` grants `src/components/auth/**`, which matches `src/components/auth/../../../.amux/agents.yaml`.

**Fix.** Normalize the subject before matching. One line in src/permissions.ts:39 — `import { normalize } from "node:path"` and `return typeof input.path === "string" ? normalize(input.path) : ""`. `normalize("./secret.txt") === "secret.txt"` and `normalize("src/../.amux/agents.yaml") === ".amux/agents.yaml"`, which fixes both directions at once. Apply the same normalization in `ApprovalQueue.isAllowed` (src/approval.ts:38) and to the directory computed in `answer()` (src/approval.ts:70). Add the three cases above to permissions.test.ts.

## 35. `max_tokens: 16000` and `thinking: {type:"adaptive"}` are hard-coded and sent to third-party Anthropic-compatible endpoints

`src/providers/anthropic.ts:64` · **correctness** · adversarially verified

**Evidence**

```
`anthropic.ts:62-66`:
'''ts
const params: Anthropic.MessageCreateParamsNonStreaming = {
  model: this.model,
  max_tokens: 16000,
  thinking: { type: "adaptive" },   // Anthropic-proprietary
'''
No model or provider check gates either value. `factory.ts:23-24` routes **every** `client: "anthropic"` catalog entry through this class with a custom `baseURL`, and the catalog ships one such third party: `catalog.generated.ts:63-69` — `"minimax": { client: "anthropic", baseURL: "https://api.minimax.io/anthropic/v1", models: ["MiniMax-M2", … "MiniMax-M3"] }`. The constructor comment at `anthropic.ts:24` acknowledges this: "set for Anthropic-format providers other than Anthropic itself".
```

**Impact.** MiniMax's Anthropic-compat shim receives `thinking: {type:"adaptive"}`, a parameter that only Anthropic's own API defines. Strict shims reject unknown top-level params with a 400 on the very first call; permissive ones drop it, at which point the `Turn.raw` replay in `anthropic.ts:44` is round-tripping content blocks the endpoint never promised to accept. The fixed `max_tokens: 16000` compounds it: any Anthropic-compatible model whose output cap is lower (4096/8192 is common outside Anthropic) 400s on every request, and the error surfaces only as whatever the shim's body says.

**Fix.** Gate both on the entry being real Anthropic. Pass a flag from the factory (`baseURL === undefined` already distinguishes them) and spread conditionally: `...(isNativeAnthropic ? { thinking: { type: "adaptive" } } : {})`. Move `max_tokens` onto `CatalogEntry` as an optional `maxOutput` with a conservative default (models.dev already publishes `limit.output` per model — gen-catalog can emit it for free).

## 36. Two shipped providers have an unresolved `${…}` shell template baked into their baseURL

`src/providers/catalog.generated.ts:31` · **correctness** · adversarially verified

**Evidence**

```
'''
baseURL: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",  // :31
baseURL: "https://${DATABRICKS_HOST}/ai-gateway/mlflow/v1",                                // :150
'''
These are JSON string literals emitted by `gen-catalog.ts:111` (`const baseURL = p.api ? ... JSON.stringify(p.api)`), copied verbatim from models.dev's `api` field. Nothing in the codebase performs substitution — grepping `src/` for `${` interpolation of catalog baseURLs returns nothing.
```

**Impact.** Selecting Databricks resolves DNS for the literal hostname `${databricks_host}` and every request fails with an opaque network error that names no provider and suggests no remedy. Cloudflare's path segment is literally `accounts/${CLOUDFLARE_ACCOUNT_ID}/` and 404s. Both providers are 100% non-functional yet appear in the picker as ordinary choices.

**Fix.** Cheapest correct fix: skip them at generation time — in `gen-catalog.ts` after the `if (!p.api)` guard add `if (p.api.includes("${")) { skipped++; continue; }`, and drop `databricks` / `cloudflare-workers-ai` from `ALLOW_IDS` until amux grows per-provider URL templating. Add `expect(e.baseURL ?? "").not.toContain("${")` to the well-formed test in `catalog.test.ts`.

## 37. GeminiProvider gets zero HTTP retries and zero timeout — and Gemini is the shipped default

`src/providers/gemini.ts:11` · **error-handling** · adversarially verified

**Evidence**

```
`gemini.ts:11` is `this.client = new GoogleGenAI({ apiKey })` — no `httpOptions`. The SDK's own transport, `node_modules/@google/genai/dist/node/index.mjs:13950-13955`:
'''js
async apiCall(url, requestInit) {
  if (!this.clientOptions.httpOptions || !this.clientOptions.httpOptions.retryOptions) {
    return fetch(url, requestInit);   // <- bare fetch, no retries, no signal
  }
'''
By contrast `@anthropic-ai/sdk` documents `maxRetries=2` as its default (`node_modules/@anthropic-ai/sdk/client.d.ts:205`) and `openai` exposes the same option, and `anthropic.ts:31` / `openai.ts:29` both leave the default in place. `.amux/agents.yaml` ships `provider: google, model: gemini-flash-latest`.
```

**Impact.** A single transient Gemini 503/429 — routine on Flash during peak — throws straight out of `send()`. `isExhaustion` (agent.ts:56-68) catches it and the scheduler retries the **whole task** from turn zero (`scheduler.ts:210-215`), re-billing every tool call the agent had already made. On Anthropic or OpenAI the same blip is absorbed silently at the HTTP layer. Separately, with no timeout anywhere, a hung Gemini connection hangs that agent forever: there is no `AbortSignal` in `Provider.send`'s signature and no `signal` passed to any SDK — grepping `src/providers/` and `src/agent/agent.ts` for `abort|signal|AbortSignal` returns nothing, so `/cancel` cannot interrupt an in-flight model call.

**Fix.** One line in `gemini.ts:11`: `new GoogleGenAI({ apiKey, httpOptions: { timeout: 120_000, retryOptions: { attempts: 3 } } })`. Separately add `timeout` to the Anthropic and OpenAI constructors so all three agree, since both SDKs default to 10 minutes × 2 retries = a 30-minute worst case per turn.

## 38. A corrupt `.amux/session.json` throws a raw SyntaxError out of `loadTasks`, bricking both `resume` and server startup

`src/session.ts:18` · **error-handling** · adversarially verified

**Evidence**

```
src/session.ts:16-20
  export function loadTasks(path = DEFAULT): Task[] {
    if (!existsSync(path)) return [];
    const data = JSON.parse(readFileSync(path, "utf8")) as { tasks?: Task[] };   // <- unguarded
    return Array.isArray(data.tasks) ? data.tasks : [];
  }

Reproduced:
$ echo '{ broken json' > .amux/session.json
$ bun -e 'import {loadTasks} from ".../session.ts"; loadTasks(".amux/session.json")'
THREW: SyntaxError SyntaxError: JSON Parse error: Expected '}'

Call sites: src/cli.ts:144 (`resume`, completely unguarded) and src/server/main.ts:52 (`engine.orch.load(loadTasks())`, inside serveMain).

Contrast with the auth store, which handles exactly this case deliberately — src/auth/auth-store.ts:29-31: `catch { // A corrupt store shouldn't brick the CLI — treat as empty and let the next write heal it. return []; }`
```

**Impact.** `.amux/session.json` is written by a bare non-atomic `writeFileSync` (session.ts:13) from `saveTasks`, so a crash or SIGKILL mid-write truncates it. After that: `amux-core resume` throws an unhandled SyntaxError with a full stack trace at line 144, and `amux-core serve` / `bun run src/server/main.ts` (the TUI's entry) dies during boot — surfaceStartupError doesn't match `/ENOENT|agents\.yaml/`, so the user sees `amux: JSON Parse error: Expected '}'` with no filename. The TUI then reports `core did not hand shake` (tui/cmd/amux/main.go:62) and the product is unusable until the user finds and deletes a file nothing told them about.

**Fix.** Apply the auth-store's own pattern in src/session.ts: wrap the parse — `let data; try { data = JSON.parse(readFileSync(path, "utf8")); } catch { console.error(\`amux: ignoring unreadable ${path}\`); return []; }`. Also make the write atomic in `saveTasks`: write to `path + ".tmp"` then `renameSync` — three lines, and it removes the failure mode rather than only handling it.

## 39. One approved `shell` call exfiltrates every stored provider credential and escapes the path jail entirely

`src/tools/tools.ts:34` · **security** · adversarially verified

**Evidence**

```
`spawn(command, args, { cwd: root })` inherits the full `process.env` (no `env` option) and the jail is only `cwd`. The header comment claims "spawn (never exec/shell:true) with args as an array → no shell metacharacter injection. cwd pinned to root; there is no shell to `cd` out of." But `{command:"bash", args:["-c", "..."]}` is a shell, and `{command:"cat", args:["../../../.ssh/id_rsa"]}` needs no shell at all. Meanwhile src/auth/auth-store.ts:39 writes raw API keys to disk in plaintext: `writeFileSync(path, JSON.stringify({ credentials: creds }, null, 2), { mode: 0o600 })` at `~/.config/amux/auth.json`.
```

**Impact.** An agent with `shell` allowed (the default `allowedTools` offered by `amux-core init`, cli.ts:253) can run `cat ~/.config/amux/auth.json` or `env` and pull every provider API key and OAuth token into its own conversation — which is then sent to whichever LLM provider that agent is configured against, persisted into `.amux/amux.db`, and rendered in the TUI/dashboard event feed. In headless mode (`amux-core "task"`) there is no approval prompt at all (see the headless finding below), so this needs no user interaction.

**Fix.** Two changes, both small. (1) Pass an explicit allowlisted env to spawn — `{ cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG } }` — so provider keys are never in the child's environment. (2) Correct the comment at tools.ts:32-33 to state the actual boundary: the shell tool is deliberately *not* path-jailed and can invoke an interpreter, so `shell` must be treated as full-machine access in the docs and in the `init` wizard's default tool list. Consider making `shell` opt-in rather than a default in cli.ts:253.

## 40. The maintainer's personal `.amux/agents.yaml` is committed, so cloning the repo and typing any task immediately runs unattended shell-capable agents against real, billable Gemini models

`.amux/agents.yaml:1` · **security**

**Evidence**

```
`git ls-files .amux/` returns exactly one path: `.amux/agents.yaml`. The committed version configures two `provider: google` agents (frontend-designer / backend-engineer, gemini-flash-lite-latest and gemini-flash-latest) each with `allowedTools: [read_file, write_file, edit, shell]`, plus `theme: hazard tape`.\n\nOn the fresh clone, with GEMINI_API_KEY / GOOGLE_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY all explicitly unset, `bun run src/cli.ts "say hi"` ran anyway (resolving credentials from the global `~/.config/amux/auth.json`) and within seconds produced:\n'''\n[backend-engineer] thought: planning: say hi\n[backend-engineer] tool_call: shell {"command":"git status"}\n[backend-engineer] tool_call: shell {"args":["-la"],"command":"ls"}\n[backend-engineer] tool_call: read_file {"path":"package.json"}\n[backend-engineer] tool_call: shell {"command":"ls","args":["src/server"]}\n'''\nNo confirmation, no approval prompt (headless downgrades `ask` to `allow`), no cost warning, no `--auto` required.
```

**Impact.** Anyone who has ever run `amux-core auth login` for any project inherits a working, spending, shell-executing two-agent team the instant they clone this repo — including the auditor who just wanted to read the code. Because the file is tracked, `git pull` also silently overwrites a user's own team config with the maintainer's whenever it changes upstream (it has already changed once in the working tree: frontend-designer/backend-engineer → a/b). On a published package the same file lands in the tarball.

**Fix.** Add `.amux/agents.yaml` to `.gitignore` (the directory's other three artefacts — session.json, amux.db*, reports/ — are already ignored; this is the odd one out) and `git rm --cached .amux/agents.yaml`. Ship a committed `.amux/agents.example.yaml` instead, and have `loadAgents()` produce a 'no team configured — run `amux-core init` or `./amux`' error rather than silently running someone else's roster.

## 41. README.md documents `/usage` and `/graph` as things they are not, and omits eight commands that exist

`README.md:174` · **ux**

**Evidence**

```
README:174 — "type `/usage` for a live per-agent token table (input/output/total, calls) with proportional bars, session totals, and each provider's remaining rate-limit quota." `/usage` appears in no registry: `src/commands/registry.ts` defines cancel, undo, rewind, branch, model, sessions, agents, tasks, skills, mcp, lsp, permissions, cost, status, debate, export, resume, clear, init, help — no `usage`. In the TUI it is `settingsTabFor("usage") → tab 3` (settings.go:36-37), a panel inside the settings overlay, and `tab` also reaches it via `m.view` toggling (session.go:352).\n\nREADME:176 — "type `/graph` in the interactive session for a live agent→task tree — each agent node with the tasks it worked, failover markers (`⚡×N`), and unassigned pending tasks." The actual handler (session.go:489-495) opens a **browser**: `target := m.client.BaseURL + "/graph/view?token=" + …; m.status = "opened the graph in your browser"`. The comment above it says why: "The interactive graph lives in the browser — the terminal can't do drag/hover/zoom." The ASCII agent→task tree README describes is `old-tech/ink-tui/GraphView.tsx`, whose own archive README lists it as "`GraphView.tsx` — agent→task ASCII tree (`/graph`)".\n\nREADME:152's list also omits /rewind, /branch, /skills, /debate, /export, /settings, /config, /stats.
```

**Impact.** Two of the three features the README singles out with their own bolded paragraphs describe the *archived v1 TUI*, not the shipped one. A reader on a headless box types `/graph` expecting a terminal tree and gets a browser launch attempt (or, with no browser, a bare error). `/export` — arguably the most substantial command in the registry — is undiscoverable from the README. This is the single largest accuracy gap between the docs and the code.

**Fix.** Rewrite README:174 and :176 against the shipped behaviour: `/usage` and `/stats` are tabs of the `/settings` overlay (with `tab` as the quick toggle); `/graph` and `/dashboard` open browser pages served by the core. Regenerate the :152 command list mechanically from `CommandRegistry.list()` plus the seven client-side entries in `menuItems()` (session.go:401-411) so it cannot drift again — the data is already there in `helpLines()`.

## 42. README claims "150+ providers" in four places; the catalog in the working tree has 34

`README.md:5` · **correctness**

**Evidence**

```
Four claims: README:5 "+ 150 more via Models.dev"; :63 "reach any of the 150+ OpenAI-compatible providers"; :146 "one OpenAI-compatible client covering 150+ providers"; :161 "multi-provider BYOK (150+ providers via Models.dev)".\n\nLive count against the working tree:\n'''\n$ bun -e '…Object.keys(CATALOG).length…'\nproviders: 34\nmodels: 181\n'''\nThe uncommitted diff is the cause: `scripts/gen-catalog.ts` gains an `ALLOW_IDS` set ("models.dev's registry is 149+ wide and mostly small resellers/gateways … noise in a picker a new user sees on first launch"), `catalog.generated.ts` loses 908 lines, and `catalog.test.ts`'s breadth assertion was rewritten from `toBeGreaterThan(100)` to `toBeGreaterThan(20) && toBeLessThan(60)`. `catalog.ts:33`'s inline comment was updated in the same diff — from "161+ providers" to "a curated slice of models.dev" — so the author already did this edit once and stopped at the source file.
```

**Impact.** The headline number in the first paragraph of the README, and in the Status section, overstates coverage by 4.4x. Anyone evaluating the project on breadth is being told something the shipped catalog contradicts. The trimming decision itself is defensible and well-argued in the diff's own comment — the problem is purely that the marketing copy was not part of the same change.

**Fix.** Update all four README sites to the real numbers in the same commit that lands the ALLOW_IDS diff — e.g. '34 curated providers / 181 models, with `custom` as the escape hatch for any OpenAI-compatible endpoint models.dev knows about'. The `custom` framing is the accurate version of the '150+' claim and is already implemented.

## 43. The shell tool's schema lets a model send `{"command":"git status"}`, which spawns a binary literally named "git status" and fails with a misleading PATH error — it happened on the first tool call of my first run

`src/tools/tools.ts:183` · **correctness**

**Evidence**

```
Schema (tools.ts:143-144): `properties: { command: {type:"string"}, args: {type:"array", items:{type:"string"}} }, required: ["command"]` — `args` is optional. Coercion (tools.ts:183-184): `command: String(i.command ?? ""), args: Array.isArray(i.args) ? i.args.map(String) : []`. No splitting. `shell()` at line 35 then calls `spawn(command, args, { cwd: root })`.\n\nObserved live, first tool call of a first run on a clean clone:\n'''\n[backend-engineer] tool_call: shell {"command":"git status"}\n[backend-engineer] file_edit: shell → exit -1 Error: Executable not found in $PATH: "git status"\n'''\nThe very next call from the same model got the shape right (`{"args":["-la"],"command":"ls"}`), which is exactly the pattern of a model guessing between two plausible encodings of a schema that does not disambiguate them.
```

**Impact.** A wasted turn, a wasted paid request, and an error message that blames the user's PATH for a schema ambiguity, on a tool that is called constantly. It burns one of the `maxTurns: 12` iterations per occurrence. Under `--auto` in CI it just looks like git is missing. The tool description at line 140 ('Args are passed literally (no shell interpretation)') tells the model what happens to `args` but never says `command` must be a bare executable name.

**Fix.** Split when the model clearly meant a shell string — one line at the coercion site, which is where all four tool sources funnel through: `const parts = String(i.command ?? "").trim().split(/\\s+/); const args = Array.isArray(i.args) && i.args.length ? i.args.map(String) : parts.slice(1); const command = parts[0] ?? "";` — plus `// ponytail: whitespace split, no quote handling; args[] is the documented shape and always wins`. Also amend the line-140 description to 'command must be a single executable name; put every argument in args'. This is strictly better than a guaranteed ENOENT, and quoted-argument cases are already served correctly by the `args` array.


---

# P2 — Fix soon after (or before, if cheap) (75)

## 44. `bin` points at a `.ts` file with a `#!/usr/bin/env bun` shebang — a Node-only user's install fails at postinstall, and the bin is unrunnable even if it succeeds

`package.json:8` · **portability** · adversarially verified · originally reported critical, downgraded on verification

**Evidence**

```
package.json:7-9 `"bin": { "amux-core": "./src/cli.ts" }`; src/cli.ts:1 `#!/usr/bin/env bun`.
After installing the tarball: `node_modules/.bin/amux-core -> ../amux/src/cli.ts` (a symlink to TypeScript source).
With bun on PATH: `./node_modules/.bin/amux-core "say hi"` → `amux: no agents configured. Run 'amux-core init' …` (works).
With `env PATH=/usr/bin:/bin ./node_modules/.bin/amux-core "say hi"` → `env: bun: No such file or directory`.
And postinstall itself: `env PATH=/usr/bin:/bin bash -lc 'bun run scripts/fix-pty-perms.ts'` → `bash: bun: command not found`, **exit 127**.
```

**Impact.** For the stated target — 'a user who has Node but may not have Bun' — `npm i -g amux` aborts during postinstall (exit 127) on any npm version that still runs install scripts by default. If it somehow gets past that, `amux-core` immediately fails with `env: bun: No such file or directory`. The package is unusable by a Node-only user in both phases, and the failure messages name neither Bun nor amux, so the user has no idea what to install.

**Fix.** Two viable strategies, pick one: (A) **Bun-required, honest about it** — keep the TS source but point `bin` at a tiny `bin/amux.cjs` written in plain CommonJS that Node *can* execute; it checks for bun (`require('child_process').spawnSync('bun',['--version'])`) and either execs `bun <pkgroot>/src/cli.ts` or prints `amux requires Bun ≥1.3 — install it with: curl -fsSL https://bun.sh/install | bash` and exits 1. Add `"engines": {"node": ">=20", "bun": ">=1.3.0"}`. This is ~15 lines and turns a cryptic `env:` error into an actionable one. (B) **Ship the real binary** — see the multi-binary finding. Either way, delete the `postinstall` (it exists only for node-pty) so the install itself never needs bun.

## 45. MCP and LSP child processes are orphaned on every exit — Engine.close() is never called and the TUI SIGKILLs the core

`src/mcp/mcp.ts:79` · **correctness** · adversarially verified · originally reported high, downgraded on verification

**Evidence**

```
`McpManager.close()` exists (mcp.ts:79-81) but grep across all of src/ finds zero callers. `Engine.close()` (engine.ts:342-345) closes only the watcher and the LSP registry — it does not close `this.mcp` — and grep finds zero callers of `Engine.close()` anywhere. The two SIGINT handlers in cli.ts:87-90 and cli.ts:106-109 call only `server.stop(); process.exit(0)`, and the headless path ends with a bare `process.exit(0)` (cli.ts:160).

The MCP SDK only reaps its child inside its own close path — `node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js:161` `processToClose.kill('SIGTERM')` and `:170` SIGKILL — with no process-exit hook.

Worse, the Go TUI terminates the core with `_ = c.cmd.Process.Kill()` (tui/cmd/amux/main.go:39), which is SIGKILL and cannot be trapped at all.
```

**Impact.** Every quit of the TUI leaves one orphaned process per configured MCP server plus one per spawned language server (gopls, typescript-language-server) running with the project directory open and, for gopls, hundreds of MB resident. Ten sessions in a workday leaves ten stranded gopls processes. The same SIGKILL is why `.amux/amux.db-wal` on this machine is 1.96 MB against a 118 KB main database — the connection is never closed, so the WAL is never checkpointed.

**Fix.** Two changes. (1) In `src/engine.ts:342-345`, add `void this.mcp?.close?.()` and close the store's database handle so the WAL checkpoints — that makes `Engine.close()` complete. (2) Have the TUI send SIGTERM before SIGKILL: in `tui/cmd/amux/main.go:38-40`, `_ = c.cmd.Process.Signal(syscall.SIGTERM)`, wait ~500ms on `cmd.Wait()`, then `Kill()`; and register `process.on("SIGTERM", ...)` alongside the existing SIGINT handlers in cli.ts/server/main.ts to call `engine.close()` before `process.exit(0)`. Without (2), (1) can never run under the TUI.

## 46. SSE subscriber and 25s ping interval leak forever when a client closes the response body gracefully, and the stream queue has no bound — a dead or slow client retains unbounded memory

`src/server/server.ts:98` · **state-management** · adversarially verified · originally reported high, downgraded on verification

**Evidence**

```
Measured against a real `startServer` (probe scripts in /private/tmp/claude-501/.../scratchpad-equivalent /tmp/amuxprobe). (a) `AbortController.abort()` on the fetch → `cancel()` fires, `(engine.hub as any).subs.size` goes 1→0, correct. (b) killing an attached `curl -sN` → 2→1, correct. (c) `reader.cancel()` on the response body → subs stays at 1 after 100/500/1500/3000ms and never drops. With that leaked subscriber in place, publishing 100k agent_event deltas grew heap by 51.1 MB (measured with `Bun.gc(true)` on both sides). Separately, with a live-but-unread reader, 200k events grew heap 82.1 MB — the `ReadableStream` in `sse()` is created with no queuing strategy and `send()` never inspects `controller.desiredSize`, so `enqueue` buffers without limit and the `catch {}` at line 103-105 never fires.
```

**Impact.** Any HTTP client that cancels the body rather than the socket (and any future browser/proxy that does the same) permanently registers a subscriber whose stream queue grows by every event for the life of the process. A long session with a chatty agent — deltas at token rate, several hundred bytes each — turns tens of MB into hundreds. There is also no cleanup path at all for a subscriber whose enqueue silently succeeds into a dead queue: the 25s interval keeps the closure alive indefinitely.

**Fix.** In `sse()`, make cleanup idempotent and drive it from backpressure as well as `cancel()`: `const close = () => { clearInterval(ping); unsub(); try { controller.close(); } catch {} };` call it from `cancel()`, from the `catch` around each `enqueue`, and when `controller.desiredSize !== null && controller.desiredSize < -SOME_BYTES` (drop the slow client rather than buffer for it — a client that has fallen a megabyte behind can reconnect with `?from=` and replay). Add a `new ByteLengthQueuingStrategy({highWaterMark: 1<<20})` so `desiredSize` is meaningful in bytes.

## 47. Browser clients always reconnect with `from=0` and the server ignores `Last-Event-ID`, so every SSE reconnect replays up to 2000 buffered events and duplicates the whole UI history

`src/server/server.ts:153` · **correctness** · adversarially verified · originally reported high, downgraded on verification

**Evidence**

```
server.ts:102 emits `id: ${e.seq}` on every frame (which is what makes a browser send `Last-Event-ID` on auto-reconnect), but line 153 reads only the query string: `if (p === "/events" && method === "GET") return sse(Number(u.searchParams.get("from") ?? 0));`. app.js:71 `new EventSource('/events?from=0&token=...')` and graph.js:101 `new EventSource('/events?from=0&token=...')` — the URL is fixed at construction, EventSource reuses it verbatim on reconnect, and neither file tracks `lastSeq`. Contrast tui/internal/api/client.go:393, which correctly passes `fromSeq`.
```

**Impact.** After any blip — laptop sleep, server restart, a proxy timeout — the browser replays the hub's entire 2000-event ring: `messages.unshift(m)` (app.js:104) duplicates every agent-to-agent message in the Messages tab, `pulse()` re-fires every historical animation at once, `feedDelta`/`pushLog` re-append every transcript line to each agent's panel, and graph.js re-runs `syncModels()` 2000 times. The UI silently doubles its history on every reconnect and there is no way for the user to tell replayed events from live ones.

**Fix.** Server: `const last = req.headers.get("last-event-id"); return sse(Number(last ?? u.searchParams.get("from") ?? 0));` — two lines, and it fixes every browser client at once because they all already receive `id:`. Optionally also track `lastSeq` in app.js/graph.js and rebuild the EventSource URL on `onerror` for clients that don't send the header.

## 48. Running from a subdirectory silently creates a stray .amux/ and runs with zero agents

`src/store/db.ts:5` · **ux** · adversarially verified · originally reported high, downgraded on verification

**Evidence**

```
`DEFAULT_DB = ".amux/amux.db"` and every config default is `".amux/agents.yaml"` — all cwd-relative, with no ancestor walk for a project root anywhere in src/ (the only homedir path in the whole tree is `auth-store.ts:16` for credentials). `serveMain` treats a missing config as setup mode rather than an error: `const configs = existsSync(".amux/agents.yaml") ? loadAgents() : []` (server/main.ts:24). Reproduced:

  $ mkdir -p /tmp/amuxroot/sub && cd /tmp/amuxroot/sub
  $ bun src/cli.ts serve --port=39871   # (killed after 3s)
  $ ls -a /tmp/amuxroot/sub/.amux
  amux.db  amux.db-shm  amux.db-wal

The real project config one directory up was never consulted. `amux-core serve` is exactly what the Go TUI spawns (`exec.Command(bunBin, "run", entry)`, tui/cmd/amux/main.go:51, inheriting the TUI's cwd).
```

**Impact.** Open a terminal in `myproject/src/`, launch amux, and you get a TUI in permanent setup mode with 'no agents configured yet', a brand-new empty database, and a stray `.amux/` directory polluting your source tree — while `myproject/.amux/agents.yaml` with your whole team sits unread one level up. Every git-aware CLI the user has ever used (git, npm, cargo) walks up to find its root; amux does not, and the failure is silent rather than an error.

**Fix.** One helper, called once at process start, before any loader runs. In `src/cli.ts` and `src/server/main.ts`, resolve the root by walking up from cwd for the first ancestor containing `.amux/` or `.git/`, then `process.chdir(root)`. Roughly:

  function projectRoot(d = process.cwd()) { for (let p = d; ; p = dirname(p)) { if (existsSync(join(p,".amux")) || existsSync(join(p,".git"))) return p; if (dirname(p) === p) return d; } }
  process.chdir(projectRoot());

Every existing relative default then keeps working unchanged, and `Engine.root = process.cwd()` (engine.ts:73) becomes correct for free.

## 49. Two amux processes on one project fail immediately with "database is locked" — no busy_timeout

`src/store/db.ts:88` · **state-management** · adversarially verified · originally reported high, downgraded on verification

**Evidence**

```
`openDb` sets only two pragmas — `journal_mode = WAL` and `foreign_keys = ON` (db.ts:88-89). There is no `PRAGMA busy_timeout`, so bun:sqlite's default of 0 applies: a contended write throws instantly rather than retrying. Reproduced by holding a write transaction open in one process while a second process inserts:

  second writer ERR: database is locked

The comment on line 88 — "concurrent agents write from one process; WAL keeps reads unblocked" — describes only the single-process case. But the multi-process case is the normal deployment: `amux-core serve` (spawned by the Go TUI) plus a scripted `amux-core "task"` in another terminal, or two TUIs on the same repo, all resolve to the same `.amux/amux.db`.
```

**Impact.** The second process throws SQLITE_BUSY out of `SessionStore.appendMessage` (session-store.ts:117) via `Agent.push` (agent.ts:353), which sits inside the agent turn loop — a mid-conversation write failure aborts the task after the model call has already been paid for. WAL specifically supports concurrent readers with one writer; the only thing missing is the retry window, so this fails in exactly the configuration SQLite is designed to handle.

**Fix.** One line in `openDb`, next to the existing pragmas: `db.exec("PRAGMA busy_timeout = 5000;")`. That is the stdlib answer to write contention and it makes the WAL comment on line 88 true for the multi-process case too. If you also want the process to survive a genuine 5s standoff, wrap the `appendMessage` call at agent.ts:353 in a try/catch that publishes an `error` event rather than aborting the turn — the store is documented as a side-effect mirror, so losing one mirrored write should not kill a live conversation.

## 50. The agent transcript cannot be scrolled and mouse selection is disabled by default, so agent output is effectively write-only

`tui/internal/session/session.go:377` · **ux** · adversarially verified · originally reported high, downgraded on verification

**Evidence**

```
`scroll()` handles only the three popups:
	switch {
	case m.out.open:   m.out.top = clamp(...)
	case m.car.open:   m.car.list.Move(delta)
	case m.menuOpen:   m.menu.Move(delta)
	}

with the comment "Nothing open means nothing to scroll — the transcript follows the agents, not the wheel." No keybinding scrolls the panes either — `onKey`'s global switch (session.go:350-368) has no pgup/pgdn/up/down for the body. `agentBlock` renders only the tail: `for i := max(len(body)-rows, 0); i < len(body); i++` (view.go:415). Scrollback is hard-capped: `const agentLogMax = 60` (session.go:56) with `s.log = s.log[len(s.log)-agentLogMax:]`. And the terminal's own selection is taken away by default — `screenOpts()` appends `tea.WithMouseCellMotion()` unless `AMUX_NO_MOUSE` is set (main.go:143-148), and `grep -rn AMUX_NO_MOUSE` finds it nowhere outside that one function: not in README.md, not in any help text.
```

**Impact.** On a 40-row terminal with 3 agents each block gets ~12 rows. Anything an agent said more than 12 lines ago is unreachable: it cannot be scrolled to, the alt screen means it isn't in shell scrollback, and beyond 60 lines it is discarded from memory entirely. The user also cannot drag-select it to copy, because mouse reporting is on — and the escape hatch for that is an undocumented env var. For a tool whose entire value proposition is watching several agents work, the output of that work is unreadable and uncopyable.

**Fix.** Add a focused-pane concept: shift+up/down (or a `[`/`]` pair) scrolls the focused agent's block, and route the wheel to it in `scroll()`'s default case. Raise `agentLogMax` substantially (600 lines × 6 agents is a few hundred KB) or spill to the pager. Add a keybinding that dumps the focused agent's full transcript into the existing `output` pager, which already scrolls. Document `AMUX_NO_MOUSE` in the README and in `/help`'s key line (session.go:427-428).

## 51. gen-catalog picks `env[0]` as the API-key variable, shipping two providers whose "key" is an account id / hostname

`scripts/gen-catalog.ts:99` · **correctness** · adversarially verified · originally reported high, downgraded on verification

**Evidence**

```
Generator: `const envVar = p.env?.[0];` (gen-catalog.ts:99). Live models.dev data (fetched during this audit) for these two providers: `cloudflare-workers-ai` → `env: ["CLOUDFLARE_ACCOUNT_ID","CLOUDFLARE_API_KEY"]`; `databricks` → `env: ["DATABRICKS_HOST","DATABRICKS_TOKEN"]`. The committed output takes the first element of each:
'''
"cloudflare-workers-ai": { …, envVar: "CLOUDFLARE_ACCOUNT_ID", }   // catalog.generated.ts:32
"databricks": { …, envVar: "DATABRICKS_HOST", }                    // catalog.generated.ts:151
'''
These are also the only two entries in the whole 34-provider catalog whose env var does not end in `_KEY`/`_TOKEN` (verified by scanning CATALOG at runtime).
```

**Impact.** A user with `CLOUDFLARE_ACCOUNT_ID` exported (routine for anyone using wrangler) selects Cloudflare Workers AI. `keystore.envKey` returns the account id, `factory.ts:28` builds `new OpenAI({apiKey: <account-id>})`, and every request sends `Authorization: Bearer <cloudflare account id>` — an identifier, not a secret — to a third party. Same for `DATABRICKS_HOST`. Auth can never succeed, and a non-secret account identifier is transmitted as if it were a credential.

**Fix.** In `scripts/gen-catalog.ts`, stop taking `env[0]` blindly. Pick the first entry matching `/_(API_)?KEY$|_TOKEN$/`, falling back to the last element: `const envVar = p.env?.find(v => /_(API_)?KEY$|_TOKEN$/.test(v)) ?? p.env?.at(-1);`. Regenerate. Add a guard to `catalog.test.ts` asserting `expect(e.envVar).toMatch(/(_KEY|_TOKEN)$/)` so this cannot silently return.

## 52. The generator discards models.dev's `tool_call` flag, so 19 of the 150 shipped seed models physically cannot run an amux agent

`scripts/gen-catalog.ts:104` · **ux** · adversarially verified · originally reported high, downgraded on verification

**Evidence**

```
`gen-catalog.ts:104` is `const models = Object.keys(p.models ?? {}).slice(0, 8);` — an arbitrary insertion-order slice, filtered on nothing. models.dev publishes `tool_call: boolean` per model (confirmed against live api.json, e.g. `nvidia/magpie-tts-zeroshot` → `"tool_call": false, "modalities": {"output": ["audio"]}`). Cross-checking the committed catalog against live upstream data:
'''
nvidia                5/8 tool_call:false -> phi-4-multimodal-instruct, magpie-tts-zeroshot, nv-embedcode-7b-v1, studiovoice, sparsedrive
openrouter            4/8 tool_call:false -> microsoft/phi-4, wizardlm-2-8x22b, cohere/command-a, cohere/command-r7b-12-2024
cloudflare-workers-ai 3/8 tool_call:false -> gemma-sea-lion-v4-27b-it, qwq-32b, qwen2.5-coder-32b-instruct
novita-ai             3/8 tool_call:false
digitalocean          2/8 tool_call:false -> openai-gpt-image-1, gte-large-en-v1.5
scaleway              1/8 -> bge-multilingual-gemma2 ;  alibaba 1/8 -> qwen-mt-plus
TOTAL: 19/150 shipped seed models cannot make a tool call
'''
```

**Impact.** amux's entire agent loop is tool-driven (`agent.ts:200` always passes `this.buildTools(...)`). A user picks `nvidia/studiovoice` — a driving/speech model — from the model picker, and it either 400s on the `tools` parameter or returns prose forever until `maxTurns` is hit, which `agent.ts:243` reports as `done: (turn cap reached)`. An image-generation model (`openai-gpt-image-1`) and two embedding models (`gte-large-en-v1.5`, `bge-multilingual-gemma2`) are offered as coding agents. Since the *point* of the ALLOW_IDS change is to make the first-launch picker less noisy, shipping non-chat models inside the curated list undercuts the change.

**Fix.** One predicate in `gen-catalog.ts:104`: `const models = Object.entries(p.models ?? {}).filter(([, m]) => m.tool_call && m.modalities?.output?.includes("text")).map(([id]) => id).slice(0, 8);` and add `tool_call?: boolean; modalities?: {output?: string[]}` to the `RawModel` interface at :11-14. Regenerate.

## 53. MCP tools bypass `allowedTools` entirely — an agent restricted to read_file gets every MCP server's write tools

`src/agent/agent.ts:371` · **security** · adversarially verified · originally reported high, downgraded on verification

**Evidence**

```
'''
    const specs = [...toolSpecs(allowed), ...(this.mcp?.toolSpecs() ?? []), ...lspToolSpecs(this.lsp)];
'''
MCP specs are appended unconditionally — `allowed` is not consulted. Execution matches: `if (isMcp) { output = await this.mcp!.call(call.name, call.input); }` (agent.ts:454-455) never goes through `runTool`, and `runTool`'s gate (`if (!allowed.includes(call.tool)) throw`, src/tools/tools.ts:51) is the only place `allowedTools` is enforced. Same for the LSP branch at line 456.
```

**Impact.** An agent configured `allowedTools: ["read_file"]` — the natural way to express "this reviewer must not modify anything" — is still handed every tool from every configured MCP server, including filesystem-write, git-commit and shell-execution servers. `DEFAULT_RULES` gives unknown tools `"ask"` (permissions.test.ts:42 asserts exactly this for `mcp__fs__read`), but in headless mode there is no approver, so `"ask"` executes silently. The `allowedTools` field is documented in AgentConfig as `"read_file" | "write_file" | "shell"` and reads as a capability list; it is in fact only a sandbox-tool filter.

**Fix.** Filter MCP specs by the same list in `buildTools`: `...(this.mcp?.toolSpecs() ?? []).filter(s => allowed.includes(s.name) || allowed.includes("mcp"))`, and mirror the check in `execTool` before `this.mcp!.call` so a hallucinated name cannot slip past the spec filter. If the intent is that MCP is always-on, say so in the AgentConfig comment at agent.ts:82 and document that `allowedTools` does not bound MCP — right now the field's name promises otherwise.

## 54. A pending approval blocks its agent forever; `cancel()` cannot clear it and the Engine never becomes idle again

`src/approval.ts:44` · **state-management** · adversarially verified · originally reported high, downgraded on verification

**Evidence**

```
'''
    return new Promise((resolve) => {
      this.pending.push({ agentId, tool, input, resolve, queuedAt: Date.now() });
      this.notify();
    });
'''
Nothing else resolves it: `ApprovalQueue` has no timeout, no abort and no per-agent cleanup. `Engine.cancel()` (engine.ts:235-237) only sets `this.cancelled`, which is read solely by the scheduler's `shouldStop` (engine.ts:204) — the agent loop at agent.ts:197 never consults it, and it certainly does not reach the awaited approval promise at agent.ts:448.
```

**Impact.** If the TUI crashes, the browser tab closes, or the user simply walks away with a dialog open, the agent's `await this.approve(...)` never settles. `runTask` never returns, `schedule()` sits in `Promise.race(running.values())` forever, `runSession`'s `finally` never runs, so `Engine.busy` stays true and every subsequent `submit()` throws `"a task is already running"` (engine.ts:180). The only recovery is killing the process — which also loses the run's in-memory state. Pressing `/cancel` does not help, by design.

**Fix.** Add `abortAll(): void { this.drain(() => false); }` to ApprovalQueue (it can reuse the existing private `drain` at approval.ts:94) and call it from `Engine.cancel()` before setting `this.cancelled`. Separately, thread the cancel signal into the loop: pass `shouldStop` into `AgentDeps` and check it at the top of run()'s `for` body (agent.ts:198) so `/cancel` stops an in-flight agent instead of paying for its remaining turns.

## 55. `--web` does not strip other flags from the task text, so `amux-core --web --auto "build x"` sends the literal string `--auto build x` to the model

`src/cli.ts:98` · **correctness** · adversarially verified · originally reported high, downgraded on verification

**Evidence**

```
src/cli.ts:98   const goal = args.filter((a) => a !== "--web").join(" ").trim();

versus the headless path, which filters every flag:
src/cli.ts:125  const goal = resume ? "" : args.filter((a) => !a.startsWith("--")).join(" ").trim();

Two different definitions of 'what is the task text' in one 40-line span.
```

**Impact.** `amux-core --web --auto "add a health endpoint"` produces goal === `--auto add a health endpoint`, which is submitted verbatim at line 105. The orchestrator model receives a prompt beginning with a stray CLI flag and plans against it — at minimum a confused plan, and `--auto` is exactly the kind of token a model may interpret as an instruction. `--port=8080` in the same position becomes part of the prompt too.

**Fix.** Make src/cli.ts:98 use the same filter as line 125: `const goal = args.filter((a) => !a.startsWith("-")).join(" ").trim();`. Better, compute `goal` and `flags` once at the top of the file (right after line 33) and have all three branches read the same two values, so a third definition can't appear.

## 56. A merge conflict permanently wedges the engine: no discard path for a worktree

`src/engine.ts:224` · **ux** · adversarially verified · originally reported high, downgraded on verification

**Evidence**

```
`mergeWorktree` clears `this.worktreeHandle` only inside `if (result.ok)` (engine.ts:228-231). `runSession` throws unconditionally while a handle exists: `throw new Error(\`a previous run's worktree (${this.worktreeHandle.branch}) hasn't been merged yet — merge or discard it first\`)` (engine.ts:183). The only worktree routes are `GET /worktree` and `POST /worktree/merge` (server.ts:301-306); there is no discard/abort route and no command in registry.ts. The error message tells the user to 'discard it' — an action the product does not implement.
```

**Impact.** `amux --worktree`, run finishes, user clicks merge, `git merge --no-ff amux/ab12cd34` conflicts. `mergeBack` returns ok:false, the handle stays, and every subsequent submit() throws forever until the process is restarted. Meanwhile the real repo root is left mid-conflict (MERGE_HEAD present) with no in-product `git merge --abort`.

**Fix.** Add `POST /worktree/discard` → `Engine.discardWorktree()` that runs `removeWorktree(this.root, handle.path)`, deletes the branch (`git branch -D`), and clears `worktreeHandle`. In `mergeWorktree`, on `!result.ok` run `git merge --abort` in root before returning so the user's repo isn't left conflicted. Both are ~6 lines in worktree.ts + engine.ts. Then the error message at engine.ts:183 becomes true.

## 57. Stale-lock reclaim steals a lock from a live holder, allowing two agents to write one file

`src/orchestrator/locks.ts:31` · **correctness** · adversarially verified · originally reported high, downgraded on verification

**Evidence**

```
`if (Date.now() - entry.acquiredAt > this.staleMs) { ...publish warning...; this.locks.set(path, { holder, acquiredAt: Date.now() }); return; }` (locks.ts:31-40). There is no liveness check on `entry.holder` — the only evidence of death is elapsed time. STALE_MS is 60_000. The same registry guards `SHELL_LOCK` (agent.ts:461), and shell commands legitimately run far longer than 60s (a test suite, a build, `npm install`). The original holder's `release` after the steal is a correct no-op (locks.ts:55 checks ownership), so nothing detects that two writers were live at once.
```

**Impact.** Agent A runs `bun test` under SHELL_LOCK; it takes 90s. At t=60s agent B's acquire declares the lock stale, reclaims it, and starts its own `git checkout`/`rm` concurrently with A's still-running test. For write_file: agent A holds `src/api.ts` while awaiting a slow approval prompt; after 60s agent B steals it and both write, last-writer-wins, and the undo checkpoint taken at agent.ts:467 records the wrong 'before' state.

**Fix.** The holder is an in-process agent id and Agent already exposes liveness — `Agent.busy` / `inFlightCount` (agent.ts:168). Pass a liveness predicate into LockRegistry (`isAlive?: (holder: string) => boolean`) and only reclaim when `!isAlive(entry.holder)`. Cheaper alternative that keeps the ponytail spirit: have `acquire` record the promise/token and have `release` be the only path that frees a lock, replacing the timer with a hard timeout that *rejects* the waiter (`throw new Error('timed out waiting for ' + path)`) instead of silently granting a second writer. Never grant two holders.

## 58. Cancelling a run marks every unstarted task 'failed' and then reports 100% complete

`src/orchestrator/scheduler.ts:274` · **ux** · adversarially verified · originally reported high, downgraded on verification

**Evidence**

```
When `shouldStop()` is true the launch block at scheduler.ts:263 is skipped entirely, so `running.size === 0` on the very first iteration and the 'unreachable' sweep at lines 276-280 flips every pending task to `"failed"` and emits `task_done ok:false` for each. Then line 306 emits `{type:"complete", completed: settled(), total: tasks.length}` — settled() counts failed tasks, so completed === total. Verified with a probe: 3 pending tasks, `shouldStop: () => true` → `statuses: ["failed","failed","failed"]` and `complete event: {"type":"complete","completed":3,"total":3}`. Both clients then hard-set the bar: tui/internal/session/session.go:657 `m.progress = 100`, web/app.js:142 `setProgress(100)`.
```

**Impact.** User presses cancel on a 6-task plan after task 1. Tasks 2-6 never ran, yet the TUI board shows all of them red/failed and the progress bar reads 100%. `saveTasks` then persists them as failed. The user cannot distinguish 'the model failed this' from 'I cancelled before this started'.

**Fix.** Two changes in scheduler.ts. (1) Guard the sweep: `if (!stop) { for (const t of stuck) ... }` — on cancel, leave pending tasks pending and just break. (2) Compute completion honestly: `emit?.({ type: "complete", completed: tasks.filter(t => t.status === "done").length, total: tasks.length, ... })`, and add a `cancelled: boolean` field to the complete event so session.go:656 and app.js:142 stop unconditionally jumping to 100%. Add a `"cancelled"` TaskStatus if the board needs a third colour.

## 59. The project's own default models — every Google model in the catalog — are unpriced, so the cost meter reads $0.00+ out of the box

`src/providers/pricing.ts:25` · **ux** · adversarially verified · originally reported high, downgraded on verification

**Evidence**

```
`catalog.ts:53` seeds Google with `["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-pro-latest"]` and `.amux/agents.yaml` pins `model: gemini-flash-latest`. Running `priceFor` against them:
'''
gemini-flash-latest       -> undefined
gemini-pro-latest         -> undefined
gemini-flash-lite-latest  -> undefined
'''
The table is keyed on versioned prefixes (`gemini-2.5-flash`, `gemini-3`, …, pricing.ts:25-31) and no entry is a prefix of the `-latest` aliases. Same scan found `MiniMax-M2`, `deepseek-v4-flash`, `deepseek-v4-pro` (the two *first* seeds of the generated deepseek entry), `gpt-5.4-pro`, `accounts/fireworks/models/gpt-oss-20b` and `@cf/qwen/qwq-32b` all unpriced.
```

**Impact.** `costOf` returns `{usd:0, priced:false}`, `engine.ts:363-372` sets `costKnown=false`, and the TUI/dashboard cost readout is `$0.00+` for the exact configuration the repo ships. The single most-scrutinised number in a multi-agent tool — "what is this costing me" — is blank on first run. Anyone evaluating amux against a competitor sees a broken cost meter.

**Fix.** Take the upgrade path pricing.ts:4-7 already names, and which is now cheap because gen-catalog already fetches the data: models.dev publishes `cost: {input, output}` per model (verified). Emit a `PRICES` map from `gen-catalog.ts` keyed by exact `provider/model`, have `priceFor` consult it first and fall back to the hand-maintained prefix table. Interim one-liner: add `"gemini-flash-lite": {input:0.1,output:0.4}`, `"gemini-flash": {input:0.3,output:2.5}`, `"gemini-pro": {input:1.25,output:10}` to cover the `-latest` aliases.

## 60. The tarball ships the maintainer's personal .amux/agents.yaml and .claude/settings.local.json

`.amux/agents.yaml:1` · **security**

**Evidence**

```
`npm pack --dry-run` lists `309B .amux/agents.yaml` and `284B .claude/settings.local.json`; both confirmed present after install (`ls -a node_modules/amux/` → `.amux  .claude  …`). Contents read in full: agents.yaml declares one agent `id: a, provider: google, model: gemini-flash-latest, role: A, lead: true`, allowedTools read_file/write_file/edit/shell, `theme: neon graveyard`; settings.local.json contains an MCP allowlist for `code-review-graph` and `enabledMcpjsonServers`. No API keys or tokens in either.
```

**Impact.** No credential leak today — but this is the exact directory the tool writes runtime config into, so the pattern is one careless commit away from publishing a key. It also leaks the maintainer's dev environment (which MCP servers they run, which model they use) to every downloader, and creates a `.amux/agents.yaml` inside the global install directory that will confuse anyone who goes looking for their config.

**Fix.** `git rm --cached .amux/agents.yaml .claude/settings.local.json`, add `.amux/` (whole dir) and `.claude/settings.local.json` to .gitignore, and ship an example instead at `examples/agents.yaml` referenced from the README. The `files` allowlist from the earlier finding makes this belt-and-braces.

## 61. npm 11 defers install scripts by default, so the workaround the code depends on silently never runs

`package.json:19` · **packaging**

**Evidence**

```
Real install output:
'''
npm warn allow-scripts 4 packages have install scripts not yet covered by allowScripts:
npm warn allow-scripts   amux@0.0.1 (postinstall: bun run scripts/fix-pty-perms.ts)
npm warn allow-scripts   node-pty@1.1.0 (install: node scripts/prebuild.js || node-gyp rebuild; postinstall: node scripts/post-install.js)
npm warn allow-scripts Run `npm approve-scripts --allow-scripts-pending` to review
'''
Install still reported `added 148 packages` and exit 0.
```

**Impact.** On npm ≥11 the install *succeeds* but node-pty's own `install`/`postinstall` are skipped too — so node-pty may have no usable native binary at all, and the failure surfaces later as a runtime crash rather than an install error. Any design that relies on a postinstall hook to become functional is unreliable on current npm.

**Fix.** Do not depend on install scripts for correctness. Deleting node-pty removes both offending entries at once. For anything that genuinely needs setup, do it lazily at first use inside the CLI (where you can print an actionable error) rather than in a lifecycle hook the package manager may skip.

## 62. Missing public-package metadata: no repository, homepage, bugs, keywords, author, publishConfig, os, cpu, or engines.node

`package.json:21` · **packaging**

**Evidence**

```
The whole manifest is 41 lines; the only metadata present is name, version, private, description, type, bin, scripts, `"engines": { "bun": ">=1.3.0" }`, license, deps. No `repository`, `homepage`, `bugs`, `keywords`, `author`, `publishConfig`, `os`, `cpu`. LICENSE names `Shubhadeep Datta` but package.json does not.
```

**Impact.** The npm page shows no repo link, no issue tracker, no author, and does not appear in searches for 'ai agent', 'llm', 'cli', 'multi-agent'. `engines` has no `node` key, so npm performs no engine check whatsoever for the Node users who are the failure case — they get `env: bun: No such file or directory` instead of an engine warning. Without `os`/`cpu` there is nothing stopping a Windows or Linux user from installing a package that cannot work there.

**Fix.** Add to package.json: `"author": "Shubhadeep Datta"`, `"repository": {"type":"git","url":"git+https://github.com/<owner>/amux.git"}`, `"homepage"`, `"bugs": {"url": ".../issues"}`, `"keywords": ["ai","agent","llm","cli","multi-agent","orchestrator","anthropic","openai","gemini","tui"]`, `"publishConfig": {"access": "public"}`, and `"engines": {"node": ">=20", "bun": ">=1.3.0"}`. Add `"os"`/`"cpu"` only on the per-platform binary sub-packages, never on the root launcher.

## 63. The postinstall script is cwd-relative and targets a path that does not exist in a hoisted consumer install

`scripts/fix-pty-perms.ts:8` · **correctness**

**Evidence**

```
`for (const f of new Glob("node_modules/node-pty/prebuilds/*/spawn-helper").scanSync("."))` — scans from `.`. npm runs postinstall with cwd set to the installed package dir (`<root>/node_modules/amux`), where `node_modules/` does not exist (verified: `ls node_modules/amux/node_modules` → `No such file or directory`); node-pty is hoisted to `<root>/node_modules/node-pty`. Also requires bun: without it, exit 127.
```

**Impact.** Even on a machine with bun and with scripts allowed, the glob matches nothing and the chmod never happens — so the exact bug the script's own comment describes ('node-pty@1.1.0's darwin prebuilds land as -rw-r--r--, which makes posix_spawnp fail at runtime with no other symptom') would resurface silently in every npm install. It is a no-op that looks like a fix.

**Fix.** Delete the script and the postinstall entry along with node-pty (see finding #2). If node-pty must stay, rewrite the resolution to be package-relative rather than cwd-relative — `createRequire(import.meta.url).resolve('node-pty/package.json')` then chmod its `prebuilds/*/spawn-helper` — and port it to plain Node (`node:fs` + `node:fs.globSync`) so the install does not require bun.

## 64. The published CLI would have no `--help` and no `--version`, and `--help` exits 0 on an error path

`src/cli.ts:33` · **ux**

**Evidence**

```
`const args = process.argv.slice(2);` followed by unparsed `if (args[0] === "keys"|"login"|"auth"|"serve"|"init")` blocks (:40, :51, :61, :82, :115) and `args.includes("--web")` (:97).
'''
$ bun run src/cli.ts --help
amux-core: no task given.
  For the interactive session, run the Go TUI:  ./amux  (build with `bun run build:tui`)
  ...
$ echo $?  → 0
'''
No `--version` handler exists anywhere in the file.
```

**Impact.** `amux-core --help` is interpreted as 'no task given', prints a banner that tells the user to run `./amux` — a relative path that does not exist for an installed user — and exits 0, so a wrapper script cannot detect the failure. `amux-core --version` would be interpreted as a *task prompt* and sent to an LLM. Bug reports will not include a version because there is no way to get one.

**Fix.** Add two guards at the top of src/cli.ts after line 33: `if (args[0]==="--version"||args[0]==="-v") { console.log(VERSION); process.exit(0); }` and `if (args[0]==="--help"||args[0]==="-h") { console.log(USAGE); process.exit(0); }`, with the no-args/unknown case printing USAGE to stderr and `process.exit(1)`. Source VERSION from package.json. Rewrite the banner to name installed commands (`amux`, `amux-core`) instead of `./amux` and `bun run build:tui`.

## 65. Saving config destroys every comment and silently drops unrecognised agent keys

`src/config/config.ts:128` · **ux**

**Evidence**

```
`saveAgents` (:111-128) and `setTheme` (:136-137) both do `parse(readFileSync(...))` → object spread → `writeFileSync(path, stringify(doc))`. The `yaml` package's `parse`/`stringify` pair discards comments and rebuilds each agent from a fixed whitelist. Verified against a hand-written file:

  input:  # my hand-written team
          theme: nord   # picked this one
          agents:
            - id: a   # the lead
              ...
              customKey: keepme

  after saveAgents: every comment gone, `customKey: keepme` gone.

The comment at :106-108 shows the author already reasoned about preserving the user's hand-written blocks — the merge does protect sibling top-level keys, which config.test.ts:135-160 verifies — but comments and per-agent extras were not considered.
```

**Impact.** The team picker runs on every launch (comment at config.ts:107) and `POST /theme` fires on every theme-carousel keypress. So a user who documents their roster with comments loses all of them the first time they cycle the theme. This is the file amux tells users to hand-edit for `permissions:`, `lsp:` and `mcpServers:` — silently rewriting it on every launch is corrosive to trust in the config.

**Fix.** The already-installed `yaml` dependency has a comment-preserving document API — no new dependency needed. Replace parse/stringify with:

  import { parseDocument } from "yaml";
  const doc = existsSync(path) ? parseDocument(readFileSync(path,"utf8")) : new Document({});
  doc.set("agents", agents.map(...));   // or doc.set("theme", theme)
  writeFileSync(path, String(doc));

That keeps comments and untouched keys byte-identical. Rung 5 of the ladder: the installed dep already solves it.

## 66. The project graph shows the entire Go TUI as 22 disconnected nodes — findGoModule can never find a nested go.mod

`src/graph/filegraph.ts:143` · **correctness**

**Evidence**

```
  const gomod = files.find((f) => basename(f) === "go.mod");
  if (!gomod && !existsSync(join(root, "go.mod"))) return undefined;

`files` comes from `walk`, which only pushes entries whose extension is in `SRC_EXT` (`.ts .tsx .js .jsx .mjs .cjs .py .go`, filegraph.ts:14 and :58). `extname("go.mod")` is `".mod"`, so `files` can never contain a go.mod and the `find` is dead code — only the root-level `existsSync` fallback ever fires. This repo's Go module lives at `tui/go.mod`, not at the root. Ran the real scanner on the real repo:

  nodes 109 edges 217 ms 13
  go nodes: 22
  go edges: 0

The filegraph test at filegraph.test.ts:38-48 passes only because its fixture puts go.mod at the root.
```

**Impact.** `GET /graph` and the TUI's project-graph view render amux's own Go TUI — a third of the codebase — as 22 orphan dots with no edges. Any user whose Go module is not at the repo root (the standard monorepo layout: `backend/go.mod`, `services/api/go.mod`) sees the same. The graph is a headline visual feature and it is wrong on the repo it ships from.

**Fix.** In `walk`, also collect `go.mod` alongside source files — change the else-branch condition at filegraph.ts:58 to `if (e.name === "go.mod" || (SRC_EXT.has(extname(e.name)) && !e.name.endsWith(".d.ts")))`, and filter go.mod out of `nodes` at line 40. The existing `findGoModule` logic and its `mod.dir` handling then work unchanged. Add a test mirroring filegraph.test.ts:38-48 with the fixture moved to `tui/go.mod`, since the current one cannot catch this.

## 67. A slow or crashed language server disables LSP permanently for the rest of the run

`src/lsp/client.ts:90` · **error-handling**

**Evidence**

```
  start(): Promise<void> {
    if (this.dead) return Promise.reject(this.dead);
    return (this.starting ??= this.spawnAndInitialize());
  }

`spawnAndInitialize` awaits `this.request("initialize", ...)`, which rejects after `REQUEST_TIMEOUT_MS` = 10_000 (client.ts:10, :171-174). That rejection does NOT call `die()`, so `this.dead` stays undefined — but `this.starting` is now permanently bound to a rejected promise, and `??=` will never reassign it. Every later `diagnostics()`/`hover()` re-awaits the same rejected promise. `LspRegistry.clientFor` (registry.ts:41-45) caches one `LspClient` per server name for the lifetime of the process, so nothing ever constructs a fresh one.
```

**Impact.** gopls or rust-analyzer taking more than 10 seconds to initialize on a cold cache (routine on a large repo) permanently disables the `diagnostics` and `hover` tools for the entire amux session, while leaving the language server process running and healthy but unreachable. Same outcome after any transient server crash, since `die()` on the `exit` event latches `this.dead` with no reset. The user's only recovery is restarting amux, and nothing tells them that — `runLspTool` reports 'language server unavailable' forever.

**Fix.** Make the memo self-clearing so the next caller retries: `this.starting = this.spawnAndInitialize().catch(e => { this.starting = undefined; throw e; })` in place of the `??=`. Also reset `this.dead`/`this.proc` there so a crashed server respawns on next use. Separately, raise `REQUEST_TIMEOUT_MS` for `initialize` specifically (30-60s) — it is the one request that legitimately takes tens of seconds, and reusing the per-request timeout for it is what makes the handshake the fragile step.

## 68. Command names in user-facing error text do not match any installed binary

`src/server/main.ts:24` · **ux**

**Evidence**

```
Real output from the installed package: `amux serve: no API key for 'anthropic'. Run: amux auth login (or export ANTHROPIC_API_KEY)`. But package.json:8 installs the bin as `amux-core`, and src/cli.ts:61-79 implements `auth` under that name; `amux` is the Go TUI, which has no `auth` subcommand (tui/cmd/amux/main.go parses no args at all). Meanwhile cli.ts's own header (:10-15) and banner say `amux-core init`, `amux-core auth login`.
```

**Impact.** A user hitting the most common first-run error is told to run `amux auth login`, which does not exist. Copy-pasting it either does nothing useful or launches the TUI. Three different names (`amux`, `amux-core`, `./amux`, `bun run src/cli.ts`) appear across README, cli.ts and server/main.ts for the same operations.

**Fix.** Pick one user-facing name and use it everywhere. Cheapest: keep the package's single bin as `amux` (npm allows a bin named `amux` from a package named `@scope/amux`), make it dispatch to the TUI by default and to the headless paths on subcommands, and rewrite every error string and README command to use it. If both binaries stay, make every message name the binary that owns the command — grep for the literal strings `amux serve:` and `Run: amux ` in src/server/main.ts and fix them to `amux-core`.

## 69. Unguarded `decodeURIComponent` on two request paths returns a Bun 500 HTML fallback page instead of JSON, and dumps a stack trace to stderr

`src/server/server.ts:309` · **error-handling**

**Evidence**

```
server.ts:309 `const agentId = decodeURIComponent(p.slice("/agents/".length, -"/message".length));` and server.ts:200 `const name = decodeURIComponent(p.slice("/commands/".length));`. Live probe with `curl --path-as-is -X POST '.../agents/%zz/message?token=...'` → HTTP 500 whose body is Bun's `<!doctype html> ... <script id="__bunfallback" type="binary/peechy">` page with the full request line base64'd into it, and server stderr shows `URIError: URI error at fetch (src/server/server.ts:309:25)`. Same for `/commands/%zz`.
```

**Impact.** Any client that URL-encodes an agent id or command name incorrectly gets an HTML page where the API contract promises JSON — `res.json()` in app.js:262 throws and the `.catch(() => ({}))` swallows it into a bare "failed" with no reason. The Bun fallback page also echoes the request (including the token in the query string) into the response body, and the server logs a stack trace for what is a malformed-input case.

**Fix.** One helper: `const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return null; } };` and return `json({ error: "bad path encoding" }, 400)` on null at both call sites. Better still, wrap the whole `fetch` body in try/catch returning a JSON 500 — right now ANY unexpected throw in a handler produces that HTML fallback.

## 70. `POST /agents` writes .amux/agents.yaml with no schema validation, so one malformed request can make the next startup throw

`src/server/server.ts:241` · **correctness**

**Evidence**

```
server.ts:241-246: the only check is `if (!Array.isArray(agents) || !agents.length) return json({ error: "expected agents[]" }, 400);` followed immediately by `saveAgents(agents)`. Anything array-shaped is persisted — `[1,2,3]`, `[{}]`, objects missing `id`/`provider`/`model`. main.ts:24 comments "Once agents.yaml exists we load it (invalid files still throw)", and `loadAgents()` is called outside any try/catch at that line.
```

**Impact.** A buggy or truncated wizard request (the onboarding flow this route exists for) writes a config that makes every subsequent `amux-core serve` / TUI launch throw at startup, with the user's real roster overwritten. There is no backup and no way back except hand-editing YAML.

**Fix.** Reuse the AgentConfig validation that `loadAgents` already performs (or a small zod schema) before `saveAgents`, returning 400 with the parse error. Belt and braces: have `saveAgents` write to a temp file and rename, keeping `.amux/agents.yaml.bak`.

## 71. resumeConversation replays every prior session for a task with no cap, and archiving is unreachable

`src/session.ts:24` · **perf**

**Evidence**

```
  export function resumeConversation(store: SessionStore, taskId: string): Turn[] {
    return store.listSessions({ taskId }).flatMap((s) => store.loadTurns(s.id));
  }

No limit, no token budget, no recency window. `listSessions` excludes archived rows (session-store.ts:163) — but `archiveSession` (:210) has zero production callers, confirmed by grep across all of src/; only db.test.ts:46 calls it. So no session is ever archived and the filter never prunes anything. The live database already holds 38 sessions for this project, 21 of them status `exhausted` (i.e. hit the turn cap without finishing) — exactly the sessions most likely to be resumed and least likely to contain a useful conclusion.
```

**Impact.** Each `amux resume` on the same task feeds the full transcript of every previous attempt into the model, then appends the new attempt to the store. Attempt N carries attempts 1..N-1 in its context. This compounds until the provider rejects the request on context length, and it silently multiplies cost on every resume before that. The `contextWindow(provider)` warning at agent.ts:~192 fires after the turns are already assembled.

**Fix.** Cap the replay where it is produced, so all callers inherit it. In `resumeConversation`, take only the most recent session (or the last N turns): `const s = store.listSessions({ taskId }); return s.length ? store.loadTurns(s[s.length-1]!.id) : []`, and mark it with a `ponytail:` comment naming the ceiling (last-session-only, upgrade to a token-budgeted window if resumes need deeper history). Alternatively wire `archiveSession` to a real caller — archive every session for a task when a newer one starts — which makes the existing `includeArchived` filter do the pruning it was built for.

## 72. In attached mode (AMUX_SERVER_URL) the picker's answers are silently discarded

`tui/cmd/amux/main.go:180` · **correctness**

**Evidence**

```
`startCore` returns `&core{client: ...}` with a nil `cmd` when `AMUX_SERVER_URL` is set (main.go:46-48), so `stop()` is a no-op (its guard is `c.cmd != nil`). main.go:180-183 then does:
	c.stop()
	if c, err = startCore(); err != nil { fatal(err) }

which in attached mode returns a brand-new client pointed at the same still-running server. Meanwhile the server explicitly refuses to hot-reload — src/server/server.ts:241-246:
		saveAgents(agents);
		return json({ ok: true, note: "saved to .amux/agents.yaml — restart the session to apply" });

The TUI never reads that `note`; `Client.SaveAgents` passes `nil` as `out` (client.go:377-379) so the response body is discarded.
```

**Impact.** Anyone using the documented attach path — a developer with `bun run serve` in one pane and the TUI in another — walks the entire 26-question picker, sees "✓ launching amux…", and lands in a session running the *old* roster from before the picker. The models they just chose are in agents.yaml but not in the engine, and nothing says so.

**Fix.** Have `core` record whether it spawned the process (`spawned bool`). In attached mode, either refuse the roster-changing path with a clear message ("attached to an existing core — restart it to apply a new team") or, better, surface the server's own `note` field: decode `CommandResult`-style responses in `SaveAgents` and show the note in the picker's status line.

## 73. The handshake read has no timeout, so a slow or hung core leaves the user on a blank screen indefinitely

`tui/cmd/amux/main.go:61` · **ux**

**Evidence**

```
main.go:60-65 blocks with no deadline and no feedback:
	r := bufio.NewReader(stdout)
	line, err := r.ReadString('\n')
	if err != nil { _ = cmd.Process.Kill(); return nil, fmt.Errorf("core did not hand shake: %w", err) }

The handshake is the last thing the core prints (src/server/main.ts:56), after everything else in `serveMain` — including `await mcp.connect(mcpServers, ...)` at src/server/main.ts:33. An MCP server over stdio that starts but never completes its handshake will hold that await open. Nothing has been drawn on screen at this point: the first Bubbletea program doesn't start until main.go:172.
```

**Impact.** A misconfigured or slow MCP server (a container pull, a network-backed server, a binary that hangs) makes `amux` hang with a completely blank terminal and no output, no spinner, no way to tell whether it's working. The user's only signal is that nothing happened. The same applies to a slow-loading model catalog or a cold SQLite.

**Fix.** Wrap the read in a select with a timeout — do the `ReadString` in a goroutine feeding a channel, and after ~2s print "starting the core…" to stderr (it's still the normal screen at this point, so it's safe), then hard-fail after ~30s with "the core did not start within 30s — check .amux/core.log". Fixing the stderr routing (see the stderr finding) makes the core's own progress messages available to show here.

## 74. Pasting into the ctrl+p model filter is silently dropped

`tui/internal/session/carousel.go:134` · **ux**

**Evidence**

```
carousel.go:134-138:
	if s := k.String(); len([]rune(s)) == 1 || s == " " {
		m.car.query += s
		m.car.list.SetQuery(m.car.query)
	}

Bubbletea delivers a paste as a single `KeyMsg{Type: KeyRunes, Paste: true}` whose `String()` is the whole payload wrapped in brackets. Measured with a probe:

  after paste of "gpt-4o" -> query="" (String()="[gpt-4o]")
  PASTE DROPPED: carousel query is empty after pasting 'gpt-4o'

The carousel is also the surface most likely to receive a paste, since carouselConfirm (carousel.go:154-171) explicitly supports typing a `provider/model` id the catalog doesn't list.
```

**Impact.** A user copies a long model id (`accounts/fireworks/models/llama-v3p1-405b-instruct`) from a provider's docs, hits ctrl+v in the carousel, and nothing happens — no character appears, no error. Every other key is swallowed too, so ctrl+v (`String()=="ctrl+v"`) is also discarded. The only way to enter an off-catalog model id is to type it by hand, character by character.

**Fix.** Handle the runes rather than the stringified key: `if k.Type == tea.KeyRunes { m.car.query += string(k.Runes); m.car.list.SetQuery(m.car.query); return nil }` — this covers single keystrokes, pastes and multi-rune input uniformly, and keeps the existing `len==1` special case unnecessary. `themePickerKey` should get the same treatment if a filter is ever added there.

## 75. A long or multi-line paste into the prompt is silently truncated and flattened

`tui/internal/session/session.go:137` · **ux**

**Evidence**

```
session.go:135-137:
	ti := textinput.New()
	...
	ti.CharLimit = 4000

`textinput` is single-line by construction. Measured:

  pasted 6000 chars -> input holds 4000
  multiline paste -> input="line one line two line three"

No warning, no visual indication, no status message. The truncated 2000 characters are simply gone, and the newlines that structured the paste are replaced by spaces.
```

**Impact.** Pasting a stack trace, a failing test's output, a code block, or a long spec into the prompt — the single most common way anyone talks to a coding agent — silently loses content and destroys line structure. The user hits enter and the agent works from a corrupted prompt. Because both failures are silent, the user will blame the model.

**Fix.** Switch the prompt to `bubbles/textarea` (already a dependency — diffview.go:9 imports it) with a height that grows to a few rows and shift+enter for a newline, or at minimum: raise `CharLimit` to something like 100_000 and set `m.status` to "pasted input was truncated at N characters" when `len(value) == CharLimit` after a paste, so the loss is at least visible.

## 76. session.truncate() measures in runes, not display cells, so wide glyphs get double their width budget

`tui/internal/session/session.go:695` · **correctness**

**Evidence**

```
session.go:692-708 — the doc comment claims correctness ("Counts runes, not bytes: the UI is full of multibyte glyphs") but rune count is not cell width:
	r := []rune(s)
	if len(r) <= n { return s }
	...
	return string(r[:n-1]) + "…"

Measured:

  truncate(10 emoji, 10) -> 10 runes / 20 display cells

The module already contains the correct implementation, `ui.Truncate` (list.go:247-255), which uses `lipgloss.Width` and `MaxWidth`. So there are two truncators with the same name-shape, one right and one wrong, and `session.truncate` is the one used ~40 times across view.go, settings.go, stats.go, diffview.go and output.go.
```

**Impact.** Any CJK text, emoji or wide box glyph in an agent's output, a file path, a role name or a commit message makes every column computation in the frame wrong. `agentHeader`'s gap calculation (view.go:433) under-pads and the status flag drifts left; sidebar rows overrun their `iw`; the `kv` grid in the settings overlay misaligns. The whole frame is saved from visible tearing only by the single `MaxWidth(w)` at view.go:125 — but `settingsView` (settings.go:111) and `diffView` (diffview.go:245) have no `MaxWidth` at all, so they rely entirely on `truncate` being correct.

**Fix.** Make `session.truncate` delegate: keep the newline collapsing and the `n<=0` guard, then `return ui.Truncate(s, n)` for the cut, appending the ellipsis via `ui.Truncate(s, n-1) + "…"`. One function body changes and all ~40 call sites become width-correct. Add `MaxWidth(w)` to `settingsView` and `diffView` as a belt-and-braces guarantee to match `View`.

## 77. API keys are echoed in plaintext in the picker and capped at 200 characters

`tui/internal/wizard/picker.go:56` · **security**

**Evidence**

```
picker.go:56-62:
	func NewPicker(client *api.Client) Picker {
		ti := textinput.New()
		ti.Focus()
		ti.CharLimit = 200

One textinput is reused for every stage including the credential stage (picker.go:178-186 sets `m.stage = "key"` and only changes the Placeholder). `grep -rn EchoMode tui/` returns nothing, so `EchoMode` stays the default `EchoNormal`. The stage's own hint text at picker.go:500 says "paste the API key (or a local base URL) — stored outside the repo", i.e. pasting is the expected interaction.
```

**Impact.** The key is rendered in full on screen for as long as the stage is open — visible over a shoulder, in a screen share, in a demo recording, and in any terminal screenshot attached to a bug report. Separately, `CharLimit = 200` silently truncates anything longer; several providers issue keys and OAuth tokens well past 200 characters, and the truncated value is POSTed to `/auth` and stored as if valid, so the failure surfaces much later as an authentication error against a key the user believes they entered correctly.

**Fix.** On entering the `key` stage set `m.input.EchoMode = textinput.EchoPassword` and `m.input.EchoCharacter = '•'`, restoring `EchoNormal` on every other stage (both transitions belong in the `stage = "key"` assignment at picker.go:179-182 and in `toProvider`/`toModel`). Raise `CharLimit` to 4000 for that stage, or drop the limit and validate length server-side where a real constraint can be reported.

## 78. The picker's error stage is a dead end with no retry and no visible way out

`tui/internal/wizard/picker.go:96` · **ux**

**Evidence**

```
picker.go:95-99:
	case providersMsg:
		if len(msg.providers) == 0 {
			m.stage, m.err = "error", "could not load the provider catalog: "+errText(msg.err)
			return m, nil
		}

`fetchCatalog` is issued exactly once, from `Init` (picker.go:64-66). `advance` has no `error` case and falls through to `return m, nil` (line 246); `back` has no `error` case either. `stageText` returns `"", "", ""` for any unlisted stage (picker.go:510), and the error branch of `View` (picker.go:453-456) passes `""` for both hint and input:
		return screen(m.width, m.height, "pick your team", fit(...), <the error>, "", "")

So the card shows an error message and nothing else — no keys, no retry prompt.
```

**Impact.** A transient failure fetching the catalog (the core still warming up, an MCP connect that delayed the server, a network blip on the models catalog) leaves a first-run user staring at a card with an error and zero affordances. enter does nothing, esc does nothing. Only ctrl+c gets out, and nothing on screen says so. This is the first screen a new user ever sees, which makes it the worst place in the product for a dead end.

**Fix.** Give the error stage a hint and a retry: `case "error": return section("PROBLEM"), "enter retries · ctrl+c quits", ""` in `stageText`, and in `advance` add `case "error": m.stage = "loading"; return m, fetchCatalog(m.client)`. Two small additions turn a dead end into a recoverable one.

## 79. Unescaped interpolation of task ids/status/deps into innerHTML, on a page whose URL carries the god-token

`web/app.js:185` · **security**

**Evidence**

```
renderTasks (app.js:183-191) escapes only two of five interpolations: `<span class="id">${t.id}</span>`, `<span class="st ${t.status}">${t.status.replace("_"," ")}</span>` and `depends on ${t.dependsOn.join(", ")}` are raw, while `esc(t.role)` and `esc(t.description)` are escaped. renderMessages (app.js:199) likewise interpolates `kind-${m.kind}` and `· ${m.kind}` raw. Upstream normalisation saves it today — planner.ts:109 rewrites every task id to `t${i+1}` and agent.ts:499 whitelists message kinds — but `loadTasks()` (src/session.ts:16-20) is `JSON.parse(readFileSync(path)).tasks` with no validation whatsoever, and those tasks reach the dashboard verbatim via `/session` → app.js boot():454.
```

**Impact.** A `.amux/session.json` containing `{"tasks":[{"id":"<img src=x onerror=fetch('/prompt?token='+new URLSearchParams(location.search).get('token'),{method:'POST',...})>"}]}` executes in the dashboard, where `TOKEN` is sitting in `location.search` and every gated route (including `POST /prompt`, i.e. arbitrary agent execution) is one fetch away. .amux/ lives inside the project tree that agents write to and that users clone from strangers.

**Fix.** Wrap all five interpolations in the existing `esc()` (and extend `esc` to escape `"` and `'` so attribute contexts are safe, matching theme.js:77-79). Separately, validate `loadTasks()` output shape in src/session.ts — an unvalidated `JSON.parse` of a project-local file feeding a privileged page is the root cause, and fixing it there protects the TUI too.

## 80. Every streamed token rebuilds a 300-line panel via innerHTML, and in graph.js's Models mode every token rebuilds the entire graph

`web/app.js:161` · **perf**

**Evidence**

```
app.js:161 `if (openAgentId === ae.agentId) renderAgentPanel();` runs for EVERY agent_event including `type:"delta"`, and renderAgentPanel (236-249) does `log.innerHTML = lines.map((l) => `<div>${esc(l)}</div>`).join("")` over up to 301 lines (`pushLog` caps at 300 + `pending`) plus a `log.scrollTop = log.scrollHeight` forced layout. graph.js:119-121 `else if (e.kind === "agent_event") { ... syncModels(); }` — and `syncModels` (87-91) calls `setGraph`, which reallocates the whole nodes array, recomputes every ring position, rebuilds `adj` as N fresh Sets, re-sorts `labelOrder`, re-runs `applySearch` and touches `q("stat").innerHTML`.
```

**Impact.** During normal streaming (tens of deltas per second per agent, several agents in parallel) the open agent panel destroys and recreates ~300 DOM nodes plus a synchronous layout read per token chunk, and the graph page rebuilds its entire model per token chunk. This is exactly when the user is watching, and it competes with the 60fps canvas loop on the same thread.

**Fix.** app.js: in `feedDelta`, append a single `<div>` (or update the last one) instead of re-rendering — `renderAgentPanel` only needs the full rebuild when the panel is opened or the agent's status changes. graph.js: make the `agent_event` branch call `syncModels()` only when `n.status` actually changed (`const before = n.status; ...; if (n.status !== before) syncModels();`).

## 81. An unauthorized or missing token is indistinguishable from a network problem in both web pages

`web/app.js:73` · **ux**

**Evidence**

```
app.js:449-457 `const res = await fetch('/session?token=...', {method:"POST"}); if (res.ok) {...}` — a 401 falls through the `if` with no message, and the surrounding `catch { /* server not reachable yet — SSE will retry */ }` conflates the two. app.js:73 `es.onerror = () => { conn.textContent = "reconnecting…"; ... }` — EventSource does not reconnect after a non-200 response, so "reconnecting…" is permanently wrong for a 401. graph.js:58-68 never checks `r.ok` at all: a 401 body `{"error":"unauthorized"}` makes `g.nodes.map` throw, caught, and the user sees `setConn("failed to load", "dead")`.
```

**Impact.** Opening `/dashboard` from a bookmark or history (the token changes every process start, since it's a fresh `crypto.randomUUID()`) yields a permanently empty page that claims it is reconnecting. This is the single most likely first-run failure — the URL with the token is printed once to the console and is stale the moment the process restarts — and the UI actively misdirects the user toward a network diagnosis.

**Fix.** Check `res.status === 401` in both boot paths and render an explicit "unauthorized — reopen the dashboard from the TUI (/dashboard) to get a fresh token" banner; in `es.onerror`, distinguish `es.readyState === EventSource.CLOSED` (fatal, show "disconnected/unauthorized") from `CONNECTING` (genuinely reconnecting).

## 82. Themes only half-apply: the graph page's controls and the dashboard's canvas ignore the palette entirely

`web/theme.js:21` · **ux**

**Evidence**

```
`applyPalette` (theme.js:21-37) sets exactly 12 custom properties: --bg, --panel, --panel-2, --ink, --muted, --line, --violet, --green, --red, --amber, --blue, --pink. graph.html's inline stylesheet additionally defines and uses `--bg2` (the `.seg`, `.btn`, `.search` and `kbd` backgrounds — graph.html:36,39,43,51) and `--panel-solid` (`#tip`, line 61), neither of which theme.js ever sets. On the dashboard, app.js's canvas hardcodes `ctx.fillStyle = "#e7e9f2"` for both label rows (app.js:423,425), `"#8b90a6"` for the token count (427), and the whole `KIND_COLORS`/`STATUS_FILL` tables (app.js:7-15).
```

**Impact.** Pick a light palette: the graph page turns light while its search box, mode toggle, buttons and tooltip stay near-black (#0d0f16), and the dashboard's canvas — the main content area — draws near-white agent labels on a near-white background, i.e. invisible. The theme carousel is a headline feature (recent commit 77192f1) that visibly breaks on half the surfaces it claims to cover.

**Fix.** Add `--bg2` and `--panel-solid` to `applyPalette` (map both to `p.bg` / `p.panel`, mirroring how `--panel-2` already reuses `p.panel`). In app.js, read the palette off the computed root style once per frame — `const ink = getComputedStyle(document.documentElement).getPropertyValue("--ink")` cached on theme change — instead of the hardcoded hexes; graph.js has the same hardcoded issue for its `#cfd3e6` labels (line 458).

## 83. There is no CI of any kind — no workflow, no pipeline, no pre-commit — for a repo with three toolchains and a suite that is currently red on a clean checkout

`package.json:10` · **maintainability**

**Evidence**

```
`ls -la .github` → `No such file or directory`. There is no `.gitlab-ci.yml`, no `Makefile`, no `justfile`, no git hooks directory in the tree. The three verification commands live only as prose in README.md:188-192 (`bun test`, `bunx tsc --noEmit`, `cd tui && go build ./... && go vet ./... && go test ./...`) and as four package.json scripts. Nothing runs them.
```

**Impact.** Nothing catches the two critical breakages above. `bun run build:tui` has been broken for every non-maintainer since the .gitignore pattern was written, and `bun test` has been red on clean checkouts since ink/react fell out of the lockfile — both would have failed on the first CI run. With three toolchains (Bun, Go, browser scripts) and a hand-rolled test-file glob, drift is the default state.

**Fix.** One `.github/workflows/ci.yml` with a single job: `oven-sh/setup-bun` + `actions/setup-go`, then `bun install --frozen-lockfile`, `bun run typecheck`, `bun test src web`, and `cd tui && go build ./... && go vet ./... && go test ./...`. Skip the matrix, skip caching, skip release automation — a single ubuntu-latest job that runs the four commands the README already documents is the whole fix, and it is what would have caught both criticals.

## 84. `github-models` is in the catalog and in ALLOW_IDS but no longer exists upstream, and the generator warns about nothing

`scripts/gen-catalog.ts:83` · **maintainability**

**Evidence**

```
`catalog.generated.ts:91-97` ships a `"github-models"` entry. A live fetch of https://models.dev/api.json during this audit returns 178 providers, and `github-models` is not among them — the only github-ish id is `github-copilot`. Verified: `ALLOW ids absent from upstream: ["github-models"]`. The generator's loop (`gen-catalog.ts:82-108`) iterates upstream providers and tests them against ALLOW_IDS; an ALLOW_ID with no upstream match simply never fires and is never reported. The success line at :127 prints only `${generated} providers, ${skipped} skipped`.
```

**Impact.** Re-running `bun run gen:catalog` today silently drops `github-models` from the catalog. Any user whose `.amux/agents.yaml` pins `provider: github-models` then hits `factory.ts:13` — `unknown provider 'github-models'` — on the next release, with no migration and no deprecation. More generally the ALLOW_IDS list is now a hand-maintained allowlist that rots against a registry that visibly changed within days, and nothing detects the rot.

**Fix.** After the loop in `gen-catalog.ts`, diff and shout: `const seen = new Set(Object.values(data).map(p => p.id)); const missing = [...ALLOW_IDS].filter(id => !seen.has(id)); if (missing.length) console.warn('ALLOW_IDS no longer in models.dev:', missing.join(', '));` — and exit non-zero in CI. Decide whether `github-models` should be re-pointed at `github-copilot` or dropped from ALLOW_IDS.

## 85. `spawn_fork` is ungated, uncounted and unbudgeted in breadth

`src/agent/agent.ts:421` · **correctness**

**Evidence**

```
'''
    if (call.name === "spawn_fork") return this.fork(String(call.input.goal ?? ""), ctx);
'''
This returns *before* the permission resolution at line 440 and before the approval at line 448. The spec is appended in `buildTools` (lines 372-379) without consulting `allowedTools`. `MAX_FORK_DEPTH = 2` (line 24) caps nesting only — `fork()` checks `ctx.forkDepth + 1 > MAX_FORK_DEPTH` (line 269) — while breadth is bounded only by `maxTurns` per loop.
```

**Impact.** Worst case per task: the parent loop can emit `spawn_fork` on each of its 12 turns; each child loop can do the same at depth 1; depth-2 children run a full 12-turn loop each. That is on the order of 12 × 12 = 144 sub-loops of up to 12 provider calls, all on the user's billed key, from a single task, with no cost ceiling, no `shouldStop`, no approval and nothing in the UI aggregating the spend beyond the usage counter ticking up. An agent explicitly configured with `allowedTools: []` (as the engine.test.ts fixtures do) still gets the tool.

**Fix.** Two guards. (1) Count forks per session: add `private forkCount = 0` and refuse past ~4 per loop with the same string style as the depth cap (`"fork budget exhausted — do this work yourself."`). (2) Route `spawn_fork` through `resolvePermission` like everything else by moving the early return at line 421 below the decision at line 440, so a project can write `permissions: { spawn_fork: { "*": deny } }`.

## 86. The undo checkpoint is a pre-approval snapshot, so undo can silently destroy a concurrent user edit

`src/agent/agent.ts:430` · **correctness**

**Evidence**

```
'''
    // The file as it stands right now — used for the approval diff and, once approved, the undo
    // checkpoint. Read once: re-reading after the prompt would race the user's own edits.
    const before = WRITE_TOOLS.has(call.name) ? await this.readForCheckpoint(String(call.input.path ?? "")) : undefined;
'''
That `before` is what gets stored at line 467 (`this.store?.checkpoint(sessionId, safePath(this.root, lockPath), before ?? null)`) — after the approval await at line 448. Meanwhile the actual edit re-reads the file at execution time (src/tools/tools.ts:62, `const before = await readFile(abs, "utf8")`).
```

**Impact.** User opens the approval dialog for `edit app.ts`, then fixes a typo in `app.ts` in their editor before clicking approve. The edit itself applies correctly (runTool re-read the fresh file). But the checkpoint holds the pre-typo-fix content. A later `/undo` or `/rewind` restores that stale snapshot and the user's typo fix is gone, with the UI reporting `restored app.ts` as a success. The comment acknowledges the race but resolves it in the direction that loses data rather than the direction that reports a conflict.

**Fix.** Re-read the file under the lock, just before the checkpoint write at agent.ts:466-467, and store *that* as the checkpoint (keep the earlier read solely for the approval diff). If the two differ, publish a `warning` event (`app.ts changed while awaiting approval`) so the user knows the diff they approved was against older content. The lock is already held at that point, so nothing can slip in between the snapshot and the write.

## 87. DANGEROUS_PATTERNS is the last line of defence under --auto and is trivially evaded

`src/agent/agent.ts:33` · **security**

**Evidence**

```
'''
const DANGEROUS_PATTERNS = [
  /rm\s+-rf/,
  /git\s+reset\s+--hard/,
  /drop\s+table/i,
  /git\s+push\s+--force/,
  /:\(\)\s*\{/, // fork bomb
];
'''
Verified against the real resolver with a `deny` rule in place:

  resolve([{shell:{"git push --force*":"deny"}}, AUTO_RULES], "shell", {command:"git", args:["push","-f"]}) -> allow

and the pattern list itself misses `rm -fr`, `rm -r -f`, `rm --recursive --force`, `git push -f`, `find . -delete`, `truncate -s0`, `dd of=`, and anything routed through `sh -c`.
```

**Impact.** Under `--auto` (or an `autoApprove: [shell]` agent, or headless), the *only* thing that still forces a prompt is this five-regex list, and every entry has a shorter synonym the model may well prefer. `git push -f` is idiomatic and slips through both the deny rule and the dangerous check. The invariant the code advertises — "a config allow can never downgrade a dangerous command" (agent.ts:447) — holds only for the exact spellings listed.

**Fix.** Match on the *command* plus a flag-set rather than a substring: parse `args` for `rm` with any of `-r/-R/--recursive` and `-f/--force` in any order or combination; treat `git push` with `-f`/`--force`/`--force-with-lease` as one case; add `sh`/`bash`/`zsh`/`python`/`node` with `-c`/`-e` as inherently forceAsk (they are opaque). Roughly 15 lines in `isDangerousShellCall`, and it is directly testable — agent.test.ts:292 already has the harness for it.

## 88. `subLoop` (respond/fork) has no context management at all

`src/agent/agent.ts:304` · **correctness**

**Evidence**

```
The loop body at lines 304-318 records `reply.usage` into the tracker (line 308) but performs none of run()'s window handling: no `overContextThreshold` warning, no `compactTurns`, and no `recordRateLimit` (compare agent.ts:206-227). A fork runs at the agent's full `maxTurns` (line 273), so it accumulates the same volume of tool results as a top-level run.
```

**Impact.** A fork that reads several files runs until the provider rejects it for context length. That throw is caught at line 321 and converted into the string `fork failed: <error>`, which is handed back to the parent model as the fork's *findings* (agent.ts:421 → `results.push({... output })`). The parent then reasons over an error message as if it were a research result, and nothing in the UI distinguishes a failed fork from an unproductive one — `subLoop` never publishes an `error` event, only the `thought` at line 270 when the fork started.

**Fix.** Extract the four-line window block from run() (agent.ts:209-227) into a private `manageWindow(turns, reply, id)` and call it from both loops. Separately, publish an `error` event before returning the failure string at line 323 so a failed fork is visible in the feed rather than only inside the parent's context.

## 89. 'context length exceeded' is classified as exhaustion, producing four guaranteed-identical failures

`src/agent/agent.ts:66` · **correctness**

**Evidence**

```
`isExhaustion` returns true for `(m.includes("context") && m.includes("exceed"))` (agent.ts:66). The scheduler treats `"exhausted"` as retryable (scheduler.ts:210) and reruns the *same prompt* on the *same model*: the retry call is `runner.run(prompt, { taskId: t.id })` with no priorTurns, so `turns` starts as just `[{role:'user', text: prompt}]` — byte-identical every time. Unlike a 429, a context-window overflow is deterministic.
```

**Impact.** A task with a large `depContext` (scheduler.ts:197-203 concatenates every prerequisite's full output, unbounded) overflows the window. amux retries 4 times with the identical oversized prompt, sleeping 0.5s/1s/1.5s, then fails, then burns a replan call. Four guaranteed-failing billed API calls per affected task, and every dependent then cascades to failed.

**Fix.** Drop the context clause from `isExhaustion` (agent.ts:66) so overflow classifies as `"failed"` and goes straight to the replan gate, where the lead can shorten the task. Separately, bound the fan-in at scheduler.ts:200: `.map(d => \`--- Output from ${d.assignedTo} ("${d.description}") ---\n${(d.output ?? "").slice(0, 4000)}\`)` — a magic number, but a deterministic ceiling beats a deterministic 400.

## 90. SHELL_LOCK serializes every shell command across every agent — a global mutex on the hottest tool

`src/agent/agent.ts:30` · **perf**

**Evidence**

```
`export const SHELL_LOCK = "*shell*";` (agent.ts:30) with the acknowledging comment 'ponytail: one global lock for all shell calls instead of per-path'. Every shell call takes it: agent.ts:461 `: sandboxCall.tool === "shell" ? SHELL_LOCK : undefined`, then `await this.locks.acquire(lockPath, id)`. Waiters poll every POLL_MS = 50 (locks.ts:4).
```

**Impact.** The headline feature is N agents working concurrently. In practice agents shell constantly — `git diff`, `ls`, `grep`, `bun test`. With 4 agents every one of those calls is globally serialized behind a single mutex, so real parallelism collapses toward 1x for shell-heavy work. Compounded by the previous finding: a >60s shell (a test run) blocks every other agent for a full minute and then gets its lock stolen anyway, which is the worst of both — no parallelism AND no exclusion.

**Fix.** Most shell calls are read-only and need no lock at all. A cheap, boring 90% fix in agent.ts:460: only take SHELL_LOCK when the command can mutate — `const MUTATING = /^\s*(git|npm|bun|pnpm|yarn|make|rm|mv|cp|mkdir|touch|sed\s+-i|>>?)/;` and pass `undefined` otherwise. That leaves the ceiling honestly documented (the existing ponytail comment) while restoring parallelism for the common case.

## 91. Context compaction issues a second billed model call whose token usage is never recorded

`src/agent/context.ts:27` · **correctness**

**Evidence**

```
`agent.ts:220-226` calls `await compactTurns(turns, this.provider)` when input tokens cross `COMPACT_RATIO`. Inside, `context.ts:27-31`:
'''ts
const { text } = await provider.send(
  "Summarize this conversation excerpt in 2-4 sentences: …",
  [{ role: "user", text: transcript }],
  [],
);
'''
Only `text` is destructured. `ProviderReply.usage` is discarded, and `agent.ts` records usage exclusively from the main loop's reply (`agent.ts:206`: `if (reply.usage) this.usageTracker?.record(...)`). No call to `usageTracker.record` exists anywhere in `context.ts`.
```

**Impact.** By definition compaction only fires on the *longest* conversations, and its prompt is the entire pre-compaction transcript — the most expensive single input in the run. That call is billed by the provider and invisible to amux: the TUI cost readout, `emitUsage`'s totals (`engine.ts:352-360`), the `/export` report (`commands/export.ts:65`) and the dashboard all under-report. Worse, it is invisible to the context-depth accounting too, so the number amux uses to decide whether to compact again excludes the compaction it just did.

**Fix.** Have `compactTurns` return usage alongside the turns, or take the tracker: change `context.ts:15` to accept an optional `onUsage?: (u: Usage) => void` and call it, then pass `(u) => this.usageTracker?.record(id, u.inputTokens, u.outputTokens)` from `agent.ts:223`. Three lines.

## 92. Approval scope "path" is a silent no-op for files at the project root

`src/approval.ts:70` · **ux**

**Evidence**

```
'''
    if (ok && scope === "path" && typeof req.input.path === "string") {
      const dir = req.input.path.split("/").slice(0, -1).join("/") || ".";
      this.grant(req.agentId, req.tool, `${dir}/**`);
    }
'''
For `README.md` the computed pattern is `./**`. Verified against the real matcher:

  new Bun.Glob("./**").match("a.txt")     -> false
  new Bun.Glob("./**").match("src/a.txt") -> false

so `isAllowed` (approval.ts:38) never matches and the grant is inert.
```

**Impact.** A user who clicks "always allow this directory" while approving a write to a root-level file (README.md, package.json, tsconfig.json, AGENTS.md — the common case early in a run) gets no grant at all and is re-prompted for every subsequent write to the same file. There is no error and no feedback; the UI reports the scope was applied. On Windows-style paths (`src\\a.ts`) the same code yields `dir === "."` too, so the scope is inert for every file.

**Fix.** Use `posix.dirname` and emit a pattern the matcher actually accepts: `const dir = dirname(req.input.path.replaceAll("\\\\", "/")); this.grant(req.agentId, req.tool, dir === "." ? "*" : `${dir}/**`)`. Combine with the path normalization from the first finding so `./README.md` and `README.md` produce the same grant. Add the root-level case to approval.test.ts:57 — the existing test only covers a nested path, which is why this ships green.

## 93. `--port=` is never validated: a non-numeric value silently binds a random port, an out-of-range value is silently clamped

`src/cli.ts:85` · **correctness**

**Evidence**

```
src/cli.ts:83-85
  const portArg = args.find((a) => a.startsWith("--port="));
  ... await serveMain({ port: portArg ? Number(portArg.slice(7)) : undefined, ... })

Reproduced:
$ bun src/cli.ts serve --port=abc
{"amuxServer":{"url":"http://127.0.0.1:61134", ...}}      # Number("abc") === NaN -> Bun picked a random port
$ bun src/cli.ts serve --port=99999
{"amuxServer":{"url":"http://127.0.0.1:65535", ...}}      # silently clamped

The space-separated form is silently ignored too: `--port 3000` fails the `startsWith("--port=")` test, so `portArg` is undefined and `3000` is discarded by the flag filter with no message. The identical unvalidated parse is duplicated at src/server/main.ts:61.
```

**Impact.** A user or systemd unit running `amux-core serve --port 8080` (space form, the convention most CLIs accept) gets a random ephemeral port with no warning; whatever was configured to connect to 8080 fails with a connection refused that points nowhere. `--port=$PORT` in an environment where `$PORT` is unset expands to `--port=` → `Number("")` === 0 → random port, same silent failure.

**Fix.** Extract one helper used by both entry points: `function parsePort(args: string[]): number | undefined { const i = args.findIndex(a => a === "--port" || a.startsWith("--port=")); if (i < 0) return undefined; const raw = args[i].includes("=") ? args[i].slice(7) : args[i+1]; const n = Number(raw); if (!Number.isInteger(n) || n < 1 || n > 65535) die(\`--port needs an integer 1-65535, got '${raw ?? ""}'\`); return n; }` Import it in src/server/main.ts:61 rather than re-implementing.

## 94. API keys are prompted with Bun's `prompt()`, which echoes them in cleartext into terminal scrollback

`src/cli.ts:217` · **security**

**Evidence**

```
src/cli.ts:42   const key = prompt(`Enter API key for ${args[2]}:`)?.trim();      // amux-core keys set
src/cli.ts:217  const key = prompt(`API key for ${entry!.label}:`)?.trim();       // amux-core auth login

Bun's global `prompt()` has no masking option. Every other layer of this stack treats the same value as a secret: src/auth/auth-store.ts:35-44 writes it to a 0600 file inside a 0700 dir with an explicit `chmodSync(path, 0o600)` follow-up 'enforce even if the file pre-existed with looser perms', and mirrors it into the OS keychain.
```

**Impact.** `amux-core auth login anthropic` renders `sk-ant-api03-…` on screen. It survives in scrollback, in `tmux`/`screen` capture buffers, in any terminal-recording tool, and in the CI log if someone pipes a key in. The care taken with 0600 file permissions downstream is defeated at the point of entry.

**Fix.** Read the key without echo instead of using `prompt()`. On Bun/Node this is a short helper: set `process.stdin.setRawMode(true)`, accumulate bytes until `\r`/`\n`, echo nothing, restore raw mode in a `finally`. Guard it with `process.stdin.isTTY` and fall back to `prompt()` when stdin is a pipe. Also accept the key from an env var or stdin so scripts never need the interactive path at all: `if (!process.stdin.isTTY) key = (await Bun.stdin.text()).trim();`.

## 95. `amux-core keys set <provider>` accepts any provider string without a catalog lookup, so a typo stores a key that will never be used

`src/cli.ts:44` · **ux**

**Evidence**

```
src/cli.ts:40-49
  if (args[0] === "keys") {
    if (args[1] === "set" && args[2]) {
      const key = prompt(`Enter API key for ${args[2]}:`)?.trim();
      if (!key) die("no key entered");
      setKey(args[2], key!);                                   // <- args[2] never checked
      console.log(`Stored ${args[2]} key in the OS keychain.`);

The sibling path does validate — src/cli.ts:199-200:
  const entry = CATALOG[provider];
  if (!entry) die(`unknown provider '${provider}'. Try one of: ${providerKeys().slice(0, 16).join(", ")}, …`);
```

**Impact.** `amux-core keys set antrhopic` prints `Stored antrhopic key in the OS keychain.` — a confident success message for a key that no provider will ever look up. The user then hits an auth failure at first model call and has no reason to suspect the keychain entry, because the CLI told them it worked. The stale entry also sits in the OS keychain indefinitely with no `keys list` / `keys rm` to find or remove it (only `auth list`/`auth logout` exist, and they read the auth.json store, not the keychain).

**Fix.** Add the same guard the `auth login` path already has, at src/cli.ts:41: `if (!CATALOG[args[2]]) die(\`unknown provider '${args[2]}'. Try: ${providerKeys().slice(0,16).join(", ")}, …\`);` — CATALOG and providerKeys are already imported on line 29. Given that line 14's own comment calls `keys set` 'legacy; `amux-core auth login` is preferred', the smaller change is to delete the `keys` branch entirely and print `use: amux-core auth login <provider>`.

## 96. `engine.submit(goal).catch((e) => console.error("run error:", e))` prints a full stack trace to users, unlike every other error path

`src/cli.ts:105` · **error-handling**

**Evidence**

```
src/cli.ts:105  if (goal) engine.submit(goal).catch((e) => console.error("run error:", e));

Every other error surface in the file deliberately strips the stack:
src/cli.ts:191  const msg = err instanceof Error ? err.message : String(err);
src/cli.ts:35   console.error(`amux: ${msg}`);
registry.ts:332 message: `/${name} failed: ${err instanceof Error ? err.message : err}`

`console.error("run error:", errorObject)` renders the Error with its `.stack`, and the prefix `run error:` carries no `amux:` namespace either.
```

**Impact.** In `--web` mode, a provider 401 or a network reset dumps a multi-line V8 stack with absolute paths from the user's machine into the terminal, while the browser dashboard shows nothing. It is both noisier and less actionable than the one-line `amux: <message>` the same class of failure produces in every other path, and it breaks the line-oriented stdout/stderr contract the headless path is careful about (cli.ts:147-152).

**Fix.** Match the house style at src/cli.ts:105: `engine.submit(goal).catch((e) => console.error(\`amux: run failed: ${e instanceof Error ? e.message : e}\`));`. The same treatment applies to line 172's MCP handler, which interpolates a raw `err` into a template string.

## 97. `/cost` and `/export` silently drop spend for any agent not currently in `engine.configs`, under-reporting the total

`src/commands/registry.ts:179` · **correctness**

**Evidence**

```
src/commands/registry.ts:177-186
  for (const { agentId, usage } of engine.usage.snapshot()) {
    const cfg = engine.configs.find((c) => c.id === agentId);
    if (!cfg) continue;                       // <- spend discarded, not just unpriced
    const { usd, priced } = costOf(cfg.provider, cfg.model, usage.inputTokens, usage.outputTokens);
    total += usd;
    if (!priced) complete = false;

Identical logic duplicated in src/commands/export.ts:62-69, including the same `if (!cfg) continue;`.

The design already has a mechanism for 'we can't price this' — the `priced` flag drives `complete`, which appends a `+` to the total (registry.ts:186, export.ts:70) so the UI can show `$0.42+`. The `continue` path bypasses it entirely: those tokens vanish from both the per-agent lines and the total, with no `+`.
```

**Impact.** `UsageTracker` is keyed by agentId and never pruned (usage.ts:16), so it retains an agent's tokens after that agent leaves `engine.configs` — which happens whenever `.amux/agents.yaml` is edited and reloaded, or an agent id is renamed mid-session. Those tokens were paid for and are then reported as $0.0000 with no indication anything is missing, so `/cost` and the exported audit report both understate real spend while presenting the number as complete (no `+`).

**Fix.** Reuse the existing incompleteness signal instead of dropping the row. In both files replace `if (!cfg) continue;` with `if (!cfg) { complete = false; lines.push(\`${agentId.padEnd(16)} ${usage.inputTokens}in ${usage.outputTokens}out  (agent no longer configured — unpriced)\`); continue; }`. Since the block is now ~12 identical lines in two files, lift it into one exported `costLines(engine)` helper in export.ts and have registry.ts's `/cost` call it — the duplication is what let the two copies stay in lockstep with the same bug.

## 98. User command names are used verbatim with no validation — a name containing a space is unreachable from the TUI

`src/commands/registry.ts:281` · **correctness**

**Evidence**

```
src/commands/registry.ts:281
  const name = typeof fm.name === "string" ? fm.name : entry.name.replace(/\.md$/, "");

Reproduced with frontmatter `name: "my cmd /weird"`:
$ bun -e 'console.log(loadCommands("./cmdtest").map(c=>c.name))'
[ "my cmd /weird" ]

The Go TUI splits on the first space and closes the menu on any space:
tui/internal/session/session.go:436  m.menuOpen = strings.HasPrefix(text, "/") && !strings.Contains(text, " ")
tui/internal/session/session.go:471  if name, args, _ := strings.Cut(strings.TrimPrefix(text, "/"), " "); strings.HasPrefix(text, "/") {
```

**Impact.** A command declared as `name: deploy staging` appears in `/help` and in `GET /commands` (so it shows in the autocomplete list), but typing `/deploy staging` sends name=`deploy`, args=`staging` — `unknown command: /deploy`. The command is listed and permanently unusable, and the failure message names a command the user never typed. A name containing `/` breaks the `POST /commands/<name>` path split at server.ts:200 the same way.

**Fix.** Slugify and validate in `loadCommands` at registry.ts:281, mirroring the id slug `runInit` already uses at cli.ts:249: `const raw = typeof fm.name === "string" ? fm.name : entry.name.replace(/\\.md$/, ""); const name = raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/(^-|-$)/g, ""); if (!name) { console.error(\`amux: skipping ${entry.name}: unusable command name\`); continue; }` and warn when `name !== raw` so the author learns what their command is actually called.

## 99. `/cancel` does not stop an in-flight agent — it only stops new tasks from launching

`src/engine.ts:204` · **ux**

**Evidence**

```
`shouldStop: () => this.cancelled` is passed into `RunnerDeps` and consumed only in scheduler.ts — at line 210 (the exhaustion retry), 232 (replan), 250/263 (launching new tasks) and 288 (integrate). `Agent.run()`'s loop (agent.ts:197-242) has no access to it and no stop check; `AgentDeps` (agent.ts:88-100) has no such field. The scheduler comment at line 262 states the intent explicitly: "we stop launching new work but let in-flight tasks finish."
```

**Impact.** With three agents mid-task at 12 turns each, pressing cancel can still cost up to 36 more billed model calls and, critically, allows every already-approved write in those turns to land on disk. A user hitting cancel because an agent is destroying the repo watches it continue. The UI publishes `session: cancelled` immediately (engine.ts:211 runs in `finally`, after the work), so the feedback loop reads as "cancelled" while work continues.

**Fix.** Add `shouldStop?: () => boolean` to `AgentDeps`, pass `() => this.cancelled` at engine.ts:116-128, and check it at the top of the loop body (agent.ts:198) and again immediately before each `execTool` call (agent.ts:236) — returning `"failed"` with `lastError = "cancelled"`. Roughly six lines, and it makes cancel mean cancel.

## 100. The system-prompt suffix round-trips into agents.yaml through the dashboard and compounds on every save

`src/engine.ts:115` · **state-management**

**Evidence**

```
'''
      const cfg = { ...c, systemPrompt: c.systemPrompt + (opts.systemSuffix ?? "") + TOOL_GUIDANCE };
'''
`get configs()` returns `this.agents.map((a) => a.config)` (engine.ts:144-146) — those same suffixed objects. `GET /agents` serves them (src/server/server.ts:240) and `POST /agents` writes whatever it is handed back: `saveAgents(agents)` (server.ts:244), which persists `systemPrompt: a.systemPrompt` verbatim (src/config/config.ts:120).
```

**Impact.** Any dashboard flow that reads the agent list, lets the user tweak one field, and posts it back bakes the skills list, every `instructions:` file's full contents, and TOOL_GUIDANCE into `.amux/agents.yaml`. On the next boot the Engine appends all of it again. Two or three edit cycles and every agent's system prompt carries several duplicated copies of AGENTS.md, burning input tokens on every single provider call of every run — and the duplication is invisible in the UI because the field renders as one long string.

**Fix.** Keep the composed prompt off `AgentConfig`. Either store the suffix separately on the Agent (`private promptSuffix` concatenated at `provider.send` time, agent.ts:200/306/331), or have `get configs()` return the original config objects and let the Agent hold the composed one. The one-line stopgap is to strip the suffix in `saveAgents` — but the clean fix is not to have put it in the persisted shape at all.

## 101. Orphaned worktrees are never reaped: the 'unmerged worktree' guard is in-memory only

`src/engine.ts:182` · **state-management**

**Evidence**

```
`worktreeHandle` is a plain instance field (engine.ts:58) with no persistence — the comment at engine.ts:56 even says 'Persists across a run's end … so it's never silently orphaned', but that is only true within one process lifetime. `createWorktree` uses `crypto.randomUUID().slice(0, 8)` (engine.ts:189), so every process start mints a fresh id. Nothing scans `.amux/worktrees/` at startup: `grep -rn worktrees src tui web` returns only worktree.ts:36 and worktree.ts:39.
```

**Impact.** Ctrl-C or a crash during a `--worktree` run leaves `.amux/worktrees/<uuid>` on disk plus a live `amux/<uuid>` branch and a registered worktree in `.git/worktrees/`. Restart amux and the guard is gone — a new worktree is created and the old one is invisible to the product, its work unreachable except by manual git archaeology. Repeat across a few crashes and the repo accumulates orphaned branches and gigabytes of duplicated checkouts.

**Fix.** Persist the handle next to the other session state — `.amux/session.json` already exists and `saveTasks`/`loadTasks` (session.ts:11-20) are the pattern. Write `{tasks, worktree: handle}` and rehydrate `this.worktreeHandle` in the Engine constructor. Cheapest complement: on startup, `git worktree list --porcelain` and report (not auto-delete) any `.amux/worktrees/*` entry, so the user can `/worktree discard` it.

## 102. `keystore.setKey` does not degrade when the OS keychain is unavailable — `amux keys set` crashes on headless Linux/CI/Docker

`src/keystore/keystore.ts:27` · **portability**

**Evidence**

```
Every other keychain entry point is defensive. `getKey` (:17-25) wraps `getPassword()` in try/catch and falls through to the env var with the comment "Keychain unavailable (headless Linux, locked)". `deleteKey` (:33-39) wraps `deletePassword()`. `setCredential` wraps its mirror write (`auth-store.ts:63-68`, "keychain unavailable (headless Linux, locked) — the 0600 file is the source of truth"). But:
'''ts
export function setKey(provider: string, key: string): void {
  new Entry(SERVICE, provider).setPassword(key);   // keystore.ts:28 — bare
}
'''
and its only caller is equally bare — `cli.ts:44`: `setKey(args[2], key!);` with no try/catch, followed immediately by `console.log(\`Stored ${args[2]} key in the OS keychain.\`)`.
```

**Impact.** On a headless Linux box, in Docker, or over SSH without a D-Bus session — i.e. exactly where `keys set` is most likely to be scripted — `@napi-rs/keyring` throws out of the native binding. The user sees a raw Rust/napi error with no explanation, the key is written nowhere (unlike `auth login`, which persists to the 0600 file first and only *mirrors* to the keychain), and the process exits non-zero mid-onboarding. The asymmetry is invisible: two commands documented as equivalent behave completely differently off a desktop.

**Fix.** Wrap it and tell the truth: `export function setKey(p, k) { try { new Entry(SERVICE, p).setPassword(k); return true; } catch { return false; } }`, and in `cli.ts:44` fall back to `setCredential({provider, type:"api", key})` when it returns false, printing "OS keychain unavailable — stored in ~/.config/amux/auth.json (0600)." That is the lazy fix and it also makes `keys set` a strict superset of `auth login`.

## 103. MAX_PER_PAIR is a per-run budget, not per-task, and exhausting it silently deletes handoffs

`src/messaging/message-bus.ts:29` · **correctness**

**Evidence**

```
`const MAX_PER_PAIR = 10; // messages one agent may send another within a single task/plan (loop guard)` (message-bus.ts:29). The comment on `resetCaps` says 'call at each plan/task boundary' (line 66), but `grep -rn resetCaps src` shows exactly one non-test call site: scheduler.ts:175, once at the top of `schedule`. The budget is shared by `post()` and `authorize()` (message-bus.ts:73-81), so ask_agent, send_message, task handoffs and review feedback all draw from the same 10. On overflow `post` returns `{ok:false, reason:'message rate cap reached'}` — and scheduler.ts:242 discards that result, while scheduler.ts:244 emits the `handoff` event regardless.
```

**Impact.** A 6-task plan where frontend→backend is the main axis: after 10 combined ask_agent calls and handoffs, every further frontend→backend message is dropped. The scheduler's handoff at line 242 vanishes, but the `handoff` event still fires so the web dashboard animates the edge (web/app.js:141 `pulse(ev.from, ev.to[0], 'handoff')`) for a message nobody received. The downstream agent starts its task without its prerequisite's artifact.

**Fix.** Call `messageBus?.resetCaps()` at the top of `runTask` (scheduler.ts:184) so the cap is genuinely per-task as documented, and exempt scheduler-originated handoffs entirely — they are plan-driven, not agent-driven, so post them as `from: ORCHESTRATOR` or add a `system: true` flag that skips `reserve()`. At minimum, check the result: `const r = messageBus.post({...}); if (!r.ok) bus?.publish({agentId: t.assignedTo!, type: "warning", payload: \`handoff to ${to} not delivered: ${r.reason}\`, time: Date.now()});` and only emit the `handoff` event for delivered targets.

## 104. Replan-injected tasks are invisible to persistence, resume, and the TUI board

`src/orchestrator/orchestrator.ts:17` · **state-management**

**Evidence**

```
`Orchestrator.load` copies the array: `this.tasks = [...tasks];` (orchestrator.ts:17). `runProject` calls `orch.load(plan.tasks)` (runner.ts:74) and then `schedule(plan.tasks, ...)` (runner.ts:93). `attemptReplan` grows the *scheduler's* array: `tasks.push(nt)` (scheduler.ts:118). Because `load` took a copy of the array (the elements are shared, the array is not), injected nodes never appear in `orch.all`. `Engine.runSession` persists `saveTasks(this.orch.all)` (engine.ts:206). Separately, the TUI only rebuilds its board on a `plan` event (session.go:630 `m.tasks = m.tasks[:0]`) and has no `replan` case arm.
```

**Impact.** A task fails, the lead injects two remediation tasks, they run and (say) fail. On restart `amux resume` sees neither — the remediation work is lost from session.json and cannot be resumed. Live, the TUI board and the web DAG never show them either; the user sees an agent working on something that isn't on the board.

**Fix.** Two lines. (1) Make the scheduler and orchestrator share one array: change orchestrator.ts:17 to `this.tasks = tasks as Task[]` (drop the spread) — the comment at runner.ts:74 already claims the objects are shared, this makes the container shared too. (2) Emit a fresh `plan` event after a successful inject in attemptReplan (scheduler.ts:120) so both clients redraw the DAG with the new nodes; the TUI's existing `case "plan"` handles it with no client change.

## 105. A provider failure during planning escapes `submit()` — the CLI crashes, the server swallows it

`src/orchestrator/runner.ts:72` · **error-handling**

**Evidence**

```
`const plan = await makePlan(lead, prompt, roles);` sits outside runProject's try (which starts at line 92 and wraps only `schedule`). `Engine.runSession` (engine.ts:196-212) has `try { await run(deps); saveTasks(...) } finally { ... }` — a `finally`, no `catch`. Consumers: `await engine.submit(goal)` at cli.ts:154 with nothing around it, and `engine.submit(text, ...).catch((err) => console.error("submit error:", err))` at src/server/server.ts:186.
```

**Impact.** An expired API key, a 401, or a network blip on the very first planning call produces an unhandled rejection and a raw stack trace out of `amux-core "task"` — after the CLI has already printed nothing useful. Through the server it is worse: the error goes only to the server process's stderr, while the SSE hub publishes `{kind:"session", state:"ended"}` from the `finally` at engine.ts:211. The TUI and dashboard show a session that started and ended with no tasks and no explanation.

**Fix.** Wrap the `run(deps)` call in engine.ts:197 in a try/catch that publishes the failure onto the hub before rethrowing — `this.hub.publish({ kind: "agent_event", event: { agentId: "orchestrator", type: "error", payload: summarizeError(err), time: Date.now() } })` — so every consumer sees why. Then `surfaceStartupError`-style handling at cli.ts:154 (`await engine.submit(goal).catch(e => die(summarizeError(e)))`) turns the crash into a one-line message.

## 106. `worker`/`parseTaskList` in runner.ts are dead in production and kept alive solely by 8 tests, one of which is a whole orphan file named after a feature that ships differently

`src/orchestrator/runner.ts:129` · **maintainability**

**Evidence**

```
`export { worker as runWorker };` (line 129) with the comment 'Exposed for testing the flat concurrency/claim path without a planning call.' A repo-wide grep for `parseTaskList|runWorker` outside runner.ts hits only test files: orchestrator.test.ts:5,21-24,44 and failover.test.ts:5,35. Production callers of this module are engine.ts:164 (`runProject`) and engine.ts:172 (`resumeProject`) only.\n\n`src/orchestrator/failover.test.ts` is the single orphan test in the repo — an automated `*.test.ts` → sibling-source scan across src/ and web/ returns exactly one hit, and there is no `failover.ts`. Its 5 tests are the only consumers of `Task.availableAt` and `Task.lastFailedBy` (task.ts:9-10).
```

**Impact.** A reader looking for how failover works finds `failover.test.ts`, follows it to `runWorker`, and reads a 19-line retry loop with `MAX_ATTEMPTS = 3` that production never executes — corroborating from a second angle the separately-reported 'no cross-provider failover on the shipped code path'. The tests pass, so the suite actively certifies the wrong mechanism. Meanwhile `runProject`/`resumeProject`, which do run, have no test sibling at all.

**Fix.** Delete `worker`, `runWorker`, `MAX_ATTEMPTS`, `parseTaskList` and `failover.test.ts`; move the four assertions that are genuinely about `Orchestrator` (requeue, self-reclaim rejection, backoff expiry, cross-agent claim — failover.test.ts:43-84) into `orchestrator.test.ts`, where their subject actually lives. That is a net deletion of ~50 lines of src and one whole test file, and it stops the suite from vouching for an unreachable path. If flat-queue mode is genuinely coming back, say so in a `ponytail:` comment naming the date — otherwise it is speculative code the ladder says to skip.

## 107. A throwing event subscriber aborts the entire run and strands in-flight agents

`src/orchestrator/scheduler.ts:283` · **error-handling**

**Evidence**

```
`runTask` calls `emit?.(...)` at scheduler.ts:189, 194, 237, 244 and `messageBus.post(...)` at 242, none wrapped. `MessageBus.post` runs subscribers bare: `for (const fn of this.subs) fn(msg);` (message-bus.ts:102). Engine's subscriber calls `this.store?.recordMessage(m)` unguarded (engine.ts:138) — a bun:sqlite write that throws on a locked/full/corrupt DB. `Bus.publish` uses `EventEmitter.emit` (events/bus.ts:32), also synchronous and propagating. A throw inside `runTask` rejects `p`, which rejects `Promise.race(running.values())` (scheduler.ts:283), which throws out of `schedule` and is caught only at runner.ts:94 as 'scheduling failed'.
```

**Impact.** A single SQLite error during a handoff post aborts the whole DAG. The other in-flight task promises are orphaned — their agents keep making billed model calls and writing files with no supervisor, `Engine.runSession`'s finally sets `busy = false` and restores the root out from under them (engine.ts:209 `a.setRoot(this.root)`), and their eventual rejections have no handler.

**Fix.** Guard the fan-out at the source, one place each: message-bus.ts:102 → `for (const fn of this.subs) { try { fn(msg); } catch {} }`, and wrap `this.store?.recordMessage(m)` in engine.ts:138 in a try/catch that publishes a warning. Then make the scheduler defensive too: `const p = runTask(t).catch(err => { t.status = "failed"; bus?.publish({agentId: t.role, type: "error", payload: String(err), time: Date.now()}); }).finally(() => running.delete(startRole));` — a task that blows up must not take the run with it.

## 108. createWorktree does not gitignore its own directory, so agents and users commit an embedded-repo gitlink

`src/orchestrator/worktree.ts:39` · **packaging**

**Evidence**

```
`const path = join(root, ".amux", "worktrees", id);` (worktree.ts:39). The repo's .gitignore lists `.amux/session.json`, `.amux/amux.db*`, `.amux/reports/` — not `.amux/worktrees/`. I verified the consequence in a scratch repo: after `git worktree add -b amux/x .amux/worktrees/x`, a plain `git add -A` in the root produces git's 'warning: adding embedded git repository: .amux/worktrees/x' and stages it as a gitlink (`A? .amux/worktrees/x`). This path is reached in-product by `snapshotBranch` (worktree.ts:82 `git add -A` in root, the /branch command) and by any agent that shells `git add -A`.
```

**Impact.** User runs `--worktree`, then `/branch wip`. snapshotBranch does `git checkout -b wip; git add -A; git commit` in the real root and commits a gitlink pointing at a throwaway worktree. Anyone who clones gets a broken submodule-ish entry referencing a directory that was deleted by removeWorktree. Same happens if any agent runs `git add -A` — a very common agent action.

**Fix.** Two lines. Add `.amux/worktrees/` to .gitignore, and have createWorktree write the ignore itself so it holds in *user* repos too, not just this one: after mkdir, `writeFileSync(join(root, ".amux", ".gitignore"), "worktrees/\n", {flag: "a"})` — or simplest, write `.amux/worktrees/.gitignore` containing `*`, which git honours with no change to the user's tracked .gitignore.

## 109. The trimmed catalog now shows the same vendor twice in the first-launch team picker, with different labels and different model counts

`src/providers/catalog.ts:33` · **ux**

**Evidence**

```
'''\nfireworks          "Fireworks"        models:1  base:https://api.fireworks.ai/inference/v1\nfireworks-ai       "Fireworks AI"     models:8  base:https://api.fireworks.ai/inference/v1/\nmoonshot           "Moonshot (Kimi)"  models:3  base:https://api.moonshot.ai/v1\nmoonshotai         "Moonshot AI"      models:8  base:https://api.moonshot.ai/v1\n'''\nThe hand-maintained `MANUAL_CATALOG` entries are `fireworks` and `moonshot`; the uncommitted `ALLOW_IDS` list in scripts/gen-catalog.ts admits models.dev's `fireworks-ai` and `moonshotai`. catalog.ts:30-33 documents that manual entries 'take priority over the generated list below on id collision' — but these are not id collisions, so both survive into a 34-entry catalog where the duplication is now 6% of the list.
```

**Impact.** README.md:51-59 says the picker 'opens on every launch' and shows 'the whole catalog'. A new user picking their first model sees 'Fireworks' and 'Fireworks AI' as two separate providers pointing at the same host, and choosing the wrong one gets them 1 model instead of 8. Two keys, two credential entries, one vendor. The exact 'noise in a picker a new user sees on first launch' the ALLOW_IDS comment was written to eliminate.

**Fix.** Drop `fireworks-ai` and `moonshotai` from `ALLOW_IDS` in scripts/gen-catalog.ts and fold their model lists into the `fireworks`/`moonshot` MANUAL_CATALOG entries (the manual ones carry the client/category info the generator can't infer, so they are the ones to keep). Then add a generator assertion that fails the run if any generated id resolves to a baseURL already claimed by a different id — the check is a few lines and it is the only thing that stops this recurring the next time ALLOW_IDS is extended.

## 110. The device-flow poll interval is taken from an unvalidated network response and can produce an unbounded tight loop

`src/providers/copilot.ts:50` · **security**

**Evidence**

```
`startDeviceFlow` (`copilot.ts:28-36`) does `return (await res.json()) as DeviceCode` — a bare cast, no validation, over a `DeviceCode` interface (`copilot.ts:20-26`) that declares `interval: number` as required. `cli.ts:55` then passes it straight through: `await pollForToken(dc.device_code, dc.interval)`. In `pollForToken` (`copilot.ts:50-53`):
'''ts
let wait = interval;
for (;;) {
  await sleep(wait * 1000);
'''
If `interval` is absent from the response body, `wait * 1000` is `NaN`, `setTimeout(r, NaN)` fires on the next tick, and the `for(;;)` becomes an unthrottled POST loop against github.com/login/oauth/access_token.
```

**Impact.** A malformed or proxied GitHub response — a captive portal, a corporate MITM appliance, an API change, a 200 with an unexpected body — turns `amux login copilot` into a request flood that GitHub will rate-limit and may treat as abusive, against the user's own account and IP. This is an unvalidated value from a trust boundary being used directly as a loop's only throttle, which is exactly the case where defensive code is not optional.

**Fix.** One clamp at `copilot.ts:51`: `let wait = Number.isFinite(interval) && interval >= 1 ? interval : 5;` plus the same clamp on the `slow_down` branch at :65. While there, bound the loop by `dc.expires_in` and check `res.ok` before `res.json()` at :63 so a 5xx HTML body does not surface as a JSON SyntaxError.

## 111. Selecting `custom` without a base URL silently sends the literal string "local" as a bearer token to api.openai.com

`src/providers/factory.ts:16` · **correctness**

**Evidence**

```
`catalog.ts:144-151` defines `custom` with `client: "openai"`, `keyOptional: true`, **no `baseURL`**, and `models: []`. In `factory.ts`:
'''ts
let apiKey = resolveApiKey(cfg.provider);
if (!apiKey && entry.keyOptional) apiKey = "local";          // :16
…
const baseURL = cfg.baseURL ?? resolveBaseURL(cfg.provider) ?? entry.baseURL;  // :21 → all three undefined
…
return new OpenAIProvider(cfg.model, apiKey, baseURL);       // :28
'''
`openai.ts:29-34` spreads `...(baseURL ? { baseURL } : {})`, so an undefined baseURL means the SDK's default: `https://api.openai.com/v1`. `catalog.test.ts:13` explicitly exempts `custom` from the "must carry a baseURL" assertion.
```

**Impact.** A user picks "Custom (OpenAI-compatible)" but has not yet stored a base URL — easy, because `authLogin` (`cli.ts:208-215`) only stores one if the user types something at the `Base URL []:` prompt, and skipping it falls through to the API-key branch instead. Their next request goes to **OpenAI's production API** with `Authorization: Bearer local` and whatever model id they typed. The 401 that comes back names OpenAI, not the endpoint they thought they configured, so the error actively misdirects debugging.

**Fix.** Guard in `factory.ts` before the switch: `if (cfg.provider === "custom" && !baseURL) throw new Error("custom provider needs a base URL — run: amux auth login custom");`. Root-cause version: make `keyOptional` imply `baseURL`-required for the openai client, since the sentinel key only makes sense when you are pointing somewhere that does not check it.

## 112. `GeminiProvider` silently ignores the base URL the factory computes for it

`src/providers/factory.ts:26` · **correctness**

**Evidence**

```
`factory.ts:21` computes `const baseURL = cfg.baseURL ?? resolveBaseURL(cfg.provider) ?? entry.baseURL;` for all four client kinds, but the gemini arm drops it:
'''ts
case "gemini":
  return new GeminiProvider(cfg.model, apiKey);   // :26 — no baseURL argument
'''
`GeminiProvider`'s constructor takes only `(model, apiKey)` (`gemini.ts:7-12`) and there is no third parameter to pass one to. `POST /model` accepts and forwards a `baseURL` (`server.ts:270-278` → `engine.switchModel(agentId, provider, model, baseURL)` → `engine.ts:333` `this.makeProvider({...agent.config, provider, model, baseURL})`), so the value travels the whole way and then evaporates.
```

**Impact.** A user who points Google at a corporate proxy, a caching gateway, or a local Gemini-compatible shim — via `amux auth login google` storing a `type: "local"` credential, or via `POST /model` with an explicit `baseURL` — gets no error and no warning. Requests go to `generativelanguage.googleapis.com` regardless, with their key. For anyone using a proxy for egress control or audit, that is a policy bypass they will not notice.

**Fix.** Either plumb it — `@google/genai` accepts `httpOptions.baseUrl`, so `new GoogleGenAI({ apiKey, httpOptions: { baseUrl } })` in `gemini.ts:11` with an added constructor parameter — or fail loudly: `if (baseURL) throw new Error("google does not support a custom base URL")` in the factory arm. Silently discarding it is the one option that should not ship.

## 113. Resume seeds an agent with other agents' sessions and drops completed-prerequisite context

`src/session.ts:24` · **correctness**

**Evidence**

```
`resumeConversation` is `store.listSessions({ taskId }).flatMap(s => store.loadTurns(s.id))` (session.ts:24-26) — no `agentId` filter, though `listSessions` supports one (session-store.ts:151-160). `runReviewGate` creates reviewer sessions under the reviewed task's id: `reviewer.run(..., { taskId: t.id })` (scheduler.ts:143). Separately, `resumeProject` builds `nodes` from `orch.all.filter(t => t.status !== "done")` (runner.ts:106), so `byId` inside `schedule` (scheduler.ts:168) contains only unfinished tasks and the depContext builder `t.dependsOn.map(id => byId.get(id)).filter(d => Boolean(d?.output))` (scheduler.ts:197-199) silently yields nothing for a prerequisite that completed in the earlier run.
```

**Impact.** Resume a run where qa reviewed t1: the fe agent's resumed context now contains qa's full review transcript as if it were fe's own history, including qa's tool calls. And a task t3 that depends on a completed t1 resumes with zero knowledge of what t1 produced — the exact context the DAG exists to deliver.

**Fix.** session.ts:25 → `store.listSessions({ taskId, agentId }).flatMap(...)`, threading the agent id through `RunnerDeps.priorTurns` (change its signature to `(taskId: string, agentId: string) => Turn[]`, call site scheduler.ts:207 already has `t.role`). For the lost context, have `resumeProject` pass the *full* `orch.all` list to `schedule` with already-done tasks left at status `"done"` — the scheduler's `depsDone` (scheduler.ts:181) skips them naturally and their `output` becomes reachable in `byId`.

## 114. `read_file` reads any file wholesale into the turn array — no size cap, no offset/limit, no binary guard

`src/tools/tools.ts:56` · **perf**

**Evidence**

```
'''
    case "read_file":
      return await readFile(safePath(root, call.path), "utf8");
'''
The spec offers exactly one parameter (`{ path: { type: "string" } }`, tools.ts:112) — no line range, unlike the read tool every frontier agent harness ships. The returned string is pushed straight into `turns` as a tool result (agent.ts:236, 241) and resent on every subsequent iteration.
```

**Impact.** One `read_file package-lock.json` or `read_file dist/bundle.js` can exceed the entire context window in a single tool call. The failure is not graceful: the oversized turn is already in `turns` before any usage number comes back, so the 95% compaction check at agent.ts:221 fires only *after* the next provider call has already been made — and if that call rejects for context length, `isExhaustion` classifies it as `exhausted` (agent.ts:66) and the scheduler retries the same task up to three times. Reading a binary as utf8 also injects replacement characters and can tokenize catastrophically.

**Fix.** Add `offset`/`limit` parameters to the read_file spec (tools.ts:109-113) and a hard byte cap in the handler: read with `stat` first, and above ~256KB return the first N lines plus `[file truncated: X of Y lines — call again with offset]`. That is a dozen lines and removes the single most common way for this loop to destroy its own context. A ` `-in-first-1KB check to reject binaries costs two more.

## 115. `markSelfWrite` keys on the model-supplied path string while the watcher keys on fs.watch's normalized relative path — self-write suppression fails whenever they differ

`src/watch.ts:35` · **correctness**

**Evidence**

```
src/watch.ts:31-36
  watcher = watch(root, { recursive: true }, (_event, filename) => {
    const rel = String(filename);              // fs.watch gives a path relative to root, no "./"
    ...
    const at = selfWrites.get(rel);            // exact string key lookup

The key written on the other side is the raw tool argument:
src/engine.ts:126   onWrite: (path) => this.watcher?.markSelfWrite(path),
src/agent/agent.ts:465-468
  const lockPath = WRITE_TOOLS.has(sandboxCall.tool) && "path" in sandboxCall ? sandboxCall.path : ...;
  ...
  if (sessionId) this.store?.checkpoint(sessionId, safePath(this.root, lockPath), before ?? null);   // normalized
  this.onWrite?.(lockPath);                                                                          // NOT normalized

Note line 467 deliberately normalizes via `safePath(this.root, lockPath)` for the checkpoint, and line 468 passes the raw string one line later. `sandboxCall.path` is whatever the model emitted — `./src/foo.ts`, `src/./foo.ts`, or an absolute `/Users/…/src/foo.ts` all reach `runTool` fine (safePath resolves them, tools.ts:19-24) but produce a key that never equals fs.watch's `src/foo.ts`.
```

**Impact.** An agent that writes `./src/index.ts` (a very common model output shape) has its own write reported straight back to it as an external change, because the 2-second TTL entry is filed under `./src/index.ts` and the watcher looks up `src/index.ts`. The watcher's entire stated purpose (watch.ts:5-6, 'Emits paths only — nothing is stuffed into any agent's context automatically') is to tell the user/planner that a *human* changed something; false positives here mean the change feed is untrustworthy exactly during the busiest part of a run. Silent — nothing logs the miss.

**Fix.** Normalize on the way in, in src/watch.ts:43 so every caller is covered rather than patching agent.ts: `markSelfWrite(p: string) { const rel = relative(root, resolve(root, p)); selfWrites.set(rel, Date.now()); ... }` (import `relative`, `resolve` from node:path — `root` is already the closure parameter). Add a case to watch.test.ts asserting `w.markSelfWrite("./mine.txt")` still suppresses `mine.txt`; the existing test at watch.test.ts:47 only exercises the already-matching form.

## 116. The approval diff viewer's scroll offset is never clamped on keypress, so `G` then `up` is permanently dead and over-scrolling strands the user

`tui/internal/session/diffview.go:108` · **ux**

**Evidence**

```
`diffViewKey` mutates `m.diffv.top` with no upper bound: line 108 `m.diffv.top++`, line 114 `m.diffv.top += page`, line 120 `m.diffv.top = 1 << 30 // clamped against the real line count at render time`. The clamp exists only in the renderer and is not written back — `diffView` line 222: `top := clamp(m.diffv.top, 0, max(len(diffLines)-rows, 0))`, a local.\n\nThe sibling pager gets this right by clamping at press time: output.go:48 `m.out.top = min(m.out.top+1, m.outputMaxTop())`, :52 the same for pgdown, :56 `m.out.top = m.outputMaxTop()` for `end`/`G`.
```

**Impact.** Press `G` (jump to end) on a diff, then `up`: stored top goes 1073741824 → 1073741823, which still clamps to the bottom, so the view does not move — and never will, no matter how many times `up` is pressed. Holding `j`/`down`/pgdown past the end has the same effect proportionally: 40 extra presses means 40 dead `up` presses before anything scrolls. This is on the screen where a human reviews a write_file diff before approving it — the one interaction where being unable to scroll back up is most costly, and where the natural response is to give up and approve unread.

**Fix.** Mirror output.go. Add `maxTop := max(len(diffLines)-rows, 0)` as a method on Model (it needs the same `rows` computation the renderer uses), then clamp in the handler: `m.diffv.top = min(m.diffv.top+1, m.diffMaxTop())` at 108, `min(m.diffv.top+page, m.diffMaxTop())` at 114, and `m.diffv.top = m.diffMaxTop()` at 120 instead of `1 << 30`. Same three-line shape as the pager that already works.

## 117. replan, review, and task_ready orchestration events are emitted but consumed by nobody

`tui/internal/session/session.go:628` · **ux**

**Evidence**

```
scheduler.ts:10-19 defines nine OrchestrationEvent variants. `applyOrch` (session.go:628-659) has case arms for exactly five: plan, task_started, task_done, handoff, integrate, complete. web/app.js:118-143 handles the same five. `grep -n 'replan\|task_ready' web/app.js web/graph.js tui/internal/session/session.go` returns nothing (the `review` hits at web/app.js:12 and graph.js:12 are message-kind *colors* for the message bus, not the orchestration event).
```

**Impact.** The review gate can add up to 4 extra model calls per task (2 reviewer runs + 2 revision runs) and a replan adds 1 more, all invisible. From the user's seat the agent simply sits at 'working' for minutes longer than the task warrants, with no indication that a reviewer rejected the work or that the lead redirected it. When the round cap fails a task, the board flips to red with no explanation of why.

**Fix.** Add three case arms to session.go's applyOrch (each 2-3 lines using the existing `m.pushFeed`): `case "review": m.pushFeed(fmt.Sprintf("%s reviews %s: %s", oe.Reviewer, oe.TaskID, oe.Phase))`, `case "replan": m.pushFeed(fmt.Sprintf("orchestrator replans %s: %s — %s", oe.TaskID, oe.Action, oe.Reason))`, and set the task to a distinct status on review-requested. Mirror in web/app.js:118's switch. The event contract already carries every field needed; only the render is missing.

## 118. API keys are echoed in cleartext during entry, in both the Go TUI and the CLI

`tui/internal/wizard/picker.go:57` · **security**

**Evidence**

```
`picker.go:57` is a plain `ti := textinput.New()` with no `ti.EchoMode = textinput.EchoPassword`. That same input is reused for the key stage — `picker.go:179`: `m.input.Placeholder = "API key for " + pick + " (or a base URL for a local endpoint)"` and `picker.go:191`: `cred := map[string]string{"provider": m.provider, "type": "api", "key": val}`. Grepping the whole `tui/` tree for `EchoMode|Password` returns zero hits. The CLI path has the same problem: `cli.ts:43` `prompt(\`Enter API key for ${args[2]}:\`)` and `cli.ts:217` `prompt(\`API key for ${entry!.label}:\`)` — Bun's `prompt()` echoes.
```

**Impact.** The secret is rendered into the terminal during onboarding, which means it lands in scrollback, in `script`/asciinema recordings, in a shared screen or a demo video, and in any terminal-multiplexer capture buffer. This is the single most common way a live API key gets published by accident, and it happens on the very first screen a new user sees.

**Fix.** Go: in `picker.go`, at the `case "provider"` branch that switches to the key stage (:177-181) set `m.input.EchoMode = textinput.EchoPassword` and reset it to `textinput.EchoNormal` on entering any other stage. TS: replace both `prompt()` calls with a no-echo read — Bun exposes raw-mode stdin, or shell out to the same mechanism `git credential` uses. Also consider redacting `strings.HasPrefix(val, "http")` classification at `picker.go:192`, which currently mis-stores any key beginning with the letters "http" as a base URL.


---

# P3 — Polish and papercuts (25)

## 119. The npm name `amux` is already owned by someone else

`package.json:2` · **packaging** · adversarially verified · originally reported critical, downgraded on verification

**Evidence**

```
'''
$ npm view amux
amux@0.0.0 | MIT | deps: none | versions: 1
.unpackedSize: 273 B
maintainers:
- donavon <github@donavon.com>
dist-tags: latest: 0.0.0
published over a year ago by donavon <github@donavon.com>
'''
`npm view amux-core` → `E404 Not Found` (available).
```

**Impact.** `npm publish` will fail with a 403 regardless of every other fix. The release is blocked on a name decision, not on code — and discovering this at publish time after a version tag is the worst moment to discover it.

**Fix.** Pick the name before anything else. Options in order of laziness: (1) publish as a scope you control — `@shubhadeepdatta/amux` or an org scope — with `"publishConfig": {"access": "public"}`; (2) take the free `amux-core` name and keep `amux` only as the bin name (npm allows a bin named `amux` from a package named anything); (3) file an npm name-dispute for a 273-byte placeholder unpublished for over a year, which is slow and uncertain. Recommend (1) or (2) today.

## 120. `"private": true` blocks publish but `npm publish --dry-run` exits 0 with `+ amux@0.0.1` — the pre-flight check is a false green

`package.json:4` · **packaging** · adversarially verified · originally reported critical, downgraded on verification

**Evidence**

```
`npm publish --dry-run` output ends with `npm warn publish This command requires you to be logged in ... (dry-run)` / `npm notice Publishing to https://registry.npmjs.org/ with tag latest and default access (dry-run)` / `+ amux@0.0.1`, exit 0, 136 files.
Why: /opt/homebrew/lib/node_modules/npm/lib/commands/publish.js:153 guards with `if (workspace && manifest.private)` — never taken for a plain `npm publish .`. The real throw is in libnpmpublish/lib/publish.js:15 (`if (manifest.private) … code: 'EPRIVATE'`), only reached on a non-dry-run publish.
```

**Impact.** A release script that gates on `npm publish --dry-run` passes, then the real publish dies with EPRIVATE. On npm 11.17.0 the dry run gives no hint whatsoever that the package is marked private.

**Fix.** Remove `"private": true` from package.json line 4 only once the `files` allowlist (next finding) is in place — the two must land in the same commit, because dropping `private` without `files` is what turns a config mistake into a permanent published artifact. Add `"publishConfig": {"access": "public"}` at the same time if scoping the name.

## 121. On any npm install the dashboard's vendor assets 404 because node_modules is resolved package-relative while npm hoists

`src/server/server.ts:75` · **packaging** · adversarially verified · originally reported high, downgraded on verification

**Evidence**

```
`const nodeModulesDir = new URL("../../node_modules", import.meta.url).pathname;` (server.ts:75), used by `serveVendor` (:79) as `join(nodeModulesDir, v.path)`.
From the real installed package: `ls node_modules/amux/node_modules` → `No such file or directory`; `ls node_modules/@xterm` → `addon-fit  xterm` (hoisted to the root).
Live server booted from the installed copy, handshake `{"amuxServer":{"url":"http://127.0.0.1:61736",...}}`:
'''
xterm.js=404   body: {"error":"not found"}
index=200  palettes=200
'''
```

**Impact.** Every `/xterm.*` request 404s for any consumer who installed via npm rather than cloning. Today that is invisible because nothing in web/ loads those scripts — but the moment the terminal pane is wired up, it will work in dev (nested node_modules present in the repo) and be silently broken for every installed user. Same class of bug will hit any future `node_modules`-relative asset.

**Fix.** Never resolve a dependency's files by path. If the xterm assets survive the terminal-feature deletion, resolve them with `import.meta.resolve("@xterm/xterm/lib/xterm.js")` (or Node's `createRequire(import.meta.url).resolve(...)`), which follows the real resolution algorithm regardless of hoisting. Otherwise delete `nodeModulesDir`, `VENDOR_FILES` and `serveVendor` outright. Note that `webDir` (:53) and `palettesFile` (:88) are correct as written — they point inside the package.

## 122. Popups overflow terminals narrower than ~40 columns because the overlay is composited after View's width clamp

`tui/internal/session/view.go:125` · **correctness** · adversarially verified · originally reported high, downgraded on verification

**Evidence**

```
view.go:125-135 clamps first, then draws the popup on top of the clamped output:
	out := lipgloss.NewStyle().MaxWidth(w).MaxHeight(h).Render(strings.Join(rows, "\n"))
	switch {
	case m.out.open:  out = ui.Overlay(out, m.outputView(w, h), w, h)
	case m.car.open:  out = ui.Overlay(out, m.carouselView(w, h), w, h)
	case m.tp.open:   out = ui.Overlay(out, m.themePickerView(w, h), w, h)
	}

Each box has a hard lower bound that beats the terminal width: carousel.go:203 `clamp(..., 34, max(w-6, 34))`, themepicker.go:105 `clamp(..., 34, max(w-6, 34))`, output.go:81 `clamp(natural+6, 30, max(w-6, 30))`. Measured with a probe test:

  carousel after resize to 20x6 -> width 32

The existing guard test only goes down to 40x10 (session_test.go:342), where `40-6 == 34` exactly, so it passes by one column.
```

**Impact.** On a split pane, a narrow tmux window, or a phone SSH client, opening ctrl+p / ctrl+t / any multi-line command result writes lines wider than the terminal. The overlay rewrites whole rows including trailing ANSI resets, so the terminal wraps them and the frame shears — and since Bubbletea's renderer diffs against what it thinks it drew, the corruption persists across frames rather than self-healing.

**Fix.** Move the overlay compositing inside the clamp: build `out` including popups, then apply `MaxWidth(w).MaxHeight(h)` once at the end. Independently, fix the box sizing so the lower bound never exceeds the terminal — `clamp(natural+6, min(34, w), max(w-6, min(34, w)))` — and extend `TestMenuAndCarouselStayInsideTheTerminal` down to 30x8 and 20x6 so the regression is pinned.

## 123. No lockfile npm can use, and bun.lock ships to consumers instead

`bun.lock:1` · **packaging**

**Evidence**

```
`ls -la | grep -i lock` → only `bun.lock` (39,278 B). It is included in the tarball (`npm notice 39.3kB bun.lock`). No package-lock.json exists.
```

**Impact.** Contributors and CI using npm get unpinned, drifting transitive deps — my install pulled `@google/genai@2.15.0` against a `^2.13.0` range. A lockfile in a published tarball is also ignored by npm, so it is 39 kB of dead payload in every download.

**Fix.** Exclude bun.lock via the `files` allowlist. If npm-based CI or contributors are expected, commit a package-lock.json alongside bun.lock; otherwise state in CONTRIBUTING that bun is the only supported package manager.

## 124. Config is discovered strictly at cwd with no walk up to the project root

`src/config/config.ts:11` · **ux**

**Evidence**

```
`export function loadAgents(path = ".amux/agents.yaml")` (:11) and the same bare relative default at :37, :69, :80, :93; src/server/main.ts:24 `existsSync(".amux/agents.yaml")`; src/store/db.ts:5 `export const DEFAULT_DB = ".amux/amux.db"`. From an empty dir the CLI correctly prints `amux: no agents configured. Run 'amux-core init' to set up providers and roles.` and exits 1.
```

**Impact.** Once amux is installed globally, running it from `myproject/src/` rather than `myproject/` finds no config and offers to run `init` — which would create a *second* `.amux/` inside the subdirectory, complete with its own SQLite DB, silently forking the project's session state. Every other project-scoped CLI (git, npm, cargo) walks up.

**Fix.** Add a `findProjectRoot()` that walks up from `process.cwd()` looking for `.amux/` (falling back to the `.git` dir, then cwd) and thread its result into the default paths in src/config/config.ts and src/store/db.ts. Roughly ten lines with `node:path.dirname` in a loop, and it makes the global-install UX behave like every tool users already know.

## 125. GET /graph re-walks and re-reads the project tree synchronously on the event loop for every request

`src/server/server.ts:207` · **perf**

**Evidence**

```
server.ts:207-213 calls `buildFileGraph(engine.root)` inline in the fetch handler. filegraph.ts:18-40 is entirely synchronous — `readdirSync` over the tree plus `readFileSync` on up to `maxFiles = 400` files, then regex import extraction. Measured on this repo: 78ms cold, 8ms warm (OS cache), 109 nodes / 217 edges. There is no cache and no invalidation hook, and graph.js re-fetches on every switch back to Project mode (graph.js:697).
```

**Impact.** Each `/graph` request blocks the single event loop for the whole scan — which means SSE frames for every connected client and the TUI stall for that duration. On a cold cache or a large repo (400 files of arbitrary size) this is comfortably over 100ms of dead air, and toggling graph modes repeatedly re-pays it every time.

**Fix.** Memoise the result with a short TTL keyed on `engine.root` (the engine already runs a file watcher — `watch: options.watch ?? true` in main.ts:48 — so invalidate on change instead of a timer). One `let cached: {at: number; g: FileGraph} | null` closure variable is enough.

## 126. /dashboard/* is an unauthenticated read of the entire web/ directory, including the .test.ts sources, with no nosniff or CSP

`src/server/server.ts:139` · **security**

**Evidence**

```
server.ts:139 `if (p.startsWith("/dashboard/")) return serveFile(p.slice("/dashboard/".length));` — any file under web/ with no token. Verified live: `GET /dashboard/app.test.ts` → 200 `application/octet-stream` serving the test source. Responses carry only `content-type` and `cache-control: no-cache`; there is no `X-Content-Type-Options: nosniff`, no `Content-Security-Policy`, and no `Referrer-Policy` — despite app.js:3 claiming the design is "CSP-friendly".
```

**Impact.** Minor on its own (loopback only, source is MIT and public), but it is the mechanism by which any file dropped into web/ becomes world-readable-to-localhost without review, and the missing CSP removes the cheapest available mitigation for the innerHTML issues above. The missing Referrer-Policy matters because the token lives in the page URL: the first cross-origin subresource anyone ever adds to these pages leaks it in the Referer header.

**Fix.** Serve the dashboard from an explicit allowlist (index.html, graph.html, app.js, graph.js, theme.js, avatar.js, style.css) rather than a directory prefix — the whitelist for the top-level routes at line 140 already exists, so `/dashboard/*` is redundant. Add `content-security-policy: default-src 'self'; script-src 'self'; connect-src 'self'`, `x-content-type-options: nosniff` and `referrer-policy: no-referrer` to the two HTML responses.

## 127. Dead xterm vendor route and two unused dependencies

`src/server/server.ts:20` · **maintainability**

**Evidence**

```
`VENDOR_FILES` (server.ts:20-24) maps /xterm.js, /xterm.css and /xterm-addon-fit.js to node_modules paths, served publicly at line 141. `grep -rn "xterm|terminal" web/*.html web/*.js` returns nothing — no page loads them. package.json still carries `@xterm/xterm ^6.0.0` and `@xterm/addon-fit ^0.11.0` for this. `serveVendor` also reads from `nodeModulesDir`, which shares the percent-encoding bug above and is meaningless in a compiled binary.
```

**Impact.** Three public routes and two dependencies that serve a client which does not exist, tied to a terminal feature the code documents as non-functional. Every `bun install` pays for them; every reader of server.ts has to work out that they are unreachable.

**Fix.** Delete `VENDOR_FILES`, `serveVendor`, the line-141 route, and both @xterm dependencies, together with the /terminal/ws removal in the first finding. Pure deletion.

## 128. `CATALOG[provider]` guards use prototype-chain lookups, so `constructor`/`toString` pass the unknown-provider check

`src/server/server.ts:286` · **correctness**

**Evidence**

```
server.ts:286 `if (!cred.provider || !CATALOG[cred.provider]) return json({ error: "unknown provider" }, 400);`. CATALOG is a plain object literal (`catalog.ts:154 export const CATALOG: Record<string, CatalogEntry> = { ...GENERATED_CATALOG, ...MANUAL_CATALOG }`), so it inherits Object.prototype. Verified: `!!CATALOG["constructor"]` is `true` while `Object.hasOwn(CATALOG,"constructor")` is `false`. The same pattern appears at line 266 (`CATALOG[prov]?.models`, which is saved by `?? []`) and in `contextWindow` (catalog.ts:25).
```

**Impact.** `POST /auth {"provider":"constructor","key":"x"}` passes validation and `setCredential` persists a junk entry into the auth store, which then shows up in `GET /auth` and in the TUI's credential list. Token-gated and low-impact, but it is the validation gate for the one route that writes secrets.

**Fix.** `if (!cred.provider || !Object.hasOwn(CATALOG, cred.provider))` at line 286, and the same at line 266 / catalog.ts:25 so every catalog lookup shares one safe accessor.

## 129. `idleTimeout: 0` disables connection timeouts for every route, not just SSE

`src/server/server.ts:130` · **state-management**

**Evidence**

```
server.ts:130 `idleTimeout: 0, // SSE connections are long-lived` — a server-wide setting applied to satisfy one route. Combined with the unbounded SSE queue (finding 3) and no subscriber cap, there is no mechanism anywhere that reclaims a connection the peer has stopped reading.
```

**Impact.** A half-open TCP connection (sleeping laptop, killed VM, wedged proxy) is held open forever along with its subscriber, its interval and its queue. On loopback this is bounded by how many local processes misbehave, so the practical impact is low — but it removes the last backstop that would have cleaned up the leak in finding 3.

**Fix.** Keep a normal idleTimeout (Bun's default 10s) for the server and rely on the 25s ping… which is longer than the default, so instead either drop the ping interval to <idleTimeout, or keep idleTimeout: 0 and implement the desiredSize-based eviction from finding 3. The latter is the real fix; this setting is only safe once something else reclaims dead streams.

## 130. Checkpoint contents are stored in full and never pruned — the DB grows with total bytes written

`src/store/session-store.ts:249` · **perf**

**Evidence**

```
The author flagged this himself at session-store.ts:247-248: "ponytail: full prior contents, never pruned — one row per write, so a long session's .amux/amux.db grows with total bytes written. Add age/count-based pruning if that ever matters." `checkpoint()` inserts `content` verbatim with no size guard, and the only DELETE is inside `undoLast` (:263), which consumes exactly one row. Nothing else ever removes a checkpoint row. The live DB currently has 0 checkpoint rows, so the growth has not yet been observed in practice here.
```

**Impact.** An agent rewriting a 2 MB generated file 50 times in one session writes 100 MB into `.amux/amux.db`, inside a repo directory, with no ceiling and no visibility — `du` on `.amux/` is the only signal. Combined with the never-checkpointed WAL (nothing calls `db.close()`), the on-disk footprint is worse than the row data suggests.

**Fix.** The knowingly-deferred upgrade is now worth taking before publish, because it is three lines. In `checkpoint()`, skip storing content above a threshold (store NULL plus a marker, or the path only) and cap retained rows per session: after the INSERT, `DELETE FROM checkpoints WHERE session_id = ? AND id NOT IN (SELECT id FROM checkpoints WHERE session_id = ? ORDER BY id DESC LIMIT 200)`. The `checkpoints_session(session_id, id)` index (db.ts:64) already supports that query.

## 131. No --help, no --version, and four load-bearing env vars are documented nowhere

`tui/cmd/amux/main.go:156` · **ux**

**Evidence**

```
`grep -n "os.Args|flag\." cmd/amux/main.go` returns nothing — `main()` never inspects arguments. So `amux --help` and `amux --version` spawn a core server and drop the user into the 26-question team picker. Meanwhile `grep -rn "AMUX_NO_MOUSE|AMUX_CORE_ENTRY|AMUX_BUN|AMUX_SERVER_URL|AMUX_SERVER_TOKEN"` across the whole repo (excluding node_modules and old-tech) finds them only inside tui/cmd/amux/main.go and tui/internal — nothing in README.md, nothing in any help output. `AMUX_CORE_ENTRY` is the only workaround for the repo-relative-path bug, and `AMUX_NO_MOUSE` is the only way to get text selection back.
```

**Impact.** The two escape hatches that make the tool usable outside its development checkout and usable for copying text are invisible. And the near-universal reflex of typing `amux --help` on a new CLI starts a server and a 26-question wizard instead of printing anything.

**Fix.** Add a five-line guard at the top of `main`: on `--help`/`-h` print usage including all five env vars and exit 0; on `--version`/`-v` print `ui.Version` and exit 0. Add an ENVIRONMENT section to README.md covering AMUX_CORE_ENTRY, AMUX_BUN, AMUX_SERVER_URL, AMUX_SERVER_TOKEN and AMUX_NO_MOUSE.

## 132. go.mod's header comment asserts the module has never been compiled, which is false and undermines trust in the build

`tui/go.mod:4` · **maintainability**

**Evidence**

```
go.mod:4-6:
	// NOTE: this module was authored in an environment without a Go toolchain, so it has NOT been
	// compiled or `go mod tidy`'d. Versions below are the current stable Charm releases; run
	// `cd tui && go mod tidy && go build ./...` on a machine with Go >= 1.22 to resolve and verify.

Verified on Go 1.26.5:
  $ go build ./...                → exit 0
  $ go test ./...                 → session, theme, wizard all ok
  $ go mod tidy -diff             → no output, exit 0
go.sum is present (3881 bytes) and complete.
```

**Impact.** For a pre-publish audit this is the first thing a reader sees in the module, and it tells them the code is unverified. It also invites a reviewer to waste time re-running a verification that has already been done, and it makes the missing `toolchain` directive look intentional rather than an oversight.

**Fix.** Delete the comment. Add `toolchain go1.22.0` (or whichever version CI pins) so builds are reproducible, and consider raising the `go` directive if any newer stdlib feature is wanted. If the intent was to flag that the module isn't vendored, say that instead — it's true and actionable.

## 133. Every streamed token triggers a full-frame re-render at ~650µs and ~318KB of garbage, with no event coalescing

`tui/internal/session/session.go:259` · **perf**

**Evidence**

```
`Update` re-arms `waitFor(m.events)` after each event (session.go:259), and Bubbletea calls `View()` once per message — tea.go:454 `p.renderer.write(model.View())`. There is no batching between the SSE channel and the model. Measured on an M2 with 6 agents at 160x50, full logs, 200 feed lines and 40 tasks:

  BenchmarkViewPanes-8            624617 ns/op   295636 B/op   1976 allocs/op
  BenchmarkDeltaUpdateAndView-8   654759 ns/op   317537 B/op   1990 allocs/op
  BenchmarkViewStatsHeatmap-8     744044 ns/op   204193 B/op   5257 allocs/op

The stats heatmap is the worst per-allocation case: 7 rows × up to 53 columns are rendered as individual styled strings (stats.go:99-111), one `lipgloss` Render per cell.
```

**Impact.** Six agents streaming at a modest 50 tokens/sec each is 300 events/sec — roughly 20% of an M2 core and ~95MB/sec of allocation churn purely to repaint, before any of it reaches the terminal. On slower hardware, over SSH, or on a Raspberry Pi this becomes the bottleneck, and it happens exactly when the UI most needs to feel responsive. Nothing here is broken, but it's a lot of work to render a screen that changes by one character.

**Fix.** Coalesce at the channel: replace `waitFor` with a drain that takes one event blocking and then non-blockingly drains up to N more from `m.events` into a `[]api.Event`, applying them all in one `Update` before the single `View`. Twenty lines, no behaviour change, and it caps repaints at the terminal's refresh rate under load. If the heatmap ever shows up in a profile, build each row with a single `strings.Builder` of glyphs and one styled Render per shade-run instead of per cell.

## 134. Compaction can fire on the turn that was about to end the loop, paying for a summarization nobody uses

`src/agent/agent.ts:221` · **perf**

**Evidence**

```
'''
        if (reply.usage && overContextThreshold(reply.usage.inputTokens, context, COMPACT_RATIO)) {
          const before = turns.length;
          turns.splice(0, turns.length, ...(await compactTurns(turns, this.provider)));
'''
This sits at line 221, ahead of the terminating check `if (reply.toolCalls.length === 0)` at line 228.
```

**Impact.** When the model's final, tool-free answer arrives while the conversation is past 95%, the loop makes one extra full provider call to summarize a history it is about to discard, then returns `"done"` on the very next line. The user is billed for it and sees a spurious `context compacted automatically` warning on a task that just completed successfully.

**Fix.** Move the compaction block below the `reply.toolCalls.length === 0` early return (i.e. after line 233). One-line move, no behaviour change on the paths that matter.

## 135. Every successful tool call — including reads, hovers and shells — publishes a `file_edit` event

`src/agent/agent.ts:475` · **ux**

**Evidence**

```
'''
      this.bus.publish({ agentId: id, type: "file_edit", payload: `${call.name} → ${output.slice(0, 120).replace(/\n/g, " ")}`, time: Date.now() });
'''
This is outside any branch — it runs for the MCP path, the LSP path and the sandbox path alike, so `read_file`, `hover`, `diagnostics`, `shell` and every MCP tool are all reported as file edits.
```

**Impact.** The TUI and dashboard feeds, and anything filtering on `type === "file_edit"` to answer "what did this agent change?", are dominated by reads. A user scanning for the writes an agent made has to read every payload string to tell them apart, which defeats the point of a typed event. `Engine.undo()` uses the same event type for its own messages (engine.ts:246), compounding the ambiguity.

**Fix.** Branch on the tool: `type: WRITE_TOOLS.has(call.name) ? "file_edit" : "tool_result"` (or reuse the existing `tool_call` type for the non-write case). The event union already lives in src/events/bus.ts, so this is a one-line change plus whatever the TUI/dashboard renderers need to recognize the second type.

## 136. Provider error text is published to the event bus and persisted verbatim, with no secret scrubbing

`src/agent/agent.ts:248` · **security**

**Evidence**

```
`agent.ts:247-250`:
'''ts
this.lastError = summarizeError(err);
if (sessionId) this.store?.setStatus(sessionId, outcome);
this.bus.publish({ agentId: id, type: "error", payload: this.lastError, time: Date.now() });
'''
`summarizeError` (`provider.ts:8-19`) performs no redaction — it unwraps nested JSON and prefixes the status, nothing more. That payload flows to SSE subscribers, the Go TUI, the browser dashboard, and `cli.ts:145-149` which prints every non-delta event to stdout. I verified the two most likely leak vectors are closed: `@google/genai` uses the `x-goog-api-key` header rather than a `?key=` URL for REST calls (`index.mjs:18385`), and the Anthropic/OpenAI SDKs build `APIError.message` from the response body, not from request headers.
```

**Impact.** The remaining exposure is a provider or gateway that echoes the submitted credential back in its own error body — "Invalid API key: sk-abc123…" is a real pattern among smaller OpenAI-compatible resellers, and the curated catalog now includes 20 of them. Such a message would be published to the SSE stream, rendered in the dashboard, written to the session store, and printed to CI logs by the headless path.

**Fix.** One regex in `summarizeError` before returning: `msg = msg.replace(/\b(sk|gho|ghp|gsk|xai|pplx)-[A-Za-z0-9_-]{12,}/g, "[redacted]")`. Cheap, no behaviour change on clean messages, and it is the only place all provider errors funnel through — so one edit covers agent.ts, planner.ts:160 and planner.ts:227.

## 137. `openBrowser` uses a bare `start` on Windows, which is a cmd.exe builtin and not a spawnable executable — the Go TUI gets this right in the same repo

`src/cli.ts:270` · **portability**

**Evidence**

```
src/cli.ts:269-276
  function openBrowser(url: string): void {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try { Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" }); } catch { /* headless — the URL is printed above */ }
  }

The Go side, for the same job, uses the correct invocation:
tui/internal/session/browser.go:18  cmd = exec.Command("cmd", "/c", "start", "", url)
```

**Impact.** On Windows, `Bun.spawn(["start", url])` cannot resolve `start` (there is no start.exe) and fails with ENOENT. Bun surfaces spawn failures asynchronously on the subprocess rather than by throwing synchronously, so the `try/catch` on line 271 does not catch it — `amux-core --web` prints the dashboard URL and then nothing happens, with no error. The empty-string title argument the Go version passes is also required: `start <url>` treats a quoted first argument as a window title.

**Fix.** Match browser.go: `const [cmd, ...pre] = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"]; Bun.spawn([cmd, ...pre, url], { stdout: "ignore", stderr: "ignore" });` and attach an `onExit` that logs nothing but does not leave the failure entirely invisible. The URL is already printed on line 103, so a silent no-open is recoverable — but only if the message on 103 says so.

## 138. diffStat/diffPatch mutate the worktree index as a side effect of a read-only status call

`src/orchestrator/worktree.ts:52` · **correctness**

**Evidence**

```
`export async function diffStat(handle) { await git(handle.path, ["add", "-A"]); const r = await git(handle.path, ["diff", "--stat", "--cached", handle.baseSha]); ... }` (worktree.ts:51-55); diffPatch is identical (line 59-63). Both are called from read paths: `Engine.worktreeStatus` (engine.ts:218) behind `GET /worktree` (server.ts:301), and export.ts:74 behind `/export`.
```

**Impact.** Polling GET /worktree — which the dashboard does — repeatedly runs `git add -A` inside the isolation worktree. A user who has staged a subset of changes by hand in that worktree to review them has their index silently replaced with everything. Any large untracked artifact an agent produced (a build dir not covered by .gitignore) gets added to the index on every poll.

**Fix.** Use git's intent-to-add instead of a real add so untracked files appear in the diff without being staged: replace `["add", "-A"]` with `["add", "-AN"]` in both diffStat and diffPatch, and drop `--cached` from the diff (`git diff <baseSha>` then reflects intent-to-add entries). `commitPending` (worktree.ts:67) keeps its real `add -A` since committing is the point. worktree.test.ts:36 already asserts diffStat sees an untracked `new.txt`, so it will catch a regression.

## 139. `stream_options: { include_usage: true }` is sent unconditionally to every OpenAI-compatible endpoint, including local runtimes

`src/providers/openai.ts:89` · **portability**

**Evidence**

```
`openai.ts:89-93`:
'''ts
const stream = await this.client.chat.completions.create({
  ...params,
  stream: true,
  stream_options: { include_usage: true },
});
'''
No capability check and no per-provider flag exists on `CatalogEntry` (`catalog.ts:10-19`). This one code path serves 30 of the 34 catalog providers — every `client: "openai"` entry — including `ollama` (`http://localhost:11434/v1`), `lmstudio` (`http://127.0.0.1:1234/v1`), `custom`, and every gateway in the generated list.
```

**Impact.** `stream_options` is an OpenAI extension. Endpoints that validate unknown body fields strictly reject the request outright; older Ollama and vLLM builds and several self-hosted gateways have historically done so. The failure lands on the streaming path only, so an agent that works in a non-streaming context test breaks in the TUI, and the resulting 400 mentions a parameter the user never set.

**Fix.** Retry once without it, or make it opt-out per entry. Cheapest: add `noStreamOptions?: boolean` to `CatalogEntry`, set it on `ollama`/`lmstudio`/`custom`, and thread it into the `OpenAIProvider` constructor alongside `headers` (which is already a constructor parameter at `openai.ts:22`, so the plumbing exists).

## 140. 14 src/ modules have no test sibling, and two of them are the transport for every non-Gemini model

`src/providers/openai.ts` · **test-coverage**

**Evidence**

```
Scanning every non-test `.ts` under src/ for a `<name>.test.ts` sibling yields 14 misses: cli.ts, events/bus.ts, lsp/fake-server.ts, lsp/registry.ts, orchestrator/runner.ts, orchestrator/task.ts, providers/anthropic.ts, providers/catalog.generated.ts, providers/factory.ts, providers/openai.ts, server/events.ts, server/main.ts, store/session-store.ts, tools/lsp-tools.ts. On the Go side, `tui/internal/api/client.go` and `tui/internal/ui/list.go` are the two packages with no `_test.go`. `providers/gemini.ts`, `copilot.ts`, `pricing.ts` and `provider.ts` all have tests — anthropic.ts and openai.ts are the gap, and openai.ts is the client behind ~30 of the catalog's 34 providers.
```

**Impact.** The three highest-traffic untested modules are openai.ts (every OpenAI-compatible provider), anthropic.ts (Claude), and session-store.ts (every persisted turn, and the checkpoints /undo depends on). Their sibling modules' tests establish that the project's convention is one test file per module, so these are omissions rather than a deliberate policy. `server/main.ts` being untested is why the two divergent engine constructors (buildEngine vs serveMain) drifted apart unnoticed.

**Fix.** Do not chase coverage; add one test file each for the three that carry real risk. `openai.ts`/`anthropic.ts`: a table test over the tool-call translation shapes with a stubbed client, asserting the normalized `Turn` — the seam is already one method wide, which is what makes this cheap. `session-store.ts`: one round-trip test (write a turn, read it back, take a checkpoint, undo) against an in-memory `bun:sqlite` db, matching what `db.test.ts` already does. Leave task.ts, catalog.generated.ts and fake-server.ts alone — a type file, a generated file and a test helper do not need tests.

## 141. `.amux/session.json` is resolved relative to `process.cwd()` while every other artefact is resolved against `engine.root`

`src/session.ts:7` · **correctness**

**Evidence**

```
src/session.ts:7   const DEFAULT = ".amux/session.json";   // relative to process.cwd()

Engine root is explicit and may differ:
src/engine.ts:73   this.root = opts.root ?? process.cwd();

And the export command does use it:
src/commands/export.ts:92  const dir = join(engine.root, ".amux", "reports");

Both `loadTasks()` (cli.ts:144, server/main.ts:52) and `saveTasks([])` (registry.ts:245) call the relative default with no root argument. `loadOptions`, `loadAgents` and `setTheme` in config.ts share the same relative-path default (config.ts:37, :134).
```

**Impact.** Whenever the core is started from a directory other than the project root — `AMUX_CORE_ENTRY` is resolved relative to cwd by the Go TUI (tui/cmd/amux/main.go:49), and `bun run src/server/main.ts` from a subdirectory is a natural thing to try — the task board is read from and written to the wrong `.amux/`, while `/export` correctly writes into the project's `.amux/reports/`. The board silently comes back empty, and `/clear`'s `saveTasks([])` (registry.ts:245) truncates a session file in whatever directory the user happened to be in.

**Fix.** Thread the root through: change `saveTasks(tasks, path = DEFAULT)` / `loadTasks(path = DEFAULT)` to take a root (`sessionPath(root) => join(root, ".amux", "session.json")`) and pass `engine.root` from registry.ts:245, and the same root serveMain/buildEngine used from cli.ts:144 and server/main.ts:52. Alternatively resolve the project root once at startup and `process.chdir()` to it, which makes every relative default in config.ts correct at the same time — one line versus threading a parameter through five call sites.

## 142. A malformed SKILL.md frontmatter aborts engine startup with a raw YAML error

`src/skills/skills.ts:22` · **error-handling**

**Evidence**

```
'''
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    const fm = (m ? (parse(m[1]!) ?? {}) : {}) as Record<string, unknown>;
'''
`parse` is `yaml.parse` and throws on a syntax error. `loadSkills()` is called unguarded at cli.ts:167 inside `buildEngine`, whose only handler is `surfaceStartupError` (cli.ts:190-194), which matches on `/ENOENT|agents\.yaml/` and otherwise `die(msg)`.
```

**Impact.** One skill file with an unquoted colon in its description takes down `amux-core` at startup with a YAMLParseError that names a line number but not which SKILL.md it came from — while `loadInstructions` deliberately does the opposite for the analogous case (config.ts:52-54: "a listed file that doesn't exist is skipped rather than fatal … half a prompt beats a core that won't boot"). The two loaders disagree on the same policy question.

**Fix.** Wrap the parse: `let fm = {}; try { fm = m ? (parse(m[1]!) ?? {}) : {}; } catch { /* bad frontmatter → name from dir, no description */ }`, matching loadInstructions' posture. Three lines, and it keeps a broken skill from bricking the whole tool.

## 143. The Go TUI shells out to `git` in a package-level variable initializer, before Bubbletea starts and before any error can be shown

`tui/internal/session/settings.go:405` · **portability**

**Evidence**

```
`var userName = detectUser()` (line 405) — a package-scope initializer. `detectUser()` (407-417) calls `exec.Command("git", "config", "user.name").Output()`, a blocking subprocess. The comment at 403-404 explains the caching rationale ('computed at package load, not per-frame — it can't change mid-session') but not the placement. The result feeds `greeting()` (387-401), rendered by both `welcomeView` (328) and `settWelcome` (120).
```

**Impact.** Package initializers run before `main` can install any UI or error handling, so a `git` that is missing, slow, or blocked on an index lock (network filesystem, a concurrent operation, a repo with a stale `.git/index.lock`) stalls or slows every `amux` launch with a blank terminal and no way to attribute it. It also fires during `go test ./internal/session/...`, spawning a subprocess per test binary. The failure is silently swallowed (`if err == nil`), so the only symptom is a delay and a greeting that says 'there'.

**Fix.** Make it lazy and bounded — resolve on first `greeting()` call behind a `sync.Once`, with `exec.CommandContext` and a 300ms timeout, falling back to `$USER`. Or, laziest and sufficient: reverse the order so `$USER` (a free environment read) is tried first and `git config` is consulted only when it is empty. `$USER` is set in every interactive shell this TUI runs in.

---

# The shipping strategy

The findings above are individually scoped. This section is the consolidated answer to the actual
question: *what does it take to make `npm i -g <amux>` work for a stranger?*

## Why the current shape cannot work

Four independent walls, each fatal on its own:

1. **`bin` points at TypeScript.** `"amux-core": "./src/cli.ts"` with `#!/usr/bin/env bun`. npm
   creates a shim that `exec`s that file; Node cannot parse `.ts`, and a user who has Node but not
   Bun has no `bun` on PATH to satisfy the shebang either.
2. **The Bun-only API surface is not portable.** `bun:sqlite` (`store/db.ts:1`,
   `session-store.ts:2`), `Bun.serve` (`server.ts:127`), `Bun.Glob` (`permissions.ts:47`,
   `approval.ts:38`), `Bun.spawn` (`cli.ts:272`), `Bun.write` (`gen-catalog.ts:126`). **amux cannot
   run on plain Node without rewriting all five.** So the runtime must ship *with* the package.
3. **`bun build --compile` is the intended answer and it is currently broken** — `node-pty`'s native
   addon cannot be embedded (finding #2). Fixing that is a deletion, not a port.
4. **Two binaries, two toolchains, N platforms.** A Go TUI *and* a Bun core, each single-arch. The
   repo has no cross-compilation, no platform matrix, and no CI.

## The recommended shape

The `esbuild`/`swc` pattern, which is what `@anthropic-ai/claude-code` and `opencode` both use: a
thin, platform-agnostic launcher package that depends on per-platform binary packages, and npm's
`os`/`cpu` fields make the installer pick exactly one.

```
amux                      ← the package users install; no binaries, tiny
├── bin/amux.js           ← #!/usr/bin/env node — resolves + execs the right binary
└── optionalDependencies:
    @amux/darwin-arm64    ← ships prebuilt `amux` (Go) + `amux-core` (Bun), os/cpu pinned
    @amux/darwin-x64
    @amux/linux-x64
    @amux/linux-arm64
    @amux/win32-x64
```

The launcher is the only JavaScript that must run under Node, and it stays trivial:

```js
#!/usr/bin/env node
// bin/amux.js — resolve the platform package and hand over. No logic beyond this.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pkg = `@amux/${process.platform}-${process.arch}`;
let bin;
try {
  bin = require.resolve(`${pkg}/bin/amux${process.platform === "win32" ? ".exe" : ""}`);
} catch {
  console.error(
    `amux: no prebuilt binary for ${process.platform}-${process.arch}.\n` +
    `Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64.`,
  );
  process.exit(1);
}
process.exit(spawnSync(bin, process.argv.slice(2), { stdio: "inherit" }).status ?? 1);
```

`optionalDependencies` + `os`/`cpu` is what makes this work: npm silently skips the platform
packages that do not match, so a macOS user downloads one binary, not five.

## The work, in order

### 1. Repository integrity (findings #1, #6)

```diff
--- .gitignore
-amux
-amux-core
+/amux
+/amux-core
```
Then `git add -f tui/cmd/amux/main.go`, and move `old-tech/` out of the repo (or add it to
`bun test`'s ignore path and delete the phantom `ink`/`react` imports). Verify:
`git ls-files tui | wc -l` → 25, and a clean `git clone` + `bun install` + `bun test` is green.

### 2. Make the compiled core work (findings #2, #3)

Delete the browser-terminal feature: `node-pty` import and `IPty` type (`server.ts:4-5`), the
`TerminalSocketData.pty` field, the `/terminal/ws` route, the whole `websocket:` block, the three
`VENDOR_FILES` entries, `node-pty`/`@xterm/xterm`/`@xterm/addon-fit` from `package.json`, the
`postinstall` hook, and `scripts/fix-pty-perms.ts`. Then:

```
bun build --compile ./src/cli.ts --outfile amux-core
cd /tmp && /path/to/amux-core --help    # must exit 0
```

This is the single highest-leverage change in the whole audit: it repairs the build product,
removes 4 of 10 runtime dependencies, and deletes a `postinstall` hook that npm 11 defers by
default anyway.

### 3. Make both binaries relocatable (findings #4, #12, #48)

- `tui/cmd/amux/main.go:49-51` — resolve the core as a sibling of `os.Executable()`, then
  `exec.LookPath("amux-core")`, then the current repo-relative path as a dev fallback. Prefer the
  compiled `amux-core` over `bun run src/server/main.ts`.
- `src/server/server.ts:53,75,88` — `new URL("../../web", import.meta.url).pathname` is
  **percent-encoded**; a path containing a space or any non-ASCII character 404s the whole
  dashboard. Use `fileURLToPath()` instead — and note that under `--compile` these paths point
  inside `/$bunfs/`, so `web/` and `palettes.json` must be embedded or shipped alongside.
- `src/config/config.ts` — walk up from `cwd` to find `.amux/`, the way git finds `.git`. Today
  every path is cwd-relative, so running from a subdirectory silently creates a second `.amux/`
  and starts with zero agents.

### 4. `package.json` for publication

```jsonc
{
  "name": "@yourscope/amux",   // `amux` is taken — npm view amux → donavon, v0.0.0
  "version": "0.1.0",
  "private": false,            // or delete the key
  "description": "...",
  "bin": { "amux": "./bin/amux.js" },
  "files": ["bin/", "web/", "README.md", "LICENSE"],
  "engines": { "node": ">=18" },
  "repository": { "type": "git", "url": "git+https://github.com/<you>/amux.git" },
  "homepage": "...", "bugs": { "url": "..." },
  "keywords": ["ai", "agents", "cli", "llm", "coding-agent", "tui"],
  "author": "...",
  "license": "MIT",
  "publishConfig": { "access": "public" },
  "optionalDependencies": { "@yourscope/amux-darwin-arm64": "0.1.0", "...": "..." }
}
```

`files` is the critical addition. Without it npm falls back to `.gitignore`, which is why the
current tarball ships 135 files including the maintainer's personal `.amux/agents.yaml`, the dead
`old-tech/` tree, every `.test.ts` and the entire Go source — **and no executable at all**.

**Before publishing, un-track the personal config:** `git rm --cached .amux/agents.yaml` and add
`.amux/` to `.gitignore` (finding #40). It currently ships a working roster pointed at real billable
Gemini models with `shell` in `allowedTools`.

### 5. CI (finding #83)

There is none. Minimum viable matrix, given three toolchains and a suite that is currently red on a
clean checkout:

- `bun install --frozen-lockfile && bun run typecheck && bun test` on a **clean checkout**
- `cd tui && go build ./... && go vet ./... && go test ./...`
- `bun build --compile` + smoke-run `--help` **from an empty directory**, on each target platform
- `npm pack` + install the tarball into a scratch dir + run `amux --version`

The third and fourth are the ones that would have caught findings #1, #2 and #4 the day they landed.

## Pre-publish checklist

Nothing here is optional; each line maps to a finding above.

- [ ] `.gitignore` anchored; `tui/cmd/amux/main.go` tracked (#1)
- [ ] Clean clone → `bun install` → `bun test` green (#6)
- [ ] `node-pty`, `@xterm/*`, `postinstall`, `fix-pty-perms.ts` deleted (#2, #3)
- [ ] `bun build --compile` output runs `--help` from `/tmp` with exit 0 (#2)
- [ ] `go build ./cmd/amux` from a clean clone succeeds (#1)
- [ ] TUI finds the core outside a repo checkout (#4)
- [ ] `shell` tool has a timeout, an output cap and a closed stdin (#5)
- [ ] `--help` and `--version` implemented; unknown subcommands rejected, not billed (#26, #27)
- [ ] Headless runs exit non-zero when tasks fail (#29)
- [ ] Catalog/README reconciled — 149 vs 21 vs "150+" (#42)
- [ ] `.amux/agents.yaml` un-tracked; `~/.config` and project state never in the tarball (#40, #60)
- [ ] `files` field present; `npm pack --dry-run` lists **only** `bin/`, `web/`, docs, licence
- [ ] Package name available and scoped; `private` removed; metadata complete
- [ ] `npm pack` → install into a scratch dir → `amux --version` works
- [ ] CI green on all three toolchains

## What this audit did not cover

Stated so the gaps are known rather than assumed:

- **No live provider calls.** Every provider path was read, not exercised — no API keys were used
  and no billable requests were made. Streaming, tool-call translation and retry behaviour are
  assessed from source only.
- **Single platform.** Everything was verified on darwin-arm64 (Bun 1.3.10, Go 1.22). The Windows
  paths (`openBrowser`'s `start`, conpty, path separators) are reasoned about, not run.
- **No interactive TUI session.** The Go TUI was built and unit-tested but not driven by hand; TUI
  UX findings come from reading the Bubbletea model/update/view code.
- **No load or soak testing.** Performance findings are from reading algorithms and measuring file
  sizes, not from profiling under real multi-agent load.
- **The web dashboard was not opened in a browser.** Its findings are from reading `app.js`,
  `graph.js` and `theme.js`.
