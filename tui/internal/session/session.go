// Package session renders the live multi-agent view: one pane per agent, a communication feed
// showing agents talking to each other, the task DAG, usage, and the approval prompts.
package session

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/amux/tui/internal/api"
	"github.com/amux/tui/internal/theme"
	"github.com/amux/tui/internal/ui"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type eventMsg api.Event
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
	pending  string // partial line being streamed by `delta` events, shown live under the log
	color    lipgloss.Color
	avatar   string
}

const agentLogMax = 60 // per-agent scrollback; only the tail is ever rendered

func (s *agentState) push(line string) {
	if line = strings.TrimRight(line, " \t\r"); line == "" {
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
		s.push(s.pending[:i])
		s.pending = s.pending[i+1:]
	}
	if len(s.pending) > maxPendingLine {
		s.push(s.pending)
		s.pending = ""
	}
}

type Model struct {
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
	car       carousel // the ctrl+p model switcher, when open
	sett      settings // the /settings · /status · /config · /usage · /stats overlay, when open
	view      string   // "panes" | "usage"
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
	quitting  bool
}

// New builds the model. `events` is the already-open SSE channel; `cancel` tears down the stream.
func New(client *api.Client, sess api.SessionInfo, events <-chan api.Event, cancel context.CancelFunc) Model {
	ti := textinput.New()
	ti.Placeholder = "describe the project…"
	ti.Prompt = ""
	ti.Focus()
	ti.CharLimit = 4000
	m := Model{
		client: client, events: events, cancel: cancel,
		agents: map[string]*agentState{}, input: ti, view: "panes", status: "connected",
		tasks: sess.Tasks, root: sess.Root, lsp: sess.Lsp, mcp: sess.Mcp, mode: "build", costKnown: true,
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

func (m Model) Init() tea.Cmd { return tea.Batch(waitFor(m.events), fetchCommands(m.client)) }

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

func waitFor(ch <-chan api.Event) tea.Cmd {
	return func() tea.Msg {
		e, ok := <-ch
		if !ok {
			return errMsg{fmt.Errorf("event stream closed")}
		}
		return eventMsg(e)
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

	case commandResultMsg:
		switch {
		case msg.err != nil:
			m.status = "/" + msg.name + " failed: " + msg.err.Error()
		case msg.result.View != "":
			m.view = msg.result.View // view switches are the client's job; the registry just names them
		default:
			m.status = msg.result.Message
		}
		if msg.result.Message != "" && msg.result.View == "" {
			m.pushFeed("/" + msg.name + ": " + msg.result.Message)
		}
		return m, nil

	case eventMsg:
		m.apply(api.Event(msg))
		return m, waitFor(m.events) // keep listening
	}
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return m, cmd
}

func (m Model) onKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	// ctrl+c always quits; the popup below swallows everything else, so it can't be the only way out.
	if s := k.String(); s == "ctrl+c" || s == "ctrl+d" {
		m.quitting = true
		m.cancel()
		return m, tea.Quit
	}
	if m.sett.open {
		return m, m.settingsKey(k)
	}
	if m.car.open {
		return m, m.carouselKey(k)
	}
	// Approval gate takes priority.
	if len(m.approvals) > 0 {
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
		return m, func() tea.Msg { return actionResultMsg{action: "approval", err: client.Approve(ok, scope)} }
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
	case "shift+tab":
		m.mode = map[string]string{"build": "plan", "plan": "build"}[m.mode]
		m.status = m.mode + " mode"
		return m, nil
	case "ctrl+t":
		m.status = "theme: " + theme.Next()
		return m, nil
	case "enter":
		text := strings.TrimSpace(m.input.Value())
		m.input.SetValue("")
		m.refreshMenu()
		return m, m.submit(text)
	}
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(k)
	m.refreshMenu()
	return m, cmd
}

// menuItems is every command the user can type: the server registry plus the two that can only be
// handled here (quitting tears down this process; the theme is a property of this terminal).
func (m Model) menuItems() []ui.Item {
	items := make([]ui.Item, 0, len(m.commands)+2)
	for _, c := range m.commands {
		items = append(items, ui.Item{Label: "/" + c.Name, Value: "/" + c.Name, Desc: c.Description})
	}
	return append(items,
		ui.Item{Label: "/graph", Value: "/graph", Desc: "Open the interactive graph in your browser"},
		ui.Item{Label: "/settings", Value: "/settings", Desc: "Open the settings overlay (Status · Config · Usage · Stats)"},
		ui.Item{Label: "/config", Value: "/config", Desc: "Theme, mode and the team's model assignments"},
		ui.Item{Label: "/stats", Value: "/stats", Desc: "Token stats: favorite model and per-model breakdown"},
		ui.Item{Label: "/theme", Value: "/theme", Desc: "Switch the TUI theme: /theme <name>"},
		ui.Item{Label: "/quit", Value: "/quit", Desc: "Leave amux"})
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
			m.status = "themes: " + strings.Join(theme.Names(), " ") + "  (now: " + theme.Current() + ")"
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
	if name, _, _ := strings.Cut(strings.TrimPrefix(text, "/"), " "); strings.HasPrefix(text, "/") {
		if tab, ok := settingsTabFor(name); ok {
			m.sett = settings{open: true, tab: tab}
			return fetchStats(m.client) // load the all-time history the Stats/Usage panels draw
		}
		if name == "graph" {
			// The interactive graph lives in the browser — the terminal can't do drag/hover/zoom. Open
			// the core's own /graph/view page, passing the token the same way the web dashboard does.
			target := m.client.BaseURL + "/graph/view?token=" + url.QueryEscape(m.client.Token)
			m.status = "opened the graph in your browser"
			return func() tea.Msg { return actionResultMsg{action: "open graph", err: openBrowser(target)} }
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
	// Not an agent speaking: a file changed outside amux (a human's editor, a git checkout).
	if ae.Type == "external_change" {
		m.pushFeed("⟳ changed outside amux: " + truncate(ae.Payload, 60))
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

	// `delta` is streamed text — it belongs in the agent's transcript, assembled line by line.
	// Everything else is a discrete event and gets its own labelled line.
	if ae.Type == "delta" {
		st.feedDelta(ae.Payload)
		return
	}
	if ae.Payload == "" {
		return
	}
	st.activity = truncate(ae.Payload, 46)
	st.push(eventPrefix(ae.Type) + strings.ReplaceAll(ae.Payload, "\n", " "))
}

// A one-glyph prefix so a transcript line's kind is readable without color (and survives being
// copied out of the terminal).
func eventPrefix(kind string) string {
	switch kind {
	case "tool_call":
		return "⚒ "
	case "file_edit":
		return "✎ "
	case "thought":
		return "· "
	case "error":
		return "✖ "
	case "failover":
		return "⇄ "
	case "warning":
		return "⚠ "
	default:
		return "  "
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
	case "integrate":
		m.pushFeed("orchestrator: " + truncate(oe.Summary, 60))
	case "complete":
		m.progress = 100
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
func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if n <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	if n == 1 {
		return "…"
	}
	return string(r[:n-1]) + "…"
}
