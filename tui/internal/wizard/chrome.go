package wizard

import (
	"strings"

	"github.com/amux/tui/internal/theme"
	"github.com/charmbracelet/lipgloss"
)

// Shared chrome for the two setup screens. They're the first thing shown on every launch, so they
// use the same painted full-screen frame as the session view — header bar, mode stripe, panel,
// input row — rather than reading as a plain prompt that happens to precede a themed app.

func frame(w, h int, title, body, hint string) string {
	if w <= 0 {
		w = 90
	}
	if h <= 0 {
		h = 28
	}
	bg := theme.BgPane
	head := lipgloss.NewStyle().Width(w).MaxWidth(w).Background(bg).Render(
		lipgloss.NewStyle().Foreground(theme.Accent).Background(bg).Bold(true).Render(" ● amux ") +
			lipgloss.NewStyle().Foreground(theme.Muted).Background(bg).Render("— "+title))
	stripe := lipgloss.NewStyle().Foreground(theme.Accent).Background(theme.BgDeep).Render(strings.Repeat("━", w))

	inner := max(h-3, 1) // the header rows above and the input row below
	var lines []string
	if body != "" {
		lines = strings.Split(body, "\n")
	}
	if hint != "" {
		lines = append(lines, "")
		for _, hl := range strings.Split(hint, "\n") {
			lines = append(lines, lipgloss.NewStyle().Foreground(theme.Alt).Background(bg).Render("  "+hl))
		}
	}
	for i, l := range lines {
		lines[i] = lipgloss.NewStyle().MaxWidth(w).Render(l) // ANSI-aware, so styled lines survive it
	}
	if len(lines) > inner {
		lines = lines[:inner]
	}
	for len(lines) < inner {
		lines = append(lines, "")
	}
	panel := lipgloss.NewStyle().Width(w).MaxWidth(w).Height(inner).MaxHeight(inner).Background(bg).
		Render(strings.Join(lines, "\n"))
	return head + "\n" + stripe + "\n" + panel
}

func inputRow(w int, input string) string {
	if w <= 0 {
		w = 90
	}
	bg := theme.BgPane
	return "\n" + lipgloss.NewStyle().Width(w).MaxWidth(w).Background(bg).Render(
		lipgloss.NewStyle().Foreground(theme.Green).Background(bg).Bold(true).Render(" ▸ ")+input)
}

func section(s string) string {
	return lipgloss.NewStyle().Foreground(theme.Accent).Background(theme.BgPane).Bold(true).Render(s)
}
