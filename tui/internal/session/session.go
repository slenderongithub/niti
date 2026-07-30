// Package session renders the live multi-agent view: one pane per agent, a communication feed
// showing agents talking to each other, the task DAG, usage, and the approval prompts.
package session

import (
	"context"
	"fmt"
	"strings"

	"github.com/amux/tui/internal/api"
	"github.com/amux/tui/internal/theme"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type eventMsg api.Event
type errMsg struct{ err error }

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
	color    lipgloss.Color
	avatar   string
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
	view      string // "panes" | "graph" | "usage"
	totals    api.Totals
	width     int
	height    int
	status    string
	quitting  bool
}

// New builds the model. `events` is the already-open SSE channel; `cancel` tears down the stream.
func New(client *api.Client, sess api.SessionInfo, events <-chan api.Event, cancel context.CancelFunc) Model {
	ti := textinput.New()
	ti.Placeholder = "describe the project… (/model, /graph, /usage, /cancel, /quit)"
	ti.Focus()
	ti.CharLimit = 4000
	m := Model{
		client: client, events: events, cancel: cancel,
		agents: map[string]*agentState{}, input: ti, view: "panes", status: "connected",
		tasks: sess.Tasks,
	}
	for i, c := range sess.Agents {
		m.order = append(m.order, c.ID)
		m.agents[c.ID] = &agentState{cfg: c, status: "idle", color: theme.AgentColor(i), avatar: theme.Avatar(i)}
	}
	return m
}

func (m Model) Init() tea.Cmd { return waitFor(m.events) }

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

	case eventMsg:
		m.apply(api.Event(msg))
		return m, waitFor(m.events) // keep listening
	}
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return m, cmd
}

func (m Model) onKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
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

	switch k.String() {
	case "ctrl+c", "ctrl+d":
		m.quitting = true
		m.cancel()
		return m, tea.Quit
	case "tab":
		m.view = map[string]string{"panes": "graph", "graph": "usage", "usage": "panes"}[m.view]
		return m, nil
	case "enter":
		text := strings.TrimSpace(m.input.Value())
		m.input.SetValue("")
		return m, m.submit(text)
	}
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(k)
	return m, cmd
}

func (m *Model) submit(text string) tea.Cmd {
	if text == "" {
		return nil
	}
	switch text {
	case "/quit", "/exit", "/q":
		m.quitting = true
		m.cancel()
		return tea.Quit
	case "/graph":
		m.view = "graph"
		return nil
	case "/usage":
		m.view = "usage"
		return nil
	case "/panes":
		m.view = "panes"
		return nil
	case "/cancel":
		client := m.client
		return func() tea.Msg { return actionResultMsg{action: "cancel", err: client.Cancel()} }
	}
	if strings.HasPrefix(text, "/") {
		m.status = "unknown command: " + text
		return nil
	}
	m.goal = text
	c := m.client
	return func() tea.Msg {
		if err := c.Prompt(text); err != nil {
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
		for _, a := range e.Agents {
			if st := m.agents[a.AgentID]; st != nil {
				st.tokens = a.Usage.InputTokens + a.Usage.OutputTokens
			}
		}
	case "approval_request":
		m.approvals = e.Requests
	}
}

func (m *Model) applyAgentEvent(ae api.AgentEvent) {
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
	if ae.Payload != "" && ae.Type != "delta" {
		st.activity = truncate(ae.Payload, 46)
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

// n<=0 happens on a very narrow terminal (header()/approvalBar()/graphView() compute widths from
// the terminal size minus a fixed margin, which can go non-positive). Clamp instead of panicking
// on s[:n-1].
func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if n <= 0 {
		return ""
	}
	if len(s) <= n {
		return s
	}
	if n == 1 {
		return "…"
	}
	return s[:n-1] + "…"
}
