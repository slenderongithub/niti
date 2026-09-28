package session

import (
	"fmt"
	"strings"
	"time"

	"github.com/niti/tui/internal/theme"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// One table drives three things: what a key does (onKey dispatches through it), what the footer
// advertises, and what F1 lists. They used to be three hand-written copies — the footer said
// "tab: panes" while tab did something else, and /help omitted half the keys — so a binding now
// exists in exactly one place and the footer can't describe a key that isn't there.
//
// This is the main screen only. Each overlay (pager, settings, pickers, palette, diff viewer) owns
// its keys and prints its own hint line inside its frame.

type binding struct {
	keys   []string // as tea.KeyMsg.String() reports them
	label  string   // how the key is drawn: "^p", "tab", "f1"
	desc   string   // a short verb for the footer
	help   string   // one line for F1
	footer bool     // advertised in the footer; F1 lists everything regardless
	run    func(m *Model) tea.Cmd
}

// Focus regions of the main screen. The prompt is the default; tab walks the others.
const (
	regionPrompt     = "prompt"
	regionTranscript = "transcript"
	regionAgents     = "agents"
)

// context names the binding set in force, in the same priority order onKey checks them.
func (m Model) context() string {
	switch {
	case len(m.approvals) > 0:
		return "approval"
	case m.menuOpen && m.menu.Len() > 0:
		return "menu"
	case m.region == "":
		return regionPrompt
	}
	return m.region
}

var contextTitles = map[string]string{
	"approval":       "Approval",
	"menu":           "Command menu",
	regionPrompt:     "Prompt",
	regionTranscript: "Transcript",
	regionAgents:     "Agents",
}

// keymap is the binding set for the current context: its own keys first, then the global ones.
func (m Model) keymap() []binding {
	var local []binding
	switch m.context() {
	case "approval":
		who := "this agent"
		if len(m.approvals) > 0 {
			who = m.approvals[0].AgentID
		}
		local = []binding{
			{keys: []string{"y", "Y"}, label: "y", desc: "Allow once", help: "run this one call", footer: true, run: answer(true, "")},
			{keys: []string{"a", "A"}, label: "a", desc: "Allow for " + who, help: "run it, and stop asking " + who + " for this tool this session", footer: true, run: answer(true, "agent")},
			{keys: []string{"n", "N", "esc"}, label: "n", desc: "Deny", help: "refuse it; the agent is told and carries on", footer: true, run: answer(false, "")},
			{keys: []string{"t", "T"}, label: "t", desc: "Deny & tell", help: "refuse it and type what " + who + " should do instead", footer: true, run: (*Model).denyAndTell},
		}
		// While a decision is pending nothing else may fire — a stray ctrl+p mid-approval used to
		// open a popup over the question it was supposed to answer.
		return append(local, m.quitBinding())
	case "menu":
		local = []binding{
			{keys: []string{"up", "shift+tab"}, label: "↑↓", desc: "Move", help: "move through the matching commands", footer: true, run: func(m *Model) tea.Cmd { m.menu.Move(-1); return nil }},
			{keys: []string{"down"}, label: "", help: "", run: func(m *Model) tea.Cmd { m.menu.Move(1); return nil }},
			{keys: []string{"tab"}, label: "tab", desc: "Complete", help: "fill in the command without running it, to add arguments", footer: true, run: (*Model).completeMenu},
			{keys: []string{"enter"}, label: "enter", desc: "Run", help: "run the highlighted command", footer: true, run: (*Model).runMenu},
			{keys: []string{"esc"}, label: "esc", desc: "Clear", help: "clear the prompt", footer: true, run: func(m *Model) tea.Cmd { m.input.SetValue(""); m.refreshMenu(); return nil }},
		}
	case regionTranscript:
		local = []binding{
			{keys: []string{"up", "k"}, label: "↑↓", desc: "Scroll", help: "scroll the transcript one line (the mouse wheel works from anywhere)", footer: true, run: func(m *Model) tea.Cmd { m.scrollTranscript(1); return nil }},
			{keys: []string{"down", "j"}, run: func(m *Model) tea.Cmd { m.scrollTranscript(-1); return nil }},
			{keys: []string{"pgup", "ctrl+u"}, label: "pgup", desc: "Page", help: "scroll a page up (pgdn: down)", run: func(m *Model) tea.Cmd { m.scrollTranscript(m.pageRows()); return nil }},
			{keys: []string{"pgdown", "ctrl+d", " "}, run: func(m *Model) tea.Cmd { m.scrollTranscript(-m.pageRows()); return nil }},
			{keys: []string{"g", "home"}, label: "g", desc: "Top", help: "jump to the oldest output", run: func(m *Model) tea.Cmd { m.scrollTranscript(agentLogMax); return nil }},
			{keys: []string{"G", "end"}, label: "G", desc: "Follow", help: "jump to the newest output and keep following it", footer: true, run: func(m *Model) tea.Cmd { m.follow(); return nil }},
			{keys: []string{"esc"}, label: "esc", desc: "Prompt", help: "back to the prompt", footer: true, run: func(m *Model) tea.Cmd { m.region = regionPrompt; return nil }},
		}
	case regionAgents:
		local = []binding{
			{keys: []string{"up", "k"}, label: "↑↓", desc: "Move", help: "move between agents", footer: true, run: func(m *Model) tea.Cmd { m.agentCursor = wrap(m.agentCursor-1, len(m.order)); return nil }},
			{keys: []string{"down", "j"}, run: func(m *Model) tea.Cmd { m.agentCursor = wrap(m.agentCursor+1, len(m.order)); return nil }},
			{keys: []string{"enter"}, label: "enter", desc: "Open", help: "show only this agent's transcript (enter again: all agents)", footer: true, run: (*Model).openAgentAtCursor},
			{keys: []string{"esc"}, label: "esc", desc: "Prompt", help: "back to the prompt", footer: true, run: func(m *Model) tea.Cmd { m.region = regionPrompt; return nil }},
		}
	default: // the prompt
		other := "Plan mode"
		if m.mode == "plan" {
			other = "Build mode"
		}
		local = []binding{}
		if len(m.suggestions) > 0 && m.input.Value() == "" {
			local = append(local, binding{keys: []string{"tab"}, label: "tab", desc: "Use suggestion", help: "put the suggested next prompt in the prompt (edit it, or enter to send)", footer: true, run: (*Model).acceptSuggestion})
		}
		if m.running() {
			local = append(local, binding{keys: []string{"esc"}, label: "esc", desc: "Interrupt", help: "stop the run — agents finish the step they're on", footer: true, run: (*Model).interrupt})
		}
		if len(m.history) > 0 && (m.input.Value() == "" || m.histPos > 0) {
			local = append(local,
				binding{keys: []string{"up"}, label: "↑↓", desc: "History", help: "earlier prompts (↓ back toward the newest)", run: func(m *Model) tea.Cmd { return m.historyStep(1) }},
				binding{keys: []string{"down"}, run: func(m *Model) tea.Cmd { return m.historyStep(-1) }})
		}
		local = append(local, []binding{
			{keys: []string{"enter"}, label: "enter", desc: "Send", help: "send the prompt: a goal, a question, a /command, or !cmd to run a command here; mid-run it steers the working agent", run: (*Model).enter},
			{keys: []string{"shift+tab"}, label: "⇧tab", desc: other, help: "switch between BUILD (agents act) and PLAN (the lead only plans)", footer: true, run: (*Model).toggleMode},
			{keys: []string{"alt+enter", "shift+enter", "ctrl+j"}, label: "alt+enter", desc: "Newline", help: "a line break inside the prompt (also shift+enter, ^j)", run: (*Model).newline},
			{keys: []string{"esc"}, label: "esc", desc: "All agents", help: "leave a single agent's view for the stacked overview", run: func(m *Model) tea.Cmd { m.focus = ""; return nil }},
		}...)
	}
	return append(local, m.globalBindings()...)
}

func (m Model) globalBindings() []binding {
	g := []binding{
		{keys: []string{"ctrl+p"}, label: "^p", desc: "Commands", help: "command palette: every command, theme, view and agent, fuzzy-searchable", footer: true, run: (*Model).openPalette},
		{keys: []string{"tab"}, label: "tab", desc: "Focus", help: "move focus: prompt → transcript → agents", footer: true, run: (*Model).cycleFocus},
		{keys: []string{"ctrl+l"}, label: "^l", desc: "Models", help: "switch an agent's model", footer: true, run: (*Model).openCarousel},
		{keys: []string{"ctrl+g"}, label: "^g", desc: "Agents", help: "jump to one agent's view (alt+1…9 directly)", run: (*Model).openAgentPicker},
		{keys: []string{"alt+1", "alt+2", "alt+3", "alt+4", "alt+5", "alt+6", "alt+7", "alt+8", "alt+9"}, label: "alt+1…9", desc: "Agent N", help: "show only agent N (same key again: all agents)", run: nil},
		{keys: []string{"ctrl+o"}, label: "^o", desc: "Expand", help: "show full command output and whole diffs (again: fold them)", footer: m.hasFolded(), run: func(m *Model) tea.Cmd { m.expanded = !m.expanded; return nil }},
		{keys: []string{"ctrl+t"}, label: "^t", desc: "Theme", help: "pick a theme, with live preview", run: func(m *Model) tea.Cmd { m.openThemePicker(); return nil }},
		{keys: []string{"f1"}, label: "f1", desc: "Help", help: "this list: keys for what's focused, and what the glyphs mean", footer: true, run: (*Model).openHelp},
		m.quitBinding(),
	}
	return g
}

// hasFolded reports whether ctrl+o would change anything on screen, so the footer only offers it then.
func (m Model) hasFolded() bool {
	if m.expanded {
		return true
	}
	for _, st := range m.agents {
		for _, l := range st.log {
			if firstRune(l) == mkMore {
				return true
			}
		}
	}
	return false
}

func (m Model) quitBinding() binding {
	// Dispatched ahead of every overlay in onKey (it must work from anywhere), so no run here.
	return binding{keys: []string{"ctrl+c"}, label: "^c", desc: "Quit", help: "quit (press twice — or type /quit)", footer: true}
}

// dispatch runs the binding for k in the current context. ok=false means no binding claimed it.
func (m *Model) dispatch(k tea.KeyMsg) (tea.Cmd, bool) {
	key := k.String()
	for _, b := range m.keymap() {
		for _, bk := range b.keys {
			if bk != key {
				continue
			}
			if b.run == nil { // alt+N carries its digit in the key itself
				if strings.HasPrefix(key, "alt+") {
					m.focusAgentN(int(key[len(key)-1] - '1'))
					return nil, true
				}
				return nil, false
			}
			return b.run(m), true
		}
	}
	return nil, false
}

// footerLine draws the advertised bindings — key in the accent, description in the text color,
// on the bare canvas (posting's transparent footer) — dropping entries from the right to fit.
func (m Model) footerLine(w int) string {
	bg := theme.BgDeep
	key := lipgloss.NewStyle().Foreground(theme.Accent).Background(bg).Bold(true)
	desc := lipgloss.NewStyle().Foreground(theme.Fg).Background(bg)
	gap := lipgloss.NewStyle().Background(bg)
	out, used := gap.Render(" "), 1
	for _, b := range m.keymap() {
		if !b.footer {
			continue
		}
		seg := key.Render(b.label) + desc.Render(" "+b.desc) + gap.Render("  ")
		sw := lipgloss.Width(seg)
		if used+sw > w {
			break
		}
		out += seg
		used += sw
	}
	return lipgloss.NewStyle().Width(w).MaxWidth(w).Background(bg).Render(out)
}

// helpDoc is F1: the focused context's keys, then the global ones, then what every glyph in the
// transcript means — the one place niti's symbols are explained.
func (m Model) helpDoc() (string, []string) {
	title := "Help — " + contextTitles[m.context()]
	var lines []string
	row := func(b binding) {
		if b.help == "" {
			return
		}
		lines = append(lines, fmt.Sprintf("  %-11s %s", b.label, b.help))
	}
	global := map[string]bool{}
	for _, b := range m.globalBindings() {
		global[b.label] = true
	}
	lines = append(lines, "Keys here")
	for _, b := range m.keymap() {
		if !global[b.label] {
			row(b)
		}
	}
	lines = append(lines, "", "Everywhere")
	for _, b := range m.globalBindings() {
		row(b)
	}
	lines = append(lines, "",
		"What the transcript glyphs mean",
		"  ⏺  an action an agent took        ⎿  its result",
		"  ✔  a finished run of tool calls    ✖  a failure",
		"  ⚠  a warning                        ▸  a task or plan step",
		"  ·  an agent's thinking aloud        ⠋  still working",
		"  ●  done   ◐  in progress   ○  waiting   ★  lead agent",
		"",
		"Type / for commands, or press ^p to search them.")
	return title, lines
}

func (m *Model) openHelp() tea.Cmd {
	title, lines := m.helpDoc()
	m.out = output{open: true, title: title, lines: lines}
	return nil
}

// --- actions the table points at ---

func answer(ok bool, scope string) func(m *Model) tea.Cmd {
	return func(m *Model) tea.Cmd {
		// Pop the answered request locally right away — the next `approval_request` snapshot won't
		// arrive until the round trip completes, and a stray extra keypress in that window must not
		// re-answer a request that's already resolved (or answer the wrong, now-shifted, one).
		m.approvals = m.approvals[1:]
		client := m.client
		return func() tea.Msg { return actionResultMsg{action: "approval", err: client.Approve(ok, scope, nil)} }
	}
}

func (m *Model) completeMenu() tea.Cmd {
	if it, ok := m.menu.Selected(); ok {
		m.input.SetValue(it.Value + " ")
		m.input.CursorEnd()
		m.refreshMenu()
	}
	return nil
}

func (m *Model) runMenu() tea.Cmd {
	if it, ok := m.menu.Selected(); ok {
		m.input.SetValue("")
		m.menuOpen = false
		return m.submit(it.Value)
	}
	return nil
}

func (m *Model) cycleFocus() tea.Cmd {
	next := map[string]string{regionPrompt: regionTranscript, regionTranscript: regionAgents, regionAgents: regionPrompt}
	r := m.context()
	if r != regionPrompt && r != regionTranscript && r != regionAgents {
		r = regionPrompt
	}
	m.region = next[r]
	if m.region == regionAgents && (len(m.order) == 0 || !m.sidebarShown()) {
		m.region = regionPrompt // no Agents panel on screen to focus
	}
	return nil
}

func (m *Model) toggleMode() tea.Cmd {
	m.mode = map[string]string{"build": "plan", "plan": "build"}[m.mode]
	m.status = m.mode + " mode"
	// Coming back to BUILD with the planned goal still in the prompt: say what enter does now,
	// since the whole point of keeping the text there is that it runs the plan as reviewed.
	if m.mode == "build" && strings.TrimSpace(m.input.Value()) != "" && len(m.tasks) > 0 {
		m.status = "build mode — enter runs the plan on the board"
	}
	return nil
}

func (m *Model) newline() tea.Cmd {
	// The prompt is a single-line textinput, which strips real newlines, so the break is held as a
	// visible ⏎ and turned back into "\n" on send.
	m.input, _ = m.input.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(newlineMark)})
	m.refreshMenu()
	return nil
}

func (m *Model) enter() tea.Cmd {
	text := strings.TrimSpace(strings.ReplaceAll(m.input.Value(), newlineMark, "\n"))
	if text != "" {
		m.remember(text)
	}
	// !cmd runs a command here, on the user's own authority, and shows its output.
	if cmd, ok := strings.CutPrefix(text, "!"); ok {
		m.input.SetValue("")
		return m.bang(cmd)
	}
	// After "deny & tell": this message is the what-to-do-instead, for that agent.
	if m.steerTo != "" && text != "" && !strings.HasPrefix(text, "/") {
		to := m.steerTo
		m.steerTo = ""
		m.input.SetValue("")
		return m.steer(to, text)
	}
	// Mid-run, a message steers the agent that's working instead of replacing the whole plan.
	if m.running() && text != "" && !strings.HasPrefix(text, "/") {
		m.input.SetValue("")
		return m.steer(m.steerTarget(), text)
	}
	// Every plain message is a BRAND NEW goal to the core: the planner only ever sees the text just
	// typed, never the previous run's. So a follow-up sent while a half-finished plan is still on
	// the board silently throws that plan away and re-plans from a sentence that was never meant to
	// stand on its own. Hold the first press and say so; /resume continues the real plan instead.
	if text != "" && !strings.HasPrefix(text, "/") && !m.running() && m.unfinishedTasks() > 0 {
		if m.resubmitArm.IsZero() || time.Since(m.resubmitArm) > resubmitGrace {
			m.resubmitArm = time.Now()
			m.status = fmt.Sprintf("%d unfinished task(s) — /resume continues them; enter again starts a new goal and drops the plan", m.unfinishedTasks())
			return nil // input deliberately left intact, nothing submitted
		}
	}
	m.resubmitArm = time.Time{}
	// A goal sent in PLAN mode stays in the prompt: shift+tab then enter is how you run the plan you
	// just read, and the core matches the goal by text to skip a second planning call (see
	// runProject's takeApprovedPlan). Commands and BUILD goals clear as before.
	if !(m.mode == "plan" && text != "" && !strings.HasPrefix(text, "/")) {
		m.input.SetValue("")
	}
	m.refreshMenu()
	m.follow() // a new goal means new output; stop holding an old scroll position
	if text != "" && !strings.HasPrefix(text, "/") {
		m.clearTurn() // a new goal is a new turn: last run's card and suggestions go
	}
	return m.submit(text)
}

func (m *Model) focusAgentN(i int) {
	if i < 0 || i >= len(m.order) {
		return
	}
	if id := m.order[i]; m.focus == id {
		m.focus = "" // the same agent's key again returns to the overview
	} else {
		m.focus = id
	}
}

func (m *Model) openAgentAtCursor() tea.Cmd {
	if len(m.order) == 0 {
		return nil
	}
	m.focusAgentN(clamp(m.agentCursor, 0, len(m.order)-1))
	return nil
}

func wrap(i, n int) int {
	if n <= 0 {
		return 0
	}
	return (i%n + n) % n
}
