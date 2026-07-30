package session

import (
	"fmt"
	"strings"

	"github.com/amux/tui/internal/theme"
	"github.com/charmbracelet/lipgloss"
)

func (m Model) View() string {
	if m.quitting {
		return "bye.\n"
	}
	w := m.width
	if w == 0 {
		w = 100
	}
	var b strings.Builder
	b.WriteString(m.header(w) + "\n")

	switch m.view {
	case "graph":
		b.WriteString(m.graphView(w))
	case "usage":
		b.WriteString(m.usageView(w))
	default:
		b.WriteString(m.panesView(w))
		b.WriteString(m.tasksStrip(w))
	}

	b.WriteString("\n" + m.commFeed(w))

	if len(m.approvals) > 0 {
		b.WriteString("\n" + m.approvalBar(w))
	} else {
		b.WriteString("\n" + lipgloss.NewStyle().Foreground(theme.Green).Render("▸ ") + m.input.View())
	}
	b.WriteString("\n" + m.footer())
	return b.String()
}

func (m Model) header(w int) string {
	brand := lipgloss.NewStyle().Foreground(theme.Violet).Bold(true).Render("● amux")
	goal := m.goal
	if goal == "" {
		goal = "type a task below"
	}
	bar := progressBar(m.progress, 24)
	left := fmt.Sprintf("%s  %s", brand, lipgloss.NewStyle().Foreground(theme.Muted).Render(truncate(goal, w-40)))
	right := fmt.Sprintf("%s %d%%", bar, m.progress)
	gap := w - lipgloss.Width(left) - lipgloss.Width(right)
	if gap < 1 {
		gap = 1
	}
	return left + strings.Repeat(" ", gap) + right
}

func progressBar(pct, width int) string {
	filled := pct * width / 100
	if filled > width {
		filled = width
	}
	full := lipgloss.NewStyle().Foreground(theme.Violet).Render(strings.Repeat("█", filled))
	empty := lipgloss.NewStyle().Foreground(theme.Line).Render(strings.Repeat("░", width-filled))
	return full + empty
}

func (m Model) panesView(w int) string {
	paneW := 34
	perRow := w / (paneW + 2)
	if perRow < 1 {
		perRow = 1
	}
	var boxes []string
	for _, id := range m.order {
		st := m.agents[id]
		boxes = append(boxes, m.pane(st, paneW))
	}
	var rows []string
	for i := 0; i < len(boxes); i += perRow {
		end := i + perRow
		if end > len(boxes) {
			end = len(boxes)
		}
		rows = append(rows, lipgloss.JoinHorizontal(lipgloss.Top, boxes[i:end]...))
	}
	return strings.Join(rows, "\n") + "\n"
}

func (m Model) pane(st *agentState, w int) string {
	title := lipgloss.NewStyle().Foreground(st.color).Bold(true).Render(fmt.Sprintf("%s %s", st.avatar, st.cfg.Role))
	sub := lipgloss.NewStyle().Foreground(theme.Muted).Render(truncate(st.cfg.Provider+"/"+st.cfg.Model, w-2))
	statusDot := lipgloss.NewStyle().Foreground(theme.StatusColor(st.status)).Render("● " + st.status)
	act := st.activity
	if act == "" {
		act = "—"
	}
	body := fmt.Sprintf("%s\n%s\n%s\n%s\n%s tok",
		title, sub, statusDot,
		lipgloss.NewStyle().Foreground(lipgloss.Color("#cfd3e3")).Render(truncate(act, w-2)),
		lipgloss.NewStyle().Foreground(theme.Muted).Render(fmt.Sprintf("%d", st.tokens)),
	)
	border := st.color
	if st.status == "idle" {
		border = theme.Line
	}
	return lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(border).Width(w).Padding(0, 1).Render(body)
}

func (m Model) tasksStrip(w int) string {
	if len(m.tasks) == 0 {
		return ""
	}
	var parts []string
	for _, t := range m.tasks {
		c := theme.StatusColor(t.Status)
		parts = append(parts, lipgloss.NewStyle().Foreground(c).Render(fmt.Sprintf("%s[%s]", t.ID, string([]rune(t.Status)[0]))))
	}
	return lipgloss.NewStyle().Foreground(theme.Muted).Render("tasks: ") + strings.Join(parts, " ") + "\n"
}

// graphView: a legible textual communication graph — orchestrator + agents and the recent edges.
func (m Model) graphView(w int) string {
	var b strings.Builder
	b.WriteString(lipgloss.NewStyle().Foreground(theme.Muted).Render("agents\n"))
	for _, id := range m.order {
		st := m.agents[id]
		lead := ""
		if st.cfg.Lead {
			lead = lipgloss.NewStyle().Foreground(theme.Violet).Render(" ★orchestrator")
		}
		b.WriteString(fmt.Sprintf("  %s %s%s\n",
			lipgloss.NewStyle().Foreground(st.color).Render(st.avatar+" "+id),
			lipgloss.NewStyle().Foreground(theme.StatusColor(st.status)).Render("("+st.status+")"), lead))
	}
	b.WriteString(lipgloss.NewStyle().Foreground(theme.Muted).Render("\nrecent messages\n"))
	start := 0
	if len(m.messages) > 12 {
		start = len(m.messages) - 12
	}
	for _, msg := range m.messages[start:] {
		col := theme.MessageColor(msg.Kind)
		b.WriteString("  " + lipgloss.NewStyle().Foreground(col).Render(fmt.Sprintf("%s ─%s→ %s", msg.From, msg.Kind, msg.To)) +
			"  " + truncate(msg.Subject, w-30) + "\n")
	}
	return b.String()
}

func (m Model) usageView(w int) string {
	var b strings.Builder
	b.WriteString(lipgloss.NewStyle().Foreground(theme.Muted).Render("usage\n"))
	for _, id := range m.order {
		st := m.agents[id]
		b.WriteString(fmt.Sprintf("  %-20s %8d tok\n", id, st.tokens))
	}
	b.WriteString(lipgloss.NewStyle().Foreground(theme.Violet).Render(
		fmt.Sprintf("  %-20s %8d tok · %d calls\n", "TOTAL", m.totals.InputTokens+m.totals.OutputTokens, m.totals.Calls)))
	return b.String()
}

func (m Model) commFeed(w int) string {
	if len(m.feed) == 0 {
		return lipgloss.NewStyle().Foreground(theme.Line).Render(strings.Repeat("─", min(w, 80)))
	}
	start := 0
	if len(m.feed) > 4 {
		start = len(m.feed) - 4
	}
	lines := m.feed[start:]
	return lipgloss.NewStyle().Foreground(theme.Muted).Render(strings.Join(lines, "\n"))
}

func (m Model) approvalBar(w int) string {
	r := m.approvals[0]
	txt := fmt.Sprintf("%s wants to run %s %v", r.AgentID, r.Tool, r.Input)
	return lipgloss.NewStyle().Foreground(theme.Amber).Bold(true).Render("⚠ "+truncate(txt, w-30)) +
		lipgloss.NewStyle().Foreground(theme.Muted).Render("  [y]es  [a]lways  [n]o")
}

func (m Model) footer() string {
	return lipgloss.NewStyle().Foreground(theme.Line).Render(
		fmt.Sprintf("tab: view (%s)  ·  enter: send  ·  /cancel /graph /usage /quit  ·  %s", m.view, m.status))
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
