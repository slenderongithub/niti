// Package session renders the live multi-agent view: one pane per agent, a communication feed
// showing agents talking to each other, the task DAG, usage, and the approval prompts.
package session

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/niti/tui/internal/api"
	"github.com/niti/tui/internal/theme"
	"github.com/niti/tui/internal/ui"
)

type eventMsg api.Event
type eventsMsg []api.Event // a coalesced batch — see waitFor
type errMsg struct{ err error }

// commandsMsg delivers the server-side slash-command registry once it has been fetched.
type commandsMsg struct{ commands []api.Command }

// commandResultMsg is the outcome of running one of those commands.
type commandResultMsg struct {
	name   string
	result api.CommandResult
	err    error
}

// actionResultMsg reports the outcome of a fire-and-forget client call (approve/cancel) that was
// dispatched as a tea.Cmd rather than a bare goroutine, so its error reaches Update() instead of
// being silently discarded.
type actionResultMsg struct {
	action string
	err    error
}

type agentState struct {
	cfg      api.AgentConfig
	status   string // idle | working | done | failed
	activity string
	tokens   int
	in, out  int // split input/output totals, for the /usage and /stats breakdowns
	calls    int
	ctxUsed  int // most recent call's input tokens = current context depth
	ctxLimit int // the model's context window, from /session
	log      []string
	verbose  bool       // mirrors Model.verbose: no merging of same-tool runs
	running  string     // tool call in flight, e.g. "Run npm test"; see toolfeed.go
	group    *toolGroup // the collapsed line at the tail of log, if any
	pending  string // partial line being streamed by `delta` events, shown live under the log
	color    lipgloss.Color
	avatar   string
}

// Per-agent scrollback. Only the tail is rendered in the pane, but /transcript pages through all
// of it — at 60 lines an agent's output was genuinely unrecoverable once it scrolled, which for a
// tool whose entire product is agent output is the wrong trade. 600 lines × 6 agents is a few
// hundred KB.
const agentLogMax = 600

func (s *agentState) push(line string) {
	if line = strings.TrimRight(line, " \t\r"); line == "" {
		return
	}
	if len(s.log) > 0 && s.log[len(s.log)-1] == line { // a retry loop repeating itself is one line, not ten
		return
	}
	s.log = append(s.log, line)
	if len(s.log) > agentLogMax {
		s.log = s.log[len(s.log)-agentLogMax:]
	}
}

// feedDelta accumulates a streamed text chunk, flushing to the log a line at a time so the pane
// reads like a transcript instead of a jumble. A model that streams a long paragraph without any
// newline is force-flushed at maxPendingLine, so `pending` can't grow without bound.
const maxPendingLine = 400

func (s *agentState) feedDelta(chunk string) {
	s.pending += chunk
	for {
		i := strings.IndexByte(s.pending, '\n')
		if i < 0 {
			break
		}
		s.push(cleanMarkdown(s.pending[:i]))
		s.pending = s.pending[i+1:]
	}
	if len(s.pending) > maxPendingLine {
		s.push(cleanMarkdown(s.pending))
		s.pending = ""
	}
}

type Model struct {
	sid       string // this TUI launch's id, shown on the Status tab
	autoCompact, thinkingMode bool // mirrors the core's live settings; toggled from the Config tab
	verbose   bool   // list every tool call separately instead of collapsing runs
	ticking   bool // a spinner tick is scheduled
	client    *api.Client
	events    <-chan api.Event
	cancel    context.CancelFunc
	order     []string // agent ids in roster order
	agents    map[string]*agentState
	tasks     []api.Task
	messages  []api.AgentMessage
	feed      []string
	approvals []api.Approval
	input     textinput.Model
	goal      string
	progress  int
	commands  []api.Command // fetched from the server registry; drives dispatch and the footer hints
	menu      ui.List       // slash-command suggestions shown over the prompt while typing "/…"
	menuOpen  bool
	car       carousel    // the ctrl+p model switcher, when open
	sett      settings    // the /settings · /status · /config · /usage · /stats overlay, when open
	out       output      // the pager a multi-line command result opens, when open
	diffv     diffview    // full-screen state for the diff-viewing approval (edit/write_file only)
	tp        themePicker // the ctrl+t theme swatch picker, when open
	ap        agentPicker // the ctrl+g "switch agent window" quick-picker, when open
	view      string      // "panes" | "usage"
	focus     string      // agent id currently maximized in the work pane, or "" for the stacked overview
	totals    api.Totals
	// Project context for the sidebar — fixed for the life of the core process.
	root string
	lsp  []api.LspInfo
	mcp  []api.McpInfo
	// Live session spend. costKnown=false → some model has no published price, so show "+".
	cost      float64
	costKnown bool
	mode      string // "build" (agents execute) | "plan" (orchestrator plans, nothing runs)
	width     int
	height    int
	status    string
	// True between a "lost"/"dead" connection event and a "restored" one. The header shows it,
	// because a frozen-but-normal-looking frame is the worst way to learn the core is gone.
	disconnected bool
	quitArm      time.Time // when ctrl+c was last pressed — a second press inside quitGrace leaves
	// When a plain-text goal was last held back because the board still has unfinished work. Same
	// two-press shape as quitArm: the first enter explains, a second inside the window commits.
	resubmitArm time.Time
	quitting    bool
}

// Long enough that pasting a file or a stack trace is not silently clipped; still bounded, since
// the prompt is a single-line widget and the core caps the task text anyway.
const promptCharLimit = 100_000

// Quitting takes two keystrokes (or /quit) on purpose: this window holds a live session, and a
// stray ctrl+c aimed at cancelling a runaway agent used to take the whole thing down with it.
const quitGrace = 3 * time.Second

// Longer than quitGrace on purpose: this warning is a sentence about losing a plan, not four words,
// and it has to be readable before the second press commits.
const resubmitGrace = 6 * time.Second

// New builds the model. `events` is the already-open SSE channel; `cancel` tears down the stream.
func New(client *api.Client, sess api.SessionInfo, events <-chan api.Event, cancel context.CancelFunc) Model {
	ti := textinput.New()
	ti.Placeholder = "describe the project…"
	ti.Prompt = ""
	ti.Focus()
	// A pasted spec or stack trace is routinely longer than a few thousand characters, and the old
	// 4000 cap silently dropped the tail — the user sent a prompt they never saw. Raised, and
	// onKey reports it when the cap is actually reached.
	ti.CharLimit = promptCharLimit
	m := Model{
		client: client, events: events, cancel: cancel,
		agents: map[string]*agentState{}, input: ti, view: "panes", status: "connected",
		tasks: sess.Tasks, root: sess.Root, lsp: sess.Lsp, mcp: sess.Mcp, mode: "build", costKnown: true, sid: newSessionID(),
		autoCompact: true, thinkingMode: true, // the core's defaults, kept when an older core sends none
	}
	if sess.Settings != nil {
		m.autoCompact, m.thinkingMode = sess.Settings.AutoCompact, sess.Settings.ThinkingMode
	}
	for i, c := range sess.Agents {
		m.order = append(m.order, c.ID)
		m.agents[c.ID] = &agentState{
			cfg: c, status: "idle", color: theme.AgentColor(i), avatar: theme.Avatar(i),
			ctxLimit: sess.ContextLimits[c.ID],
		}
	}
	// Seeded with the local-only commands so "/" suggests something even before the server registry
	// arrives; the commandsMsg handler replaces the list with the full set.
	m.menu.Set(m.menuItems())
	return m
}

func (m Model) Init() tea.Cmd {
	cmds := []tea.Cmd{waitFor(m.events), fetchCommands(m.client)}
	if m.sett.open { // launched as `niti status` / `niti config`: the panels need their data
		cmds = append(cmds, fetchStats(m.client), fetchCreds(m.client))
	}
	return tea.Batch(cmds...)
}

// OpenSettings starts the session with the tabbed overlay already open on the tab a `niti <name>`
// subcommand names. Unknown names leave the session untouched.
// WithVerbose starts the session with tool-call collapsing off (`niti --verbose`); it is the same
// switch as the Config tab's "Collapse tool calls" row.
func (m Model) WithVerbose(on bool) Model {
	m.verbose = on
	for _, st := range m.agents {
		st.verbose = on
	}
	return m
}

func (m Model) OpenSettings(name string) Model {
	if tab, ok := settingsTabFor(name); ok {
		m.sett = settings{open: true, tab: tab}
	}
	return m
}

// The command list lives on the server (src/commands/registry.ts) so the TUI and the web dashboard
// share one implementation. A failure here is not fatal: /quit still works, and the next fetch —
// or the server's own error message on dispatch — will say what's wrong.
func fetchCommands(client *api.Client) tea.Cmd {
	return func() tea.Msg {
		cmds, err := client.Commands()
		if err != nil {
			return errMsg{err}
		}
		return commandsMsg{cmds}
	}
}

// statsMsg carries the all-time usage aggregate the /stats overlay renders. Fetched once when the
// overlay opens (it reads the on-disk session history, which doesn't change mid-frame).
type statsMsg struct {
	stats api.Stats
	err   error
}

func fetchStats(client *api.Client) tea.Cmd {
	return func() tea.Msg {
		s, err := client.Stats()
		return statsMsg{stats: s, err: err}
	}
}

// Coalesced on purpose. Every streamed token arrives as its own event, and one event per Update
// meant one full-frame repaint per token — the whole screen rebuilt, and the garbage that comes
// with it, at whatever rate the model emits. Take one blocking, then drain whatever else is
// already queued and apply the batch in a single Update, so repaints track the terminal rather
// than the token stream.
const maxCoalesced = 64

func waitFor(ch <-chan api.Event) tea.Cmd {
	return func() tea.Msg {
		e, ok := <-ch
		if !ok {
			return errMsg{fmt.Errorf("event stream closed")}
		}
		batch := []api.Event{e}
		for len(batch) < maxCoalesced {
			select {
			case next, ok := <-ch:
				if !ok {
					return eventsMsg(batch) // stream closed; deliver what we have, the next wait reports it
				}
				batch = append(batch, next)
			default:
				return eventsMsg(batch) // nothing else queued right now
			}
		}
		return eventsMsg(batch)
	}
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.input.Width = msg.Width - 4
		return m, nil

	case tea.KeyMsg:
		return m.onKey(msg)

	case tea.MouseMsg:
		// Mouse reporting is on so the wheel can't scroll the shell's scrollback over a live session
		// (see cmd/niti/main.go). Having taken it, the wheel drives whatever list is on screen.
		switch msg.Button {
		case tea.MouseButtonWheelUp:
			m.scroll(-1)
		case tea.MouseButtonWheelDown:
			m.scroll(1)
		}
		return m, nil

	case errMsg:
		m.status = msg.err.Error()
		return m, nil

	case actionResultMsg:
		if msg.err != nil {
			m.status = msg.action + " failed: " + msg.err.Error()
		}
		return m, nil

	case commandsMsg:
		m.commands = msg.commands
		m.menu.Set(m.menuItems())
		return m, nil

	case modelsLoadedMsg:
		m.setCarouselModels(msg)
		return m, nil

	case statsMsg:
		m.sett.statsLoaded = true
		if msg.err != nil {
			m.sett.statsErr = msg.err.Error()
		} else {
			m.sett.stats, m.sett.statsErr = msg.stats, ""
		}
		return m, nil

	case credsMsg:
		m.sett.creds, m.sett.credsLoaded = msg.creds, true
		return m, nil

	case commandResultMsg:
		switch {
		case msg.err != nil:
			m.status = "/" + msg.name + " failed: " + msg.err.Error()
		case msg.result.View != "":
			m.view = msg.result.View // view switches are the client's job; the registry just names them
		default:
			// Not pushed to the feed: that strip is for agent-to-agent traffic, and a multi-row
			// command answer stacked there is what buried it.
			m.show("/"+msg.name, msg.result.Message)
		}
		return m, nil

	case eventMsg:
		m.apply(api.Event(msg))
		return m, waitFor(m.events) // keep listening
	case eventsMsg:
		for _, e := range msg {
			m.apply(e)
		}
		if !m.ticking && m.anyRunning() {
			m.ticking = true
			return m, tea.Batch(waitFor(m.events), tick())
		}
		return m, waitFor(m.events) // one View for the whole batch
	case tickMsg:
		if m.ticking = m.anyRunning(); m.ticking {
			return m, tick()
		}
		return m, nil
	}
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return m, cmd
}

func (m Model) onKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	// ctrl+c is the escape hatch from any popup, so it's handled before them — but it arms first and
	// quits second, and /quit is the deliberate way out.
	if k.String() == "ctrl+c" {
		if !m.quitArm.IsZero() && time.Since(m.quitArm) < quitGrace {
			m.quitting = true
			m.cancel()
			return m, tea.Quit
		}
		m.quitArm = time.Now()
		m.status = "press ctrl+c again to quit — or type /quit"
		return m, nil
	}
	m.quitArm = time.Time{} // any other key disarms: the two presses have to be consecutive
	// Same rule, minus enter itself — enter is handled below and is the key that CONFIRMS the new
	// goal, so disarming on it here would cancel the confirmation before it could ever be given.
	if k.String() != "enter" {
		m.resubmitArm = time.Time{}
	}
	if m.out.open {
		return m, m.outputKey(k)
	}
	if m.sett.open {
		return m, m.settingsKey(k)
	}
	if m.car.open {
		return m, m.carouselKey(k)
	}
	if m.ap.open {
		return m, m.agentPickerKey(k)
	}
	if m.tp.open {
		return m, m.themePickerKey(k)
	}
	// Approval gate takes priority. A diff on the head of the queue gets the full-screen viewer
	// (its own key handler, y/a/n plus scroll/edit/batch-preview); anything else (e.g. a bare shell
	// call) keeps the one-line bar below.
	if len(m.approvals) > 0 {
		if _, ok := approvalDiff(m.approvals[0]); ok {
			return m, m.diffViewKey(k)
		}
		var ok bool
		var scope string
		switch k.String() {
		case "y", "Y":
			ok, scope = true, ""
		case "a", "A":
			ok, scope = true, "agent"
		case "n", "N", "esc":
			ok, scope = false, ""
		default:
			return m, nil
		}
		// Pop the answered request locally right away — the next `approval_request` snapshot from
		// the server won't arrive until the round trip completes, and a stray extra keypress in
		// that window must not re-answer a request that's already been resolved (or answer the
		// wrong, now-shifted, one).
		m.approvals = m.approvals[1:]
		client := m.client
		return m, func() tea.Msg { return actionResultMsg{action: "approval", err: client.Approve(ok, scope, nil)} }
	}

	// While the slash menu is up it owns the arrow keys, tab and enter — the same keys the rest of
	// the view uses, which is why this runs before the general switch below.
	if m.menuOpen && m.menu.Len() > 0 {
		switch k.String() {
		case "up", "shift+tab":
			m.menu.Move(-1)
			return m, nil
		case "down":
			m.menu.Move(1)
			return m, nil
		case "tab": // complete without running, so arguments can be typed after it
			if it, ok := m.menu.Selected(); ok {
				m.input.SetValue(it.Value + " ")
				m.input.CursorEnd()
				m.refreshMenu()
			}
			return m, nil
		case "enter":
			if it, ok := m.menu.Selected(); ok {
				m.input.SetValue("")
				m.menuOpen = false
				return m, m.submit(it.Value)
			}
		case "esc":
			m.input.SetValue("")
			m.refreshMenu()
			return m, nil
		}
	}

	switch k.String() {
	case "tab":
		m.view = map[string]string{"panes": "usage", "usage": "panes"}[m.view]
		return m, nil
	case "ctrl+p":
		return m, m.openCarousel()
	case "ctrl+g":
		return m, m.openAgentPicker()
	case "esc":
		if m.focus != "" {
			m.focus = ""
		}
		return m, nil
	case "alt+1", "alt+2", "alt+3", "alt+4", "alt+5", "alt+6", "alt+7", "alt+8", "alt+9":
		if i := int(k.String()[len(k.String())-1] - '1'); i < len(m.order) {
			id := m.order[i]
			if m.focus == id {
				m.focus = "" // pressing the same agent's key again returns to the overview
			} else {
				m.focus = id
			}
		}
		return m, nil
	case "shift+tab":
		m.mode = map[string]string{"build": "plan", "plan": "build"}[m.mode]
		m.status = m.mode + " mode"
		// Coming back to BUILD with the planned goal still in the prompt: say what enter does now,
		// since the whole point of keeping the text there is that it runs the plan as reviewed.
		if m.mode == "build" && strings.TrimSpace(m.input.Value()) != "" && len(m.tasks) > 0 {
			m.status = "build mode — enter runs the plan on the board"
		}
		return m, nil
	case "ctrl+t":
		m.openThemePicker()
		return m, nil
	case "enter":
		text := strings.TrimSpace(m.input.Value())
		// Every plain message is a BRAND NEW goal to the core: the planner only ever sees the text
		// just typed, never the previous run's. So a follow-up sent while a half-finished plan is
		// still on the board silently throws that plan away and re-plans from a sentence that was
		// never meant to stand on its own — which is exactly how a detailed spec turned into two
		// generic tasks. Hold the first press and say so; /resume continues the real plan instead.
		if text != "" && !strings.HasPrefix(text, "/") && m.status != "running" && m.unfinishedTasks() > 0 {
			if m.resubmitArm.IsZero() || time.Since(m.resubmitArm) > resubmitGrace {
				m.resubmitArm = time.Now()
				m.status = fmt.Sprintf("%d unfinished task(s) on the board — /resume continues them; press enter again to start a new goal instead (abandons the plan)", m.unfinishedTasks())
				return m, nil // input deliberately left intact, nothing submitted
			}
		}
		m.resubmitArm = time.Time{}
		// A goal sent in PLAN mode stays in the prompt: shift+tab then enter is how you run the
		// plan you just read, and the core matches the goal by text to skip a second planning
		// call (see runProject's takeApprovedPlan). Commands and BUILD goals clear as before.
		if !(m.mode == "plan" && text != "" && !strings.HasPrefix(text, "/")) {
			m.input.SetValue("")
		}
		m.refreshMenu()
		return m, m.submit(text)
	}
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(k)
	// Silent truncation is the worst outcome: the user sends a prompt missing its tail and never
	// learns why. Saying so costs one comparison.
	if len(m.input.Value()) >= promptCharLimit {
		m.status = fmt.Sprintf("input reached the %d-character limit — the rest was dropped", promptCharLimit)
	}
	m.refreshMenu()
	return m, cmd
}

// How many tasks on the board haven't finished. Drives the new-goal guard above: a board that is
// entirely done is finished work, and a fresh goal on top of it is exactly what the user means.
func (m Model) unfinishedTasks() int {
	n := 0
	for _, t := range m.tasks {
		if t.Status != "done" {
			n++
		}
	}
	return n
}

// scroll moves whichever list has the screen by one row. Nothing open means nothing to scroll —
// the transcript follows the agents, not the wheel.
func (m *Model) scroll(delta int) {
	switch {
	case m.out.open:
		m.out.top = clamp(m.out.top+delta, 0, m.outputMaxTop())
	case m.car.open:
		m.car.list.Move(delta)
	case m.menuOpen:
		m.menu.Move(delta)
	}
}

// menuItems is every command the user can type: the server registry plus the two that can only be
// handled here (quitting tears down this process; the theme is a property of this terminal).
func (m Model) menuItems() []ui.Item {
	items := make([]ui.Item, 0, len(m.commands)+8)
	seen := map[string]bool{}
	add := func(name, desc string) {
		if seen[name] {
			return
		}
		seen[name] = true
		items = append(items, ui.Item{Label: "/" + name, Value: "/" + name, Desc: desc})
	}
	// /help first: it's the one command someone types before they know any of the others.
	add("help", "List every command in a window")
	for _, c := range m.commands {
		add(c.Name, c.Description)
	}
	add("transcript", "Page through an agent's full output: /transcript [agentId]")
	add("graph", "Open the interactive graph in your browser")
	add("dashboard", "Open the control-center dashboard in your browser")
	add("settings", "Open the settings overlay (Status · Config · Usage · Stats)")
	add("config", "Theme, mode and the team's model assignments")
	add("stats", "Token stats: favorite model and per-model breakdown")
	add("theme", "Open the theme picker (or /theme <name> to switch directly)")
	add("quit", "Leave niti")
	return items
}

// helpLines is /help: every command the menu offers, name-padded into two columns so the window
// reads as a table rather than as wrapped prose.
func (m Model) helpLines() []string {
	items := m.menuItems()
	w := 0
	for _, it := range items {
		w = max(w, len(it.Label))
	}
	lines := make([]string, 0, len(items)+2)
	for _, it := range items {
		lines = append(lines, fmt.Sprintf("%-*s  %s", w, it.Label, it.Desc))
	}
	return append(lines, "",
		"keys — tab: usage · shift+tab: plan mode · ctrl+p: models · ctrl+t: theme")
}

// refreshMenu decides whether the suggestion window is up, and what it's filtered to. It opens on
// a leading "/" and closes as soon as the command name is complete (a space means arguments are
// being typed, and the list has nothing left to offer).
func (m *Model) refreshMenu() {
	text := m.input.Value()
	m.menuOpen = strings.HasPrefix(text, "/") && !strings.Contains(text, " ")
	if !m.menuOpen {
		return
	}
	m.menu.SetQuery(strings.TrimPrefix(text, "/"))
}

func (m *Model) submit(text string) tea.Cmd {
	if text == "" {
		return nil
	}
	// Two commands can't be server-side: quitting tears down this process, and the theme is a
	// property of this terminal that the core has no opinion about.
	switch text {
	case "/quit", "/exit", "/q":
		m.quitting = true
		m.cancel()
		return tea.Quit
	}
	if name, args, _ := strings.Cut(strings.TrimPrefix(text, "/"), " "); strings.HasPrefix(text, "/") && name == "theme" {
		switch {
		case args == "":
			// Bare /theme opens the same swatch picker ctrl+t does — nobody should have to type a
			// theme name from memory. `/theme <name>` (below) stays direct-apply for scripting.
			m.openThemePicker()
		case theme.Use(strings.TrimSpace(args)):
			m.status = "theme: " + theme.Current()
		default:
			m.status = "unknown theme " + args + " — try: " + strings.Join(theme.Names(), " ")
		}
		return nil
	}
	// The settings overlay is a pure client surface (it paints over the whole TUI, like the ctrl+p
	// carousel), so its commands are handled here rather than round-tripped to the server. This
	// supersedes the plain-text /status and /usage the registry still offers — richer, same data.
	if name, args, _ := strings.Cut(strings.TrimPrefix(text, "/"), " "); strings.HasPrefix(text, "/") {
		if tab, ok := settingsTabFor(name); ok {
			m.sett = settings{open: true, tab: tab}
			return tea.Batch(fetchStats(m.client), fetchCreds(m.client)) // load the all-time history the Stats/Usage panels draw
		}
		switch name {
		case "help":
			// Client-side, because only the client knows the whole set: the server registry plus the
			// commands that can only happen here (/quit, /theme, /graph, /dashboard, the settings tabs).
			m.out = output{open: true, title: "COMMANDS", lines: m.helpLines()}
			return nil
		case "model":
			// Bare /model opens the same centred picker ctrl+p does; with arguments it's the scriptable
			// form and goes to the server. Nobody should have to type an agent id from memory.
			if strings.TrimSpace(args) == "" {
				return m.openCarousel()
			}
		}
		if name == "transcript" {
			// The panes show only the tail. This is the read-past-it path: the pager already
			// scrolls, has search-free navigation keys, and is the same widget /help uses.
			id := strings.TrimSpace(args)
			if id == "" && len(m.order) > 0 {
				id = m.order[0]
			}
			st := m.agents[id]
			if st == nil {
				m.status = "unknown agent: " + id + " — try /transcript <agentId>"
				return nil
			}
			lines := append([]string{}, st.log...)
			if st.pending != "" {
				lines = append(lines, st.pending)
			}
			if len(lines) == 0 {
				m.status = id + " hasn't said anything yet"
				return nil
			}
			m.out = output{open: true, title: id + " transcript", lines: lines}
			m.out.top = m.outputMaxTop() // open at the end, where the newest output is
			return nil
		}
		if name == "graph" {
			// The interactive graph lives in the browser — the terminal can't do drag/hover/zoom. Open
			// the core's own /graph/view page, passing the token the same way the web dashboard does.
			target := m.client.BaseURL + "/graph/view?token=" + url.QueryEscape(m.client.Token)
			m.status = "opened the graph in your browser"
			return func() tea.Msg { return actionResultMsg{action: "open graph", err: openBrowser(target)} }
		}
		if name == "dashboard" {
			// Same idea as /graph — the control-center dashboard (tasks/messages/usage, per-agent
			// mid-task messaging) is a browser page, not something the terminal can render itself.
			target := m.client.BaseURL + "/dashboard?token=" + url.QueryEscape(m.client.Token)
			m.status = "opened the dashboard in your browser"
			return func() tea.Msg { return actionResultMsg{action: "open dashboard", err: openBrowser(target)} }
		}
	}
	if strings.HasPrefix(text, "/") {
		name, args, _ := strings.Cut(strings.TrimPrefix(text, "/"), " ")
		if !m.knows(name) {
			m.status = "unknown command: " + text
			return nil
		}
		client := m.client
		return func() tea.Msg {
			res, err := client.RunCommand(name, args)
			return commandResultMsg{name: name, result: res, err: err}
		}
	}
	m.goal = text
	c, mode := m.client, m.mode
	return func() tea.Msg {
		if err := c.Prompt(text, mode); err != nil {
			return errMsg{err}
		}
		return nil
	}
}

func (m *Model) apply(e api.Event) {
	switch e.Kind {
	// Synthesized client-side by streamWithReconnect — the core never sends these. Without them a
	// dead core looked exactly like an idle one: agents "working", progress frozen, status stale.
	case "connection":
		switch e.State {
		case "lost":
			m.disconnected = true
			m.status = "lost the core — reconnecting…"
		case "restored":
			m.disconnected = false
			m.status = "reconnected"
		case "dead":
			m.disconnected = true
			m.status = "the core exited — see .niti/core.log; restart niti"
		}
	case "session":
		if e.State == "started" {
			m.goal = e.Goal
			m.progress = 0
			m.status = "running"
		} else if e.State == "ended" {
			m.progress = 100
			m.status = "done"
		} else if e.State == "cancelled" {
			m.status = "cancelled"
		}
	case "agent_event":
		if ae, ok := e.AsAgentEvent(); ok {
			m.applyAgentEvent(ae)
		}
	case "orchestration":
		if oe, ok := e.AsOrchestration(); ok {
			m.applyOrch(oe)
		}
	case "agent_message":
		if e.Message != nil {
			m.messages = append(m.messages, *e.Message)
			col := theme.MessageColor(e.Message.Kind)
			arrow := lipgloss.NewStyle().Foreground(col).Render(fmt.Sprintf("─%s→", e.Message.Kind))
			m.pushFeed(fmt.Sprintf("%s %s %s  %s", e.Message.From, arrow, e.Message.To, truncate(e.Message.Subject, 40)))
		}
	case "usage":
		if e.Totals != nil {
			m.totals = *e.Totals
		}
		m.cost, m.costKnown = e.Cost, e.CostKnown
		for _, a := range e.Agents {
			if st := m.agents[a.AgentID]; st != nil {
				st.in, st.out, st.calls = a.Usage.InputTokens, a.Usage.OutputTokens, a.Usage.Calls
				st.tokens = a.Usage.InputTokens + a.Usage.OutputTokens
				st.ctxUsed = a.Usage.LastInput
			}
		}
	case "approval_request":
		m.approvals = e.Requests
	}
}

func (m *Model) applyAgentEvent(ae api.AgentEvent) {
	// Not an agent speaking: a file changed outside niti (a human's editor, a git checkout).
	if ae.Type == "external_change" {
		m.pushFeed("⟳ changed outside niti: " + truncate(ae.Payload, 60))
		return
	}
	st := m.agents[ae.AgentID]
	if st == nil {
		return
	}
	switch ae.Type {
	case "delta", "tool_call", "message", "thought":
		if st.status != "done" && st.status != "failed" {
			st.status = "working"
		}
	case "done":
		if st.status == "working" {
			st.status = "idle"
		}
	case "error":
		st.status = "failed"
	}

	if ae.Type != "tool_call" {
		st.toolEnd(false) // whatever was running is done: the agent has moved on
	}

	// `delta` is streamed text — it belongs in the agent's transcript, assembled line by line.
	// Everything else is a discrete event and gets its own labelled line.
	if ae.Type == "delta" {
		st.feedDelta(ae.Payload)
		return
	}
	if ae.Payload == "" {
		return
	}
	line := humanize(ae.Type, ae.Payload)
	if line == "" {
		return
	}
	st.activity = truncate(strings.TrimLeft(line, "⏺⎿▸·✖ "), 46)
	if call, ok := strings.CutPrefix(line, "⏺ "); ok && ae.Type == "tool_call" {
		st.toolStart(call) // shown live, then collapsed — see toolfeed.go
		return
	}
	st.push(line)
	for _, l := range diffLines(ae.Diff) {
		st.push(l)
	}
}

func (m *Model) applyOrch(oe api.OrchestrationEvent) {
	switch oe.Type {
	case "plan":
		m.tasks = m.tasks[:0]
		for _, t := range oe.Tasks {
			m.tasks = append(m.tasks, api.Task{ID: t.ID, Description: t.Description, AssignedTo: t.Role, Status: "pending", DependsOn: t.DependsOn})
		}
	case "task_started":
		m.setTask(oe.TaskID, "in_progress")
		if st := m.agents[oe.Role]; st != nil {
			st.status = "working"
		}
	case "task_done":
		st := "done"
		if !oe.Ok {
			st = "failed"
		}
		m.setTask(oe.TaskID, st)
		if a := m.agents[oe.Role]; a != nil {
			a.status = "idle"
		}
		if oe.Total > 0 {
			m.progress = oe.Completed * 100 / oe.Total
		}
	case "handoff":
		m.pushFeed(fmt.Sprintf("%s hands off %s → %s", oe.From, oe.TaskID, strings.Join(oe.To, ", ")))
	case "review":
		// A review gate that silently rejects work is indistinguishable from a task that just
		// failed — these events carried the reviewer, the task and the verdict all along.
		switch oe.Phase {
		case "requested":
			m.pushFeed(fmt.Sprintf("%s reviews %s", oe.Reviewer, oe.TaskID))
		case "approved":
			m.pushFeed(fmt.Sprintf("%s approved %s", oe.Reviewer, oe.TaskID))
		default:
			m.pushFeed(fmt.Sprintf("%s requested changes on %s", oe.Reviewer, oe.TaskID))
		}
	case "replan":
		line := fmt.Sprintf("orchestrator replans %s: %s", oe.TaskID, oe.Action)
		if oe.Reason != "" {
			line += " — " + truncate(oe.Reason, 40)
		}
		m.pushFeed(line)
	case "integrate":
		m.pushFeed("orchestrator: " + truncate(oe.Summary, 60))
	case "complete":
		// Report what actually finished. Jumping to 100% on a cancelled or half-failed run told the
		// user the work was done when some of it never ran.
		if oe.Total > 0 {
			m.progress = oe.Completed * 100 / oe.Total
		} else {
			m.progress = 100
		}
		if oe.Cancelled {
			m.status = fmt.Sprintf("cancelled — %d/%d tasks done", oe.Completed, oe.Total)
		} else if oe.Completed < oe.Total {
			m.status = fmt.Sprintf("finished with %d of %d tasks done", oe.Completed, oe.Total)
		}
	}
}

// knows reports whether the server offered this command. Before the registry has been fetched we
// let anything through and let the server answer — better than rejecting a valid command because
// the list hasn't arrived yet.
func (m *Model) knows(name string) bool {
	if len(m.commands) == 0 {
		return true
	}
	for _, c := range m.commands {
		if c.Name == name {
			return true
		}
	}
	return false
}

func (m *Model) setTask(id, status string) {
	for i := range m.tasks {
		if m.tasks[i].ID == id {
			m.tasks[i].Status = status
		}
	}
}

func (m *Model) pushFeed(line string) {
	m.feed = append(m.feed, line)
	if len(m.feed) > 200 {
		m.feed = m.feed[len(m.feed)-200:]
	}
}

// n<=0 happens on a very narrow terminal (widths are computed from the terminal size minus fixed
// margins, which can go non-positive). Clamp instead of panicking on a negative slice bound.
// Counts runes, not bytes: the UI is full of multibyte glyphs (avatars, box drawing, ─kind→ edges)
// and a byte-wise cut would both under-fill the line and split a rune into mojibake.
// n is a budget in *display cells*, not runes: a CJK glyph or an emoji occupies two, so counting
// runes handed wide text twice its allowance and overflowed every pane that used this.
func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if n <= 0 {
		return ""
	}
	if lipgloss.Width(s) <= n {
		return s
	}
	if n == 1 {
		return "…"
	}
	return ui.Truncate(s, n-1) + "…"
}
