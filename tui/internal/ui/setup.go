package ui

import (
	"strings"

	"github.com/niti/tui/internal/theme"
	"github.com/charmbracelet/lipgloss"
)

// Key is one footer entry: the key and what it does ("enter", "Confirm").
type Key [2]string

// SetupScreen is the frame for everything shown before the session — the trust prompt and the
// team picker — drawn in the session's own language so the app looks like one thing from the first
// frame: the title bar (niti + version left, the step right), a titled panel centered on the canvas,
// and the footer of keys that work here.
func SetupScreen(w, h int, step, title string, panelW int, body, hint, input string, keys []Key) string {
	if w <= 0 {
		w = 90
	}
	if h <= 0 {
		h = 28
	}
	bg := theme.BgDeep
	txt := func(c lipgloss.Color) lipgloss.Style { return lipgloss.NewStyle().Foreground(c).Background(bg) }

	left := txt(theme.Accent).Bold(true).Render(" niti") + txt(theme.Muted).Render(" "+Version)
	right := txt(theme.Muted).Render(step + " ")
	bar := left + txt(theme.Muted).Render(strings.Repeat(" ", max(w-lipgloss.Width(left)-lipgloss.Width(right), 0))) + right

	var foot strings.Builder
	foot.WriteString(txt(theme.Fg).Render(" "))
	for _, k := range keys {
		seg := txt(theme.Accent).Bold(true).Render(k[0]) + txt(theme.Fg).Render(" "+k[1]+"  ")
		if lipgloss.Width(foot.String())+lipgloss.Width(seg) > w {
			break
		}
		foot.WriteString(seg)
	}
	footer := lipgloss.NewStyle().Width(w).MaxWidth(w).Background(bg).Render(foot.String())

	var lines []string
	if body != "" {
		lines = append(lines, strings.Split(body, "\n")...)
	}
	panelW = Clamp(panelW, 40, max(min(w-4, 90), 40))
	if hint != "" {
		if len(lines) > 0 {
			lines = append(lines, "")
		}
		for _, hl := range strings.Split(hint, "\n") {
			for _, wl := range Wrap(hl, panelW-4, 3) {
				lines = append(lines, txt(theme.Muted).Render(wl))
			}
		}
	}
	if input != "" {
		lines = append(lines, "", txt(theme.Accent).Bold(true).Render("▸ ")+input)
	}
	area := max(h-2, 3) // minus the title bar and the footer
	// Taller than the terminal: drop from the middle, keep the input (the actionable part) last.
	if maxLines := area - 2; len(lines) > maxLines && maxLines > 1 {
		lines = append(lines[:maxLines-1], lines[len(lines)-1])
	}
	panel := Panel{Title: title, Focused: true, TitleLeft: true}.Render(strings.Join(lines, "\n"), panelW, len(lines)+2)
	mid := lipgloss.Place(w, area, lipgloss.Center, lipgloss.Center, panel, lipgloss.WithWhitespaceBackground(bg))
	return bar + "\n" + mid + "\n" + footer
}
