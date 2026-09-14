// Package trust renders the "do you trust this folder?" prompt shown before niti spawns its core
// in a project directory it hasn't confirmed before (or whose MCP server config has changed since
// it was last confirmed) — the same reason Claude Code asks before reading/acting in a new folder.
// It runs standalone, before any session state exists, so it takes no dependency on the session
// package — just the shared ui/theme widgets every other popup in the app already uses.
package trust

import (
	"fmt"

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
	why := "niti hasn't run in this directory before."
	if m.Changed {
		why = "This directory's MCP server config has changed since you last trusted it."
	}
	body := fmt.Sprintf(
		"%s\n\n"+
			"Trusting a folder lets niti read its .niti/agents.yaml, spawn any MCP servers it\n"+
			"configures, and run agents against its code.\n\n"+
			"  %s\n\n"+
			"[1] Yes, proceed\n[2] Yes, and remember this folder\n[3] No, exit",
		why, m.Root,
	)
	base := lipgloss.NewStyle().Width(w).Height(h).Background(theme.BgDeep).Render("")
	boxW := ui.Clamp(w-10, 40, 70)
	box := ui.Box("TRUST THIS FOLDER?", body, "1/enter: proceed · 2: remember · 3/esc: exit", boxW)
	return ui.Overlay(base, box, w, h)
}
