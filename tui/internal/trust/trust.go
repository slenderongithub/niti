// Package trust renders the "do you trust this folder?" prompt shown before niti spawns its core
// in a project directory it hasn't confirmed before (or whose MCP server config has changed since
// it was last confirmed) — the same reason Claude Code asks before reading/acting in a new folder.
// It runs standalone, before any session state exists, so it takes no dependency on the session
// package — just the shared ui/theme widgets every other popup in the app already uses.
package trust

import (
	"strings"

	"github.com/niti/tui/internal/theme"
	"github.com/niti/tui/internal/ui"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type Choice int

const (
	No Choice = iota
	Once
	Remember
)

type Model struct {
	Root    string
	Changed bool
	Choice  Choice
	width   int
	height  int
}

func New(root string, changed bool) Model {
	return Model{Root: root, Changed: changed}
}

func (m Model) Init() tea.Cmd { return nil }

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil
	case tea.KeyMsg:
		switch msg.String() {
		case "1", "enter":
			m.Choice = Once
			return m, tea.Quit
		case "2":
			m.Choice = Remember
			return m, tea.Quit
		case "3", "esc", "ctrl+c", "n", "N":
			m.Choice = No
			return m, tea.Quit
		}
	}
	return m, nil
}

func (m Model) View() string {
	w, h := m.width, m.height
	if w == 0 {
		w = 100
	}
	if h == 0 {
		h = 30
	}
	why := "niti hasn't run in this folder before."
	if m.Changed {
		why = "This folder's MCP server config changed since you last trusted it."
	}
	bg := theme.BgDeep
	st := func(c lipgloss.Color) lipgloss.Style { return lipgloss.NewStyle().Foreground(c).Background(bg) }
	option := func(key, label, note string) string {
		return st(theme.Accent).Bold(true).Render(" "+key+" ") + st(theme.Fg).Render(label) + st(theme.Muted).Render(note)
	}
	body := strings.Join([]string{
		st(theme.Fg).Bold(true).Render(why),
		"",
		st(theme.Muted).Render("Trusting it lets niti read .niti/agents.yaml, start the MCP"),
		st(theme.Muted).Render("servers it configures, and run agents against this code."),
		"",
		st(theme.Accent).Render("  " + ui.ShortPath(m.Root, 60)), // the box is 68 wide; keep the folder name, not the prefix
		"",
		option("1", "Trust once", "  — for this session"),
		option("2", "Trust and remember", "  — don't ask again for this folder"),
		option("3", "Exit", ""),
	}, "\n")
	return ui.SetupScreen(w, h, "Trust this folder?", "Trust this folder?", 68, body, "", "", []ui.Key{{"1", "Trust once"}, {"2", "Remember"}, {"3", "Exit"}, {"esc", "Exit"}})
}
