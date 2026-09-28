package session

import (
	"strconv"
	"strings"

	"github.com/niti/tui/internal/theme"
	"github.com/niti/tui/internal/ui"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// The command palette (ctrl+p): every command, view, agent and theme in one fuzzy-searchable list,
// each entry a "category: Action" title over a one-line description — posting's palette. The `/`
// menu stays as the fast path for people who already know the command; this is how everyone else
// finds out what exists.

type paletteEntry struct {
	desc  string
	theme string // set for "theme: …" entries — highlighting one previews it live
	run   func(m *Model) tea.Cmd
}

type palette struct {
	open    bool
	query   string
	list    ui.List
	entries []paletteEntry // indexed by the ui.Item Value
	started string         // the theme when the palette opened — esc restores it
}

func (m *Model) openPalette() tea.Cmd {
	var items []ui.Item
	var entries []paletteEntry
	add := func(label string, e paletteEntry) {
		items = append(items, ui.Item{Label: label, Value: strconv.Itoa(len(entries)), Desc: e.desc})
		entries = append(entries, e)
	}

	if m.mode == "build" {
		add("mode: Plan", paletteEntry{desc: "The lead plans the work; nothing runs until you switch back", run: (*Model).toggleMode})
	} else {
		add("mode: Build", paletteEntry{desc: "Agents carry out the plan", run: (*Model).toggleMode})
	}
	add("model: Switch model…", paletteEntry{desc: "Change which model an agent runs on (^l)", run: (*Model).openCarousel})
	if m.view == "usage" {
		add("view: Transcript", paletteEntry{desc: "Back to the agents' live output", run: func(m *Model) tea.Cmd { m.view = "panes"; return nil }})
	} else {
		add("view: Usage", paletteEntry{desc: "Tokens and model per agent, in the main panel", run: func(m *Model) tea.Cmd { m.view = "usage"; return nil }})
	}
	if m.focus != "" {
		add("agent: All agents", paletteEntry{desc: "Every agent's output, stacked", run: func(m *Model) tea.Cmd { m.focus = ""; return nil }})
	}
	for i, id := range m.order {
		st, n := m.agents[id], i
		add("agent: "+st.cfg.Role, paletteEntry{desc: "Show only " + st.cfg.Role + "'s output (" + st.status + ")", run: func(m *Model) tea.Cmd { m.focus = m.order[n]; return nil }})
	}
	if m.compact() && m.prefs["compact"] {
		add("spacing: Standard", paletteEntry{desc: "Bordered, titled panels", run: func(m *Model) tea.Cmd { m.prefs["compact"] = false; return nil }})
	} else if !m.compact() {
		add("spacing: Compact", paletteEntry{desc: "Drop the panel borders to fit more output", run: func(m *Model) tea.Cmd { m.prefs["compact"] = true; return nil }})
	}
	add("help: Keys and glyphs", paletteEntry{desc: "What every key does here, and what the symbols mean (f1)", run: (*Model).openHelp})
	for _, name := range theme.Names() {
		name := name
		add("theme: "+name, paletteEntry{desc: "Switch the palette to " + name, theme: name, run: func(m *Model) tea.Cmd { return m.commitTheme(name) }})
	}
	for _, it := range m.menuItems() {
		cmd := it.Value
		add("command: "+cmd, paletteEntry{desc: it.Desc, run: func(m *Model) tea.Cmd { return m.submit(cmd) }})
	}

	if m.prefs == nil {
		m.prefs = map[string]bool{}
	}
	m.pal = palette{open: true, entries: entries, started: theme.Current()}
	m.pal.list.Set(items)
	return nil
}

func (m *Model) paletteSelected() (paletteEntry, bool) {
	it, ok := m.pal.list.Selected()
	if !ok {
		return paletteEntry{}, false
	}
	i, err := strconv.Atoi(it.Value)
	if err != nil || i < 0 || i >= len(m.pal.entries) {
		return paletteEntry{}, false
	}
	return m.pal.entries[i], true
}

// preview applies the highlighted theme entry, or restores the starting theme when the highlight
// moves off the themes — live preview without committing, the way posting's palette does it.
func (m *Model) preview() {
	if e, ok := m.paletteSelected(); ok && e.theme != "" {
		theme.Use(e.theme)
		return
	}
	theme.Use(m.pal.started)
}

func (m *Model) paletteKey(k tea.KeyMsg) tea.Cmd {
	switch k.String() {
	case "esc", "ctrl+p":
		theme.Use(m.pal.started)
		m.pal = palette{}
		return nil
	case "up", "ctrl+k", "shift+tab":
		m.pal.list.Move(-1)
		m.preview()
		return nil
	case "down", "ctrl+n", "tab":
		m.pal.list.Move(1)
		m.preview()
		return nil
	case "enter":
		e, ok := m.paletteSelected()
		theme.Use(m.pal.started) // a theme entry re-applies its own choice below
		m.pal = palette{}
		if ok && e.run != nil {
			return e.run(m)
		}
		return nil
	case "backspace":
		if r := []rune(m.pal.query); len(r) > 0 {
			m.pal.query = string(r[:len(r)-1])
			m.pal.list.SetQuery(m.pal.query)
			m.preview()
		}
		return nil
	}
	if k.Type == tea.KeyRunes || k.Type == tea.KeySpace {
		m.pal.query += string(k.Runes)
		if k.Type == tea.KeySpace {
			m.pal.query += " "
		}
		m.pal.list.SetQuery(m.pal.query)
		m.preview()
	}
	return nil
}

// commitTheme applies and persists a theme — the same end state as enter in the ctrl+t picker.
func (m *Model) commitTheme(name string) tea.Cmd {
	theme.Use(name)
	m.status = "theme: " + theme.Current()
	client := m.client
	if client == nil {
		return nil
	}
	return func() tea.Msg { return actionResultMsg{action: "theme", err: client.SetTheme(name)} }
}

// paletteView: an input row, then each match as a title over its description, the highlighted one
// on a tinted bar. Sits two rows from the top, 65% of the width (posting's proportions).
func (m Model) paletteView(w, h int) string {
	bg := theme.BgPane
	pw := clamp(w*65/100, min(w, 40), w)
	inner := max(pw-4, 1)
	rows := max((h-8)/2, 1) // two lines per entry
	query := lipgloss.NewStyle().Foreground(theme.Fg).Background(bg).Render("› " + m.pal.query)
	query += lipgloss.NewStyle().Foreground(theme.Accent).Background(bg).Render("▏")

	var lines []string
	sel := m.pal.list.Cursor()
	first := max(sel-rows+1, 0)
	for i := first; i < m.pal.list.Len() && i < first+rows; i++ {
		it := m.pal.list.At(i)
		rowBg, title, desc := bg, theme.Fg, theme.Muted
		if i == sel {
			rowBg, title = theme.Tint(theme.Accent), theme.Fg
		}
		pad := func(s string, fg lipgloss.Color, bold bool) string {
			s = ui.Truncate(" "+s, inner)
			return lipgloss.NewStyle().Foreground(fg).Background(rowBg).Bold(bold).Width(inner).Render(s)
		}
		cat, action, found := strings.Cut(it.Label, ": ")
		label := it.Label
		if found {
			label = cat + ": " + action
		}
		lines = append(lines, pad(label, title, i == sel), pad(it.Desc, desc, false))
	}
	if len(lines) == 0 {
		lines = append(lines, lipgloss.NewStyle().Foreground(theme.Muted).Background(bg).Render(" no matches"))
	}
	body := query + "\n" + strings.Join(lines, "\n")
	return ui.Box("COMMANDS", body, "↑↓ move · enter run · esc close", pw)
}
