package session

import (
	"github.com/niti/tui/internal/theme"
	"github.com/niti/tui/internal/ui"
	tea "github.com/charmbracelet/bubbletea"
)

// The agent picker is the ctrl+g "switch window" quick-picker: a popup listing every teammate (plus
// an "overview" entry), so a maximized single-agent view is reachable without memorizing its
// alt+N slot. Mirrors carousel.go's shape — open/list/Key/View — one stage instead of two, since
// there's nothing to pick after the agent.

const overviewValue = "" // m.focus == "" is the stacked overview; the picker's leading row selects it

type agentPicker struct {
	open bool
	list ui.List
}

// openAgentPicker builds the list fresh each time (roster/status can have changed since it was last
// open) — cheap enough that caching isn't worth the staleness risk.
func (m *Model) openAgentPicker() tea.Cmd {
	items := make([]ui.Item, 0, len(m.order)+1)
	items = append(items, ui.Item{Label: "≡ overview", Value: overviewValue, Desc: "all agents, stacked"})
	for _, id := range m.order {
		st := m.agents[id]
		items = append(items, ui.Item{Label: st.cfg.Role, Value: id, Desc: st.status, Tag: st.avatar})
	}
	m.ap = agentPicker{open: true}
	m.ap.list.Set(items)
	return nil
}

func (m *Model) agentPickerKey(k tea.KeyMsg) tea.Cmd {
	switch k.String() {
	case "esc", "ctrl+g":
		m.ap = agentPicker{}
		return nil
	case "up", "shift+tab":
		m.ap.list.Move(-1)
		return nil
	case "down", "tab":
		m.ap.list.Move(1)
		return nil
	case "enter":
		if sel, ok := m.ap.list.Selected(); ok {
			m.focus = sel.Value
		}
		m.ap = agentPicker{}
		return nil
	}
	return nil
}

func (m Model) agentPickerView(w, h int) string {
	rows := m.ap.list.Rows(clamp(h-8, 3, 12))
	boxW := clamp(m.ap.list.NaturalWidth()+6, 30, max(w-6, 30))
	body := m.ap.list.Render(boxW-4, rows, theme.BgPane)
	return ui.Box("SWITCH AGENT WINDOW", body, "↑↓ choose · enter select · esc cancel", boxW)
}
