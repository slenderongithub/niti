package session

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/niti/tui/internal/theme"
)

// agentName is the role, with the lead's star.
func agentName(st *agentState) string {
	if st.cfg.Lead {
		return st.cfg.Role + " ★"
	}
	return st.cfg.Role
}

// The /agents window: the team as the sidebar shows it, plus what the sidebar has no room for —
// the model each teammate runs on, its state, and the tools it is allowed to use.
func (m Model) agentLines() []string {
	bg := theme.BgPane
	cw := clamp(m.width-14, 48, 88)
	roleW, modelW, statusW := 4, 5, 7
	for _, id := range m.order {
		st := m.agents[id]
		roleW = max(roleW, min(lipgloss.Width(agentName(st)), 18))
		modelW = max(modelW, min(lipgloss.Width(st.cfg.Provider+"/"+st.cfg.Model), 34))
	}
	toolW := max(cw-3-1-roleW-modelW-statusW-6, 12)
	sep := txt(theme.Fg, bg).Render("  ")
	row := func(cells ...string) string { return padRight(strings.Join(cells, sep), cw, bg) }
	out := []string{
		row(cell("", theme.Muted, 3, true, bg), cell("ROLE", theme.Muted, roleW, true, bg), cell("MODEL", theme.Muted, modelW, true, bg), cell("STATE", theme.Muted, statusW, true, bg), cell("TOOLS", theme.Muted, toolW, true, bg)),
		row(txt(theme.Line, bg).Render(strings.Repeat("─", cw))),
	}
	for _, id := range m.order {
		st := m.agents[id]
		tools := "all"
		if len(st.cfg.AllowedTools) > 0 {
			tools = strings.Join(st.cfg.AllowedTools, ", ")
		}
		out = append(out, row(cell(st.avatar, st.color, 3, true, bg), cell(agentName(st), st.color, roleW, true, bg), cell(st.cfg.Provider+"/"+st.cfg.Model, theme.Fg, modelW, false, bg),
			cell(st.status, theme.StatusColor(st.status), statusW, false, bg), cell(tools, theme.Muted, toolW, false, bg)))
	}
	return out
}
