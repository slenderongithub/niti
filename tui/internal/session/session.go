// Package session renders the live multi-agent view: one pane per agent, a communication feed
// showing agents talking to each other, the task DAG, usage, and the approval prompts.
package session

import (
	"sort"
	"slices"
	"encoding/json"
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
	showDur  bool       // mirrors the showTurnDuration pref: finished tool lines carry how long they took
	runStart time.Time  // when the in-flight tool call began
	running  string     // tool call in flight, e.g. "Run npm test"; see toolfeed.go
	group    *toolGroup // the collapsed line at the tail of log, if any
	pending  string // partial line being streamed by `delta` events, shown live under the log
	runOut   []string   // the in-flight command's latest output lines (tool_output), under its spinner
	todos    []api.Todo // the agent's checklist while steps remain, pinned under its header
	color    lipgloss.Color
	avatar   string
}

// Per-agent scrollback. Only the tail is rendered in the pane, but /transcript pages through all
// of it — at 60 lines an agent's output was genuinely unrecoverable once it scrolled, which for a
// tool whose entire product is agent output is the wrong trade. 600 lines × 6 agents is a few
// hundred KB.
const agentLogMax = 600

func (s *agentState) push(line string) {
	if line = strings.TrimRight(ui.Clean(line), " "); line == "" {
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
	prefs                     map[string]bool // Config-tab flags, mirrored from the core (see prefRows)
	autoApprove               bool            // default permission mode; POST /auto flips it live
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
	car       carousel    // the ctrl+l model switcher, when open
	sett      settings    // the /settings · /status · /config · /usage · /stats overlay, when open
	out       output      // the pager a multi-line command result opens, when open
	diffv     diffview    // full-screen state for the diff-viewing approval (edit/write_file only)
	tp        themePicker // the ctrl+t theme swatch picker, when open
	ap        agentPicker // the ctrl+g "switch agent window" quick-picker, when open
	akp       apiKeyPicker // /api: replace a provider's key, when open
	pal       palette     // the ctrl+p command palette, when open
	view      string      // "panes" | "usage"
	focus     string      // agent id currently maximized in the work pane, or "" for the stacked overview
	// Keyboard focus on the main screen: "" or regionPrompt (typing), regionTranscript (scrolling),
	// regionAgents (picking an agent). Distinct from `focus` above, which is which agent is shown.
	region      string
	agentCursor int // highlighted row in the Agents panel while it has focus
	scrollBack  int  // transcript lines scrolled up from the newest; 0 = following the output
	expanded    bool // ctrl+o: show full command output and whole diffs instead of their folded form
	card        *api.Event // the last run's summary card (turn_summary), shown until the next goal
	suggestions []string   // next prompts the lead suggested; the first is the prompt's ghost text
	notify      string     // a notification to send once this batch of events is applied (notifyCmd)
	steerTo     string     // after "deny & tell": the agent the next message goes to
	history     []string   // sent prompts, oldest first (.niti/history)
	histPos     int        // ↑/↓ browsing: steps back from the newest; 0 = not browsing
	active      bool       // a run is going (session started, not yet ended or cancelled)
	// The Files panel (files.go).
	files       []string                // project files, sorted, from GET /files
	touched     map[string]byte         // what agents did this session: 'M' edited, 'A' created, 'R' read
	changed     map[string]map[int]bool // per file, the line numbers this session added or changed
	openDirs    map[string]bool         // folders the user opened/closed in the tree
	fileCursor  int
	changedOnly bool
	viewer      *fileView // a file open read-only in the main panel
	menuFiles   bool      // the prompt menu is offering files for an @-mention, not commands
	unseen      int // lines that arrived while scrolled up — shown in the transcript's border
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
	quitting    bool
}

// Long enough that pasting a file or a stack trace is not silently clipped; still bounded, since
// the prompt is a single-line widget and the core caps the task text anyway.
const promptCharLimit = 100_000

// Quitting takes two keystrokes (or /quit) on purpose: this window holds a live session, and a
// stray ctrl+c aimed at cancelling a runaway agent used to take the whole thing down with it.
const quitGrace = 3 * time.Second


// New builds the model. `events` is the already-open SSE channel; `cancel` tears down the stream.
func New(client *api.Client, sess api.SessionInfo, events <-chan api.Event, cancel context.CancelFunc) Model {
	ti := textinput.New()
	ti.Placeholder = defaultPlaceholder
	ti.Prompt = ""
	ti.Focus()
	// A pasted spec or stack trace is routinely longer than a few thousand characters, and the old
	// 4000 cap silently dropped the tail — the user sent a prompt they never saw. Raised, and
	// onKey reports it when the cap is actually reached.
	ti.CharLimit = promptCharLimit
	m := Model{
		client: client, events: events, cancel: cancel,
		agents: map[string]*agentState{}, input: ti, view: "panes", status: "connected",
		tasks: sess.Tasks, root: sess.Root, lsp: sess.Lsp, mcp: sess.Mcp, mode: "build", costKnown: true, sid: newSessionID(), prefs: map[string]bool{"projectInstructions": true}, autoApprove: sess.Auto,
		autoCompact: true, thinkingMode: true, // the core's defaults, kept when an older core sends none
	}
	if sess.Settings != nil {
		m.autoCompact, m.thinkingMode = sess.Settings.AutoCompact, sess.Settings.ThinkingMode
	}
	for k, v := range sess.Prefs {
		m.prefs[k] = v
	}
	for i, c := range sess.Agents {
		m.order = append(m.order, c.ID)
		m.agents[c.ID] = &agentState{
			cfg: c, status: "idle", color: theme.AgentColor(i), avatar: theme.Avatar(i),
			ctxLimit: sess.ContextLimits[c.ID], showDur: m.prefs["showTurnDuration"],
		}
	}
	m.history = loadHistory(sess.Root)
	// "Open agents view by default": start on the lead's tab (or the first agent) rather than the
	// stacked overview. Same field ctrl+g / alt+1..9 set, so esc still returns to the overview.
	if m.prefs["openAgentsView"] && len(m.order) > 1 {
		m.focus = m.order[0]
		for _, id := range m.order {
			if m.agents[id].cfg.Lead {
				m.focus = id
				break
			}
		}
	}
	// Seeded with the local-only commands so "/" suggests something even before the server registry
	// arrives; the commandsMsg handler replaces the list with the full set.
	m.menu.Set(m.menuItems())
	return m
}

func (m Model) Init() tea.Cmd {
	cmds := []tea.Cmd{waitFor(m.events), fetchCommands(m.client), fetchFiles(m.client)}
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
	if IsShiftEnter(msg) {
		return m.onKey(tea.KeyMsg{Type: tea.KeyEnter, Alt: true}) // same newline as alt+enter
	}
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

	case filesMsg:
		if msg.err == nil {
			for f := range m.touched { // a file an agent just created may not be in the listing yet
				msg.files = append(msg.files, f)
			}
			sort.Strings(msg.files)
			m.files = slices.Compact(msg.files)
		}
		return m, nil

	case fileLoadedMsg:
		m.onFileLoaded(msg)
		return m, nil

	case editorDoneMsg:
		if msg.err != nil {
			m.status = "editor: " + msg.err.Error()
		}
		return m, m.openFile(msg.path) // show what the edit left

	case steerResultMsg:
		if msg.err != nil {
			m.status = "couldn't reach " + msg.to + ": " + msg.err.Error()
		} else {
			m.status = "→ " + msg.to + " will read that at its next step"
		}
		return m, nil

	case bangResultMsg:
		m.status = ""
		m.out = output{open: true, title: "! " + truncate(msg.cmd, 50), lines: strings.Split(msg.out, "\n")}
		m.out.top = m.outputMaxTop()
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

	case apiCredsMsg:
		if m.akp.open && m.akp.stage == "provider" {
			m.akp.list.Set(m.apiKeyItems(msg.creds))
		}
		return m, nil

	case apiKeySavedMsg:
		m.apiKeySaved(msg)
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
		before := m.transcriptLen()
		for _, e := range msg {
			m.apply(e)
		}
		// Scrolled up: hold the view on what the user is reading and count what arrived below it.
		if m.scrollBack > 0 {
			if grew := m.transcriptLen() - before; grew > 0 {
				m.scrollBack += grew
				m.unseen += grew
			}
		}
		cmds := []tea.Cmd{waitFor(m.events)} // one View for the whole batch
		for _, e := range msg {
			if e.Kind == "session" && e.State != "started" {
				cmds = append(cmds, fetchFiles(m.client)) // a finished run may have added files
				break
			}
		}
		if m.notify != "" {
			cmds = append(cmds, notifyCmd(m.notify))
			m.notify = ""
		}
		if !m.ticking && m.anyRunning() && !m.prefs["reduceMotion"] {
			m.ticking = true
			cmds = append(cmds, tick())
		}
		return m, tea.Batch(cmds...)
	case tickMsg:
		if m.ticking = m.anyRunning() && !m.prefs["reduceMotion"]; m.ticking {
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
	if m.akp.open {
		return m, m.apiKeyKey(k)
	}
	if m.tp.open {
		return m, m.themePickerKey(k)
	}
	if m.pal.open {
		return m, m.paletteKey(k)
	}
	// A diff on the head of the approval queue gets the full-screen viewer (its own keys: y/a/n
	// plus scroll/edit/batch-preview); anything else (e.g. a bare shell call) is answered through
	// the approval bindings in keys.go.
	if len(m.approvals) > 0 {
		if _, ok := approvalDiff(m.approvals[0]); ok {
			return m, m.diffViewKey(k)
		}
	}
	if cmd, ok := m.dispatch(k); ok {
		return m, cmd
	}
	if len(m.approvals) > 0 {
		return m, nil // an unanswered approval swallows everything else
	}
	// Typing while the transcript or the agents panel has focus goes to the prompt — nobody should
	// have to press tab back before they can type the next message.
	if m.context() != regionPrompt {
		if k.Type != tea.KeyRunes {
			return m, nil
		}
		m.region = regionPrompt
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


// scroll moves whichever list has the screen by one row; with nothing open, the wheel scrolls the
// transcript (it used to do nothing, and old output was only reachable through /transcript).
func (m *Model) scroll(delta int) {
	switch {
	case m.out.open:
		m.out.top = clamp(m.out.top+delta, 0, m.outputMaxTop())
	case m.car.open:
		m.car.list.Move(delta)
	case m.pal.open:
		m.pal.list.Move(delta)
		m.preview()
	case m.menuOpen:
		m.menu.Move(delta)
	default:
		m.scrollTranscript(-delta * 3) // wheel up = back in time
	}
}

// scrollTranscript moves the transcript view `delta` lines back in time (negative: forward). Zero
// means following the newest output; any other value holds the view still while output arrives.
func (m *Model) scrollTranscript(delta int) {
	m.scrollBack = clamp(m.scrollBack+delta, 0, m.transcriptLen())
	if m.scrollBack == 0 {
		m.unseen = 0
	}
}

func (m *Model) follow() { m.scrollBack, m.unseen = 0, 0 }

// transcriptLen is the length of the longest log on screen — what scrolling is bounded by.
func (m Model) transcriptLen() int {
	n := 0
	for _, id := range m.order {
		if m.focus != "" && id != m.focus {
			continue
		}
		n = max(n, len(m.agents[id].log))
	}
	return n
}

func (m Model) pageRows() int { return max(m.height/2, 5) }

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
	add("api", "Change a provider's API key — the fix when every call fails on a wrong key")
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
	return append(lines, "", "Keys: press f1 anywhere for the keys that apply there, and ^p to search everything.")
}

// refreshMenu decides whether the suggestion window is up, and what it's filtered to. It opens on
// a leading "/" and closes as soon as the command name is complete (a space means arguments are
// being typed, and the list has nothing left to offer).
func (m *Model) refreshMenu() {
	text := m.input.Value()
	// "@src/ca" — offer project files, fuzzy-matched, to mention in the prompt.
	if q, ok := mentionQuery(text); ok && len(m.files) > 0 && !strings.HasPrefix(text, "/") {
		if !m.menuFiles {
			m.menu.Set(m.fileItems())
			m.menuFiles = true
		}
		m.menuOpen = true
		m.menu.SetQuery(q)
		return
	}
	if m.menuFiles {
		m.menu.Set(m.menuItems())
		m.menuFiles = false
	}
	m.menuOpen = strings.HasPrefix(text, "/") && !strings.Contains(text, " ")
	if !m.menuOpen {
		return
	}
	m.menu.SetQuery(strings.TrimPrefix(text, "/"))
}

// newlineMark stands in for a line break inside the single-line prompt.
const newlineMark = "⏎"

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
		case theme.Pick(strings.TrimSpace(args)):
			m.status = "theme: " + theme.Current()
		default:
			m.status = "unknown theme " + args + " — try: " + strings.Join(theme.Choices(), ", ")
		}
		return nil
	}
	// The settings overlay is a pure client surface (it paints over the whole TUI, like the ctrl+l
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
		case "api":
			return m.openAPIKey()
		case "model":
			// Bare /model opens the same centred picker ctrl+l does; with arguments it's the scriptable
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
			lines := make([]string, 0, len(st.log)+1)
			for _, l := range st.log {
				lines = append(lines, plainLine(l)) // the pager shows text, not the live view's markers
			}
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
	// Picked in the web dashboard (or another TUI) and persisted by the core: follow it, unless the
	// theme picker is open — its live preview is the user's own choice in progress.
	case "turn_summary":
		e := e
		m.card = &e
		m.suggestions = e.Next
		m.refreshPlaceholder()
		if m.prefs["notifyOnDone"] && e.DurationMs >= 20_000 {
			m.notify = "done: " + truncate(m.goal, 60)
		}
	case "theme":
		if !m.tp.open {
			theme.Use(e.Theme)
		}
	// Synthesized client-side by streamWithReconnect — the core never sends these. Without them a
	// dead core looked exactly like an idle one: agents "working", progress frozen, status stale.
	// The core's replay buffer no longer held everything since our last event: say so, rather than
	// let a partial transcript pass for the whole one after a long disconnect.
	case "resync":
		m.status = fmt.Sprintf("reconnected, but %d events were lost while away — output above may be incomplete (/transcript has what's left)", e.Missed)
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
		// A real flag, not the status text: the status line carries every message ("→ Coder: …"),
		// and deciding "is a run going?" by comparing it to "running" broke on the first one.
		m.active = e.State == "started"
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
	// The live view's events (see live.go). Handled first: they carry their own detail, and none of
	// them means "the agent moved on" the way the older events below do.
	switch {
	case ae.Type == "tool_output":
		st.runOut = strings.Split(ae.Payload, "\n")
		return
	case ae.Type == "todo":
		st.onTodo(ae.Todos)
		return
	case ae.Type == "tool_end":
		st.toolEnd(false)
		return
	case ae.Phase == "start" && ae.Tool == "todo":
		return // the checklist itself is the news, not "⏺ Plan …"
	case ae.Phase == "start" && ae.Tool == "read_file":
		var in struct {
			Path string `json:"path"`
		}
		if _, rest, ok := strings.Cut(ae.Payload, " "); ok && json.Unmarshal([]byte(rest), &in) == nil {
			m.markTouched(strings.TrimPrefix(in.Path, "./"), 'R')
		}
	}
	if ae.Type == "file_edit" && ae.Phase == "end" && ae.Path != "" {
		kind := byte('M')
		if ae.Removed == 0 && len(ae.Hunks) > 0 && len(ae.Hunks[0].Lines) > 0 && ae.Hunks[0].Lines[0].O == 0 && ae.Hunks[0].Lines[0].K == "+" {
			kind = 'A'
		}
		m.markTouched(ae.Path, kind)
		m.noteChangedLines(ae)
	}
	if ae.Phase == "end" && ae.Type != "error" && st.onToolEnd(ae) {
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
