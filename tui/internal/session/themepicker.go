package session

import (
	"strings"

	"github.com/amux/tui/internal/theme"
	"github.com/amux/tui/internal/ui"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// The theme picker is a small swatch-preview popup — ctrl+t used to just silently cycle to the
// next theme; this shows what you're picking (a monkeytype-style list: name + a row of its actual
// colors) and previews it live as you move, esc reverts. Modeled on carousel.go's popup shape,
// but there's no search/filter: with only 5 themes, a fixed list is simpler than pulling in
// ui.List's fuzzy matcher for five rows.

type themePicker struct {
	open    bool
	names   []string
	cursor  int
	started string // the theme active when the picker opened — esc reverts to this
}

func (m *Model) openThemePicker() {
	names := theme.Names()
	cur := theme.Current()
	cursor := 0
	for i, n := range names {
		if n == cur {
			cursor = i
		}
	}
	m.tp = themePicker{open: true, names: names, cursor: cursor, started: cur}
}

func (m *Model) themePickerKey(k tea.KeyMsg) tea.Cmd {
	switch k.String() {
	case "esc":
		theme.Use(m.tp.started)
		m.tp = themePicker{}
		return nil
	case "up", "left", "k", "h", "shift+tab":
		m.tp.cursor = (m.tp.cursor - 1 + len(m.tp.names)) % len(m.tp.names)
		theme.Use(m.tp.names[m.tp.cursor])
		return nil
	case "down", "right", "j", "l", "tab":
		m.tp.cursor = (m.tp.cursor + 1) % len(m.tp.names)
		theme.Use(m.tp.names[m.tp.cursor])
		return nil
	case "enter":
		name := theme.Current()
		m.status = "theme: " + name
		m.tp = themePicker{}
		client := m.client
		return func() tea.Msg {
			return actionResultMsg{action: "theme", err: client.SetTheme(name)}
		}
	}
	return nil
}

// themePickerView renders a horizontal carousel: the current theme centered and full-strength,
// its neighbors dimmed on either side — scrolling left/right slides the whole strip. Every card
// draws with ITS OWN theme's colors (not the currently-previewed live theme), so a dimmed
// neighbor's swatches don't change as you move past it.
func (m Model) themePickerView(w, h int) string {
	bg := theme.BgPane
	nameW := 0
	for _, n := range m.tp.names {
		nameW = max(nameW, len(n))
	}
	cardW := nameW + 4

	card := func(i int, current bool) string {
		n := m.tp.names[i]
		t := theme.Themes[n]
		fg := theme.Muted
		if current {
			fg = theme.Fg
		}
		name := lipgloss.NewStyle().Foreground(fg).Background(bg).Bold(current).Width(cardW).Align(lipgloss.Center).Render(n)
		var dots strings.Builder
		for _, c := range []lipgloss.Color{t.Accent, t.Alt, t.Green, t.Blue, t.Pink} {
			s := lipgloss.NewStyle().Foreground(c).Background(bg)
			if !current {
				s = s.Faint(true)
			}
			dots.WriteString(s.Render("●"))
		}
		swatches := lipgloss.NewStyle().Width(cardW).Align(lipgloss.Center).Background(bg).Render(dots.String())
		return lipgloss.JoinVertical(lipgloss.Center, name, swatches)
	}

	n := len(m.tp.names)
	arrow := lipgloss.NewStyle().Foreground(theme.Muted).Background(bg).Render(" ‹ ")
	body := card(m.tp.cursor, true)
	if n == 2 {
		body = lipgloss.JoinHorizontal(lipgloss.Center, card(m.tp.cursor, true), arrow, card((m.tp.cursor+1)%n, false))
	} else if n > 2 {
		prev, next := (m.tp.cursor-1+n)%n, (m.tp.cursor+1)%n
		body = lipgloss.JoinHorizontal(lipgloss.Center, card(prev, false), arrow, card(m.tp.cursor, true), arrow, card(next, false))
	}
	hint := "← → preview · enter confirm · esc cancel"
	boxW := clamp(lipgloss.Width(body)+6, 34, max(w-6, 34))
	return ui.Box("THEME", body, hint, boxW)
}
