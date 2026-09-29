package session

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/niti/tui/internal/theme"
)

// The /tasks window. The server's text answer was one flat colour with the status carried only by
// a glyph, so a board of ten tasks read as a wall of grey. This draws the board the TUI already
// holds as a table: status spelled out and coloured, the agent in its own colour, the description
// wrapped instead of cut off, and dependencies under the task that waits on them. It is rebuilt on
// every frame (see outLines), so it updates while it is open.

var taskWord = map[string]string{"done": "done", "in_progress": "running", "failed": "failed", "pending": "pending"}
var taskGlyph = map[string]string{"done": "●", "in_progress": "◐", "failed": "✖", "pending": "○"}

// agentNamed finds the teammate a task is assigned to. The planner assigns by role, the session
// snapshot by agent id — accept either.
func (m Model) agentNamed(name string) *agentState {
	if st := m.agents[name]; st != nil {
		return st
	}
	for _, id := range m.order {
		if st := m.agents[id]; strings.EqualFold(st.cfg.Role, name) {
			return st
		}
	}
	return nil
}

// taskSummary is "3/7 done · 1 running · 1 failed" — zero counts left out.
func taskSummary(counts map[string]int, total int) string {
	parts := []string{fmt.Sprintf("%d/%d done", counts["done"], total)}
	for _, s := range []string{"in_progress", "failed", "pending"} {
		if counts[s] > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", counts[s], taskWord[s]))
		}
	}
	return strings.Join(parts, " · ")
}

func (m Model) taskLines() []string {
	bg := theme.BgPane
	cw := clamp(m.width-14, 48, 88)
	const statusW = 9 // "○ pending"
	idW, agentW := 2, 5
	counts := map[string]int{}
	for _, t := range m.tasks {
		counts[t.Status]++
		idW = max(idW, lipgloss.Width(t.ID))
		agentW = max(agentW, min(lipgloss.Width(t.AssignedTo), 14))
	}
	descW := max(cw-statusW-idW-agentW-6, 16)

	line := func(parts ...string) string {
		return padRight(strings.Join(parts, txt(theme.Fg, bg).Render("  ")), cw, bg)
	}
	cell := func(s string, fg lipgloss.Color, w int, bold bool) string {
		return padRight(txt(fg, bg).Bold(bold).Render(truncate(s, w)), w, bg)
	}
	blank := cell("", theme.Fg, 0, false)
	out := []string{
		line(txt(theme.Fg, bg).Bold(true).Render(taskSummary(counts, len(m.tasks)))),
		line(cell("STATUS", theme.Muted, statusW, true), cell("ID", theme.Muted, idW, true), cell("AGENT", theme.Muted, agentW, true), cell("TASK", theme.Muted, descW, true)),
		line(txt(theme.Line, bg).Render(strings.Repeat("─", cw))),
	}
	for _, t := range m.tasks {
		word, ok := taskWord[t.Status]
		if !ok {
			word = t.Status
		}
		glyph := taskGlyph[t.Status]
		if glyph == "" {
			glyph = "○"
		}
		agentFg := theme.Fg
		who := t.AssignedTo
		if st := m.agentNamed(t.AssignedTo); st != nil {
			agentFg, who = st.color, st.cfg.Role
		}
		if who == "" {
			who = "—"
		}
		desc := strings.Split(ansi.Wrap(strings.Join(strings.Fields(t.Description), " "), descW, ""), "\n")
		if len(t.DependsOn) > 0 {
			desc = append(desc, "\x00after "+strings.Join(t.DependsOn, ", "))
		}
		for i, d := range desc {
			if i > 0 {
				out = append(out, line(cell("", theme.Fg, statusW, false), cell("", theme.Fg, idW, false), cell("", theme.Fg, agentW, false), descCell(d, descW, bg)))
				continue
			}
			out = append(out, line(cell(glyph+" "+word, theme.StatusColor(t.Status), statusW, t.Status == "in_progress"), cell(t.ID, theme.Muted, idW, false), cell(who, agentFg, agentW, false), descCell(d, descW, bg)))
		}
	}
	return append(out, blank)
}

// descCell draws a description row; a "\x00"-prefixed row is the dependency note, set in the muted colour.
func descCell(d string, w int, bg lipgloss.Color) string {
	if rest, ok := strings.CutPrefix(d, "\x00"); ok {
		return padRight(txt(theme.Muted, bg).Italic(true).Render(truncate("↳ "+rest, w)), w, bg)
	}
	return padRight(txt(theme.Fg, bg).Render(truncate(d, w)), w, bg)
}
