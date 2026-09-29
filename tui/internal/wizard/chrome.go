package wizard

import (
	"strings"

	"github.com/niti/tui/internal/theme"
	"github.com/niti/tui/internal/ui"
	"github.com/charmbracelet/lipgloss"
)

// Shared chrome for the setup screens. They're the first thing shown on every launch, so they use
// the same painted full-screen surface as the session view — but the prompt itself is a card
// centered in the terminal rather than a column pinned to the top-left, because at this point
// there's nothing else on screen for it to be aligned with.
//
// The card is sized to what it actually holds, in both directions: five short options make a small
// card, forty models make a tall one. A frame that stays the same size whatever is inside it reads
// as a hole with text in the corner.

const (
	cardMin = 34
	cardMax = 78
)

// fit is the card's content width for a set of lines: the widest of them, clamped to the card
// bounds and to what the terminal can actually show.
func fit(w int, natural ...int) int {
	want := 0
	for _, n := range natural {
		want = max(want, n)
	}
	return clamp(want+2, cardMin, min(cardMax, max(w-6, cardMin))) // +2 for the card's side padding
}

func widest(lines ...string) int {
	n := 0
	for _, l := range lines {
		for _, part := range strings.Split(l, "\n") {
			n = max(n, lipgloss.Width(part))
		}
	}
	return n
}

// screen is the setup frame — see ui.SetupScreen. The step name heads the panel, the hint sits
// muted under the content, and the footer lists the keys for this kind of step.
func screen(w, h int, title string, cardW int, body, hint, input string) string {
	keys := []ui.Key{{"↑↓", "Choose"}, {"enter", "Confirm"}, {"esc", "Back"}, {"^c", "Quit"}}
	if input != "" && !strings.Contains(body, "▸ ") {
		keys = []ui.Key{{"enter", "Confirm"}, {"↑↓", "Choose"}, {"esc", "Back"}, {"^c", "Quit"}}
	}
	return ui.SetupScreen(w, h, "Set up your team", title, cardW+4, body, hint, input, keys)
}

// section is a small heading inside the panel (e.g. the saved roster), like the session's "Tasks".
func section(s string) string {
	return lipgloss.NewStyle().Foreground(theme.Muted).Background(theme.BgDeep).Bold(true).Render(s)
}

func clamp(v, lo, hi int) int { return ui.Clamp(v, lo, hi) }
