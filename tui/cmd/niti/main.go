// Command niti is the Go + Bubbletea front-end. It spawns the Bun core server, reads the handshake
// line from its stdout, then runs the team picker and the live multi-agent view.
//
//	cd tui && go build -o niti-tui ./cmd/niti
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"github.com/niti/tui/internal/api"
	"github.com/niti/tui/internal/session"
	"github.com/niti/tui/internal/theme"
	"github.com/niti/tui/internal/trust"
	"github.com/niti/tui/internal/wizard"
	tea "github.com/charmbracelet/bubbletea"
)

type handshake struct {
	NitiServer struct {
		URL   string `json:"url"`
		Token string `json:"token"`
	} `json:"nitiServer"`
}

type core struct {
	client   *api.Client
	cmd      *exec.Cmd
	attached bool // true when NITI_SERVER_URL pointed us at a core we don't own
	log    *os.File     // core stderr goes here, never to the terminal the TUI is drawing on
	exited chan struct{} // closed when cmd.Wait returns, so the TUI can tell "dead" from "quiet"
}

// stop ends the core and everything it started. Two things used to go wrong here: SIGKILL is
// uncatchable, so the core never closed its MCP/LSP children, its SQLite handle or its watcher;
// and without a process group the signal reached only the direct child, so every language server
// and MCP server was reparented to init and survived. One relaunch per picker run meant that
// leaked on the happy path, not just on errors.
func (c *core) stop() {
	if c == nil || c.cmd == nil || c.cmd.Process == nil {
		return
	}
	pid := c.cmd.Process.Pid
	terminateGroup(pid) // SIGTERM to the whole group (see main_unix.go / main_windows.go)
	select {
	case <-c.exited: // it shut down cleanly
	case <-time.After(2 * time.Second):
		killGroup(pid) // escalate; a core wedged in a provider call must not block quitting
		<-c.exited
	}
	if c.log != nil {
		_ = c.log.Close()
	}
}

const devEntry = "src/server/main.ts"
const cliEntry = "src/cli.ts"

// findCoreBinary looks for the compiled niti-core the way an installed copy has to: shipped
// alongside this binary, then on $PATH. Shared by coreCmd (the long-running server) and
// coreCLIFor (short synchronous CLI calls like trust check/grant) — both need the same answer to
// "where is niti-core", they just invoke it differently once found.
func findCoreBinary() (path string, tried []string) {
	bin := "niti-core"
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	if exe, err := os.Executable(); err == nil {
		// npm links bin/ entries as symlinks; the sibling core lives next to the real file.
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		sibling := filepath.Join(filepath.Dir(exe), bin)
		if st, err := os.Stat(sibling); err == nil && !st.IsDir() {
			return sibling, nil
		}
		tried = append(tried, sibling)
	}
	if p, err := exec.LookPath(bin); err == nil {
		return p, nil
	}
	return "", append(tried, bin+" on $PATH")
}

// coreCmd resolves the long-running core the way an installed copy has to find it: an explicit
// override first, then the compiled niti-core, then the repo-relative dev entry — which exists
// solely for `cd niti && go run ./cmd/niti`. It used to be the *only* candidate, which made a
// globally installed niti work in exactly one directory on earth. On failure it returns every path
// it looked at, so the error can say where to put one.
func coreCmd() (*exec.Cmd, []string) {
	if entry := os.Getenv("NITI_CORE_ENTRY"); entry != "" {
		return exec.Command(envOr("NITI_BUN", "bun"), "run", entry), nil
	}
	if path, tried := findCoreBinary(); path != "" {
		return exec.Command(path, "serve"), nil
	} else if _, err := os.Stat(devEntry); err == nil {
		return exec.Command(envOr("NITI_BUN", "bun"), "run", devEntry), nil
	} else {
		return nil, append(tried, devEntry+" (dev checkout)")
	}
}

// coreCLIFor resolves a short, synchronous niti-core CLI call (trust check/grant) — same
// installed-binary search as coreCmd, but the dev-checkout fallback always targets cli.ts rather
// than devEntry: server/main.ts has no subcommand dispatch of its own (only `serve` does), while
// trust/audit/etc. are cli.ts's. NITI_CORE_ENTRY is deliberately not honoured here — that override
// exists to point the long-running server at a specific entry, not to redirect one-shot CLI calls,
// and any checkout that could set it also has src/cli.ts sitting right there.
func coreCLIFor(args ...string) (*exec.Cmd, []string) {
	if path, tried := findCoreBinary(); path != "" {
		return exec.Command(path, args...), nil
	} else if _, err := os.Stat(cliEntry); err == nil {
		return exec.Command(envOr("NITI_BUN", "bun"), append([]string{"run", cliEntry}, args...)...), nil
	} else {
		return nil, append(tried, cliEntry+" (dev checkout)")
	}
}

// startCore attaches to a running server (NITI_SERVER_URL/TOKEN) or spawns the core (see coreCmd)
// and reads its one-line JSON handshake from stdout.
func startCore() (*core, error) {
	if url := os.Getenv("NITI_SERVER_URL"); url != "" {
		// Attached to someone else's core: we did not spawn it, so we cannot restart it either.
		return &core{client: api.New(url, os.Getenv("NITI_SERVER_TOKEN")), attached: true}, nil
	}
	cmd, tried := coreCmd()
	if cmd == nil {
		return nil, fmt.Errorf("no niti-core found — looked for:\n  %s\nbuild one with `bun run build`, or set NITI_CORE_ENTRY",
			strings.Join(tried, "\n  "))
	}
	// Both Bubbletea programs take the alt screen on this same tty, so anything the core writes to
	// stderr lands *on top of* the rendered frame and corrupts it until the next full repaint —
	// and a multi-line provider stack trace is unscrollable there. Send it to a file instead.
	logFile, logPath := openCoreLog()
	if logFile != nil {
		cmd.Stderr = logFile
	}
	setProcessGroup(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("could not start core (%s): %w", strings.Join(cmd.Args, " "), err)
	}
	c := &core{cmd: cmd, log: logFile, exited: make(chan struct{})}
	// Always reaped, so the core never lingers as a zombie and `exited` is a reliable signal that
	// the process is genuinely gone (rather than merely quiet).
	go func() {
		_ = cmd.Wait()
		close(c.exited)
	}()

	r := bufio.NewReader(stdout)
	// Bounded. An unbounded ReadString here meant a core that hung — a slow first import, a wedged
	// MCP server, a stalled provider handshake — left the user staring at a blank terminal forever
	// with no output and no way to tell whether anything was happening.
	type readResult struct {
		line string
		err  error
	}
	lineCh := make(chan readResult, 1)
	go func() {
		l, e := r.ReadString('\n')
		lineCh <- readResult{l, e}
	}()

	var line string
	select {
	case res := <-lineCh:
		line, err = res.line, res.err
	case <-time.After(2 * time.Second):
		// Still the normal screen at this point (Bubbletea hasn't taken it), so this is safe to print.
		fmt.Fprintln(os.Stderr, "niti: starting the core…")
		select {
		case res := <-lineCh:
			line, err = res.line, res.err
		case <-time.After(28 * time.Second):
			c.stop()
			where := logPath
			if where == "" {
				where = "the core's output"
			}
			return nil, fmt.Errorf("the core did not start within 30s — check %s", where)
		}
	}
	if err != nil {
		c.stop()
		hint := ""
		if logPath != "" {
			hint = fmt.Sprintf(" — see %s", logPath)
		}
		return nil, fmt.Errorf("core did not hand shake: %w%s", err, hint)
	}
	var hs handshake
	if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &hs); err != nil || hs.NitiServer.URL == "" {
		c.stop()
		return nil, fmt.Errorf("unexpected handshake: %q", line)
	}
	go func() { // drain the rest of the core's stdout to the log so the pipe never blocks
		for {
			l, e := r.ReadString('\n')
			if len(l) > 0 && logFile != nil {
				_, _ = logFile.WriteString(l)
			}
			if e != nil {
				return
			}
		}
	}()
	c.client = api.New(hs.NitiServer.URL, hs.NitiServer.Token)
	return c, nil
}

// .niti/core.log, truncated per launch so it stays the current run's log rather than growing
// forever. A failure to open it is not fatal — the core just runs without its output captured,
// which beats refusing to start over a log file.
func openCoreLog() (*os.File, string) {
	if err := os.MkdirAll(".niti", 0o755); err != nil {
		return nil, ""
	}
	path := filepath.Join(".niti", "core.log")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return nil, ""
	}
	return f, path
}

// streamWithReconnect keeps `events` fed for the life of ctx, reconnecting with backoff whenever
// api.StreamEvents ends with ErrStreamDisconnected (server restart, network drop, oversized line —
// see client.go). It tracks the last-seen seq so a reconnect replays only what was missed. `events`
// is owned by the caller and is never closed here (StreamEvents never closes it either), since a
// fresh attempt keeps writing into the same channel across reconnects.
func streamWithReconnect(ctx context.Context, client *api.Client, events chan<- api.Event, exited <-chan struct{}) {
	fromSeq := 0
	backoff := time.Second
	const maxBackoff = 15 * time.Second
	// Every stream error used to be consumed here, so a core that died left the TUI painting a
	// normal session forever: agents shown as "working", progress frozen, status "running". The
	// only way to find out was to type a slash command and get "connection refused".
	var down atomic.Bool
	note := func(state string) {
		select {
		case events <- api.Event{Kind: "connection", State: state, Time: time.Now().UnixMilli()}:
		case <-ctx.Done():
		}
	}
	for ctx.Err() == nil {
		tap := make(chan api.Event, 256)
		forwardDone := make(chan struct{})
		go func() {
			defer close(forwardDone)
			for e := range tap {
				// An event arriving is the only real proof the core is answering again; the
				// reconnect attempt itself proves nothing, since StreamEvents blocks on success.
				if down.CompareAndSwap(true, false) {
					note("restored")
				}
				fromSeq = e.Seq
				select {
				case events <- e:
				case <-ctx.Done():
					return
				}
			}
		}()

		err := client.StreamEvents(ctx, fromSeq, tap)
		close(tap)
		<-forwardDone

		if ctx.Err() != nil {
			return // deliberate shutdown
		}
		if err == nil || errors.Is(err, context.Canceled) {
			return
		}
		// A process that has exited will never come back, however long the backoff runs — say so
		// once and stop pretending a reconnect is pending.
		select {
		case <-exited:
			note("dead")
			return
		default:
		}
		if down.CompareAndSwap(false, true) {
			note("lost")
		}
		// ErrStreamDisconnected (or any other unexpected end) — reconnect with capped backoff.
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			return
		}
		if backoff < maxBackoff {
			backoff *= 2
		}
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// screenOpts is how both programs take the terminal. The alt screen keeps niti out of the shell's
// scrollback; mouse reporting is what stops the *wheel* from scrolling that scrollback back into
// view over the top of a running session — without it the terminal, not the app, handles the scroll
// and the frame the user is looking at slides away. Set NITI_NO_MOUSE=1 to give the wheel (and
// drag-to-select) back to the terminal.
func screenOpts() []tea.ProgramOption {
	opts := []tea.ProgramOption{tea.WithAltScreen()}
	if os.Getenv("NITI_NO_MOUSE") == "" {
		opts = append(opts, tea.WithMouseCellMotion())
	}
	return opts
}

// The core spawned by this process, so fatal() can take it down with us: os.Exit skips deferred
// calls, which orphaned a running niti-core server on every error path after startCore succeeded.
var running *core

func fatal(err error) {
	running.stop() // nil-safe
	fmt.Fprintln(os.Stderr, "niti:", err)
	os.Exit(1)
}

// ensureTrustedTUI runs before startCore() spawns anything: if this project directory isn't
// trusted yet (or its mcpServers: config changed since it last was), it shows the trust prompt
// before any MCP/LSP server or agents.yaml content from this directory is ever touched. Returns
// false if the human declined — main() must return without calling startCore() at all in that
// case, so nothing in the directory gets read or executed.
func ensureTrustedTUI() bool {
	checkCmd, _ := coreCLIFor("trust", "check")
	if checkCmd == nil {
		return true // can't resolve niti-core at all — let startCore() surface that error next
	}
	out, err := checkCmd.Output()
	if err == nil {
		return true // exit 0 → already trusted
	}
	var info struct {
		Root    string `json:"root"`
		Changed bool   `json:"changed"`
	}
	_ = json.Unmarshal(out, &info)

	final, perr := tea.NewProgram(trust.New(info.Root, info.Changed), screenOpts()...).Run()
	if perr != nil {
		fatal(perr)
	}
	tm, ok := final.(trust.Model)
	if !ok || tm.Choice == trust.No {
		return false
	}
	if tm.Choice == trust.Remember {
		if grantCmd, _ := coreCLIFor("trust", "grant"); grantCmd != nil {
			_ = grantCmd.Run() // best-effort; worst case the next launch asks again
		}
	}
	// Approved for this run either way — the spawned core's own gate must not ask a second time.
	os.Setenv("NITI_TRUST", "1")
	return true
}

// parseArgs pulls the global --verbose / -v flag out of the arguments, wherever it appears, and
// returns the rest (the optional subcommand) in order.
func parseArgs(args []string) (verbose bool, rest []string) {
	for _, a := range args {
		if a == "--verbose" || a == "-v" {
			verbose = true
		} else {
			rest = append(rest, a)
		}
	}
	return
}

// applyTheme applies the project's `theme:` and `lightMode:` from agents.yaml; ctrl+t still
// overrides the theme live.
func applyTheme(sess api.SessionInfo) {
	if sess.Theme != "" && !theme.Use(sess.Theme) {
		fmt.Fprintf(os.Stderr, "niti: unknown theme %q — using %s\n", sess.Theme, theme.Current())
	}
	theme.SetLight(sess.LightMode)
}

func main() {
	// Skipped when attached to a core we didn't spawn (NITI_SERVER_URL set) — nothing to gate,
	// since we aren't the one reading this directory's config or spawning anything from it.
	if os.Getenv("NITI_SERVER_URL") == "" && !ensureTrustedTUI() {
		fmt.Println("niti: not trusted — exiting without touching this directory.")
		return
	}
	c, err := startCore()
	if err != nil {
		fatal(err)
	}
	running = c
	defer func() { c.stop() }() // closure → stops whichever core is current at exit

	sess, err := c.client.Session()
	if err != nil {
		fatal(fmt.Errorf("cannot reach core: %w", err))
	}

	// The saved theme and light/dark choice apply before the picker, which is the first thing on
	// screen — otherwise it always drew in the base palette and then jumped when the session began.
	applyTheme(sess)

	// The team picker runs on every launch, not just the first: a static agents.yaml stops being
	// useful the moment you want to try a different model without hand-editing YAML. It offers the
	// whole provider catalog and asks for a key only when an unconfigured provider is chosen, so
	// there's no separate first-run flow to keep in step with it. When a roster already exists it
	// opens on "keep this team?" (enter = keep), so a relaunch costs one keystroke, not 26.
	final, err := tea.NewProgram(wizard.NewPicker(c.client, sess.Agents), screenOpts()...).Run()
	if err != nil {
		fatal(err)
	}
	pm, ok := final.(wizard.Picker)
	if !ok || !pm.Completed {
		return // user cancelled the picker
	}
	// Only re-read agents.yaml if the picker actually rewrote it. Keeping the existing team leaves
	// the file (and the running core) untouched, so the restart is pure latency.
	if !pm.Kept {
		// agents.yaml is loaded once, at core startup. Attached to a core we did not spawn, there
		// is nothing we can restart — so the new roster was written to disk and then silently
		// ignored for the whole session. Say so rather than pretending it took effect.
		if c.attached {
			fmt.Fprintln(os.Stderr, "niti: saved the new team to .niti/agents.yaml, but this core was already running —")
			fmt.Fprintln(os.Stderr, "      restart it (or unset NITI_SERVER_URL) for the change to take effect.")
		} else {
			c.stop()
			if c, err = startCore(); err != nil {
				fatal(err)
			}
			running = c // the restarted core is the one fatal() has to take down now
			if sess, err = c.client.Session(); err != nil {
				fatal(err)
			}
		}
	}

	applyTheme(sess) // the restarted core may have a different agents.yaml

	ctx, cancel := context.WithCancel(context.Background())
	events := make(chan api.Event, 256)
	go streamWithReconnect(ctx, c.client, events, c.exited)

	m := session.New(c.client, sess, events, cancel)
	verbose, rest := parseArgs(os.Args[1:])
	m = m.WithVerbose(verbose)
	if len(rest) > 0 {
		m = m.OpenSettings(rest[0]) // niti status | config | settings | usage | stats
	}
	// Ask the terminal to report Shift+Enter (see session.EnableModifiedEnter), and put it back on
	// the way out so it doesn't leak into the user's shell.
	fmt.Fprint(os.Stdout, session.EnableModifiedEnter)
	_, err = tea.NewProgram(m, screenOpts()...).Run()
	fmt.Fprint(os.Stdout, session.DisableModifiedEnter)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	cancel()
}
