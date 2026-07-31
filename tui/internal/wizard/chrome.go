package wizard

import (
	"strings"

	"github.com/amux/tui/internal/theme"
	"github.com/amux/tui/internal/ui"
	"github.com/charmbracelet/lipgloss"
)

// Shared chrome for the two setup screens. They're the first thing shown on every launch, so they
// use the same painted full-screen surface as the session view — but the prompt itself is a card
// centered in the terminal rather than a column pinned to the top-left, because at this point
// there's nothing else on screen for it to be aligned with.

const (
	cardMin = 34
	cardMax = 78
)

// screen paints the whole terminal: brand bar, mode stripe, then the setup card centered in
// whatever is left. body/hint/input are stacked inside the card in that order.
func screen(w, h int, title, body, hint, input string) string {
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

	inner := max(h-2, 1) // the two header rows
	cardW := clamp(w-8, cardMin, min(cardMax, max(w-2, cardMin)))

	var lines []string
	if body != "" {
		lines = append(lines, strings.Split(body, "\n")...)
	}
	if hint != "" {
		if len(lines) > 0 {
			lines = append(lines, "")
		}
		for _, hl := range strings.Split(hint, "\n") {
			lines = append(lines, lipgloss.NewStyle().Foreground(theme.Alt).Background(bg).Render(ui.Truncate(hl, cardW-2)))
		}
	}
	if input != "" {
		lines = append(lines, "",
			lipgloss.NewStyle().Foreground(theme.Green).Background(bg).Bold(true).Render("▸ ")+input)
	}
	// A card taller than the terminal loses its tail rather than pushing the input off-screen —
	// callers keep the input last, so the visible remainder is always the actionable part.
	if maxLines := inner - 2; len(lines) > maxLines && maxLines > 0 {
		lines = append(lines[:maxLines-1], lines[len(lines)-1])
	}

	card := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).BorderForeground(theme.Accent).BorderBackground(theme.BgDeep).
		Background(bg).Padding(0, 1).Width(cardW).MaxWidth(w).
		Render(strings.Join(lines, "\n"))

	return head + "\n" + stripe + "\n" +
		lipgloss.Place(w, inner, lipgloss.Center, lipgloss.Center, card,
			lipgloss.WithWhitespaceBackground(theme.BgDeep))
}

func section(s string) string {
	return lipgloss.NewStyle().Foreground(theme.Accent).Background(theme.BgPane).Bold(true).Render(s)
}

func clamp(v, lo, hi int) int { return ui.Clamp(v, lo, hi) }
