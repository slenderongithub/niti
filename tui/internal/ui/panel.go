package ui

import (
	"strings"

	"github.com/niti/tui/internal/theme"
	"github.com/charmbracelet/lipgloss"
)

// Panel is a bordered region with its name in the top border and live detail in the bottom one —
// posting's layout: the frame itself says what a region is and what state it's in, so none of the
// content rows are spent on labels. The border is dim until the panel has focus, so at any moment
// exactly one frame is drawn in the accent color.
type Panel struct {
	Title     string
	Subtitle  string
	Focused   bool
	TitleLeft bool           // title at the left of the top border (default: right, like posting)
	Color     lipgloss.Color // border/title color override when focused (e.g. PLAN mode, an approval)
	Bg        lipgloss.Color // defaults to the canvas
}

// Render draws the panel at exactly w×h cells; body lines beyond h-2 are dropped, short bodies are
// padded. Every cell carries the background, so the painted surface has no holes.
func (p Panel) Render(body string, w, h int) string {
	bg := p.Bg
	if bg == "" {
		bg = theme.BgDeep
	}
	if w < 4 || h < 2 {
		return lipgloss.NewStyle().Width(max(w, 0)).Height(max(h, 0)).Background(bg).Render("")
	}
	border, titleFg := theme.Line, theme.Muted
	if p.Focused {
		border, titleFg = theme.Accent, theme.Fg
		if p.Color != "" {
			border = p.Color
		}
	}
	line := lipgloss.NewStyle().Foreground(border).Background(bg)
	inner := w - 2

	// Top: ╭──── Title ─╮ (or ╭─ Title ────╮ with TitleLeft).
	title := Truncate(p.Title, max(inner-4, 0))
	top := line.Render("╭" + strings.Repeat("─", inner) + "╮")
	if title != "" {
		ts := lipgloss.NewStyle().Foreground(titleFg).Background(bg).Bold(p.Focused).Render(" " + title + " ")
		fill := max(inner-lipgloss.Width(title)-3, 0)
		if p.TitleLeft {
			top = line.Render("╭─") + ts + line.Render(strings.Repeat("─", fill)+"╮")
		} else {
			top = line.Render("╭"+strings.Repeat("─", fill)) + ts + line.Render("─╮")
		}
	}

	// Bottom: ╰─ subtitle ────╯, subtitle always left (posting's border-subtitle-align: left).
	bottom := line.Render("╰" + strings.Repeat("─", inner) + "╯")
	if sub := Truncate(p.Subtitle, max(inner-4, 0)); sub != "" {
		ss := lipgloss.NewStyle().Foreground(theme.Muted).Background(bg).Render(" " + sub + " ")
		bottom = line.Render("╰─") + ss + line.Render(strings.Repeat("─", max(inner-lipgloss.Width(sub)-3, 0))+"╯")
	}

	rows := make([]string, 0, h)
	rows = append(rows, top)
	content := strings.Split(body, "\n")
	cw := inner - 2 // one column of padding either side
	side := line.Render("│")
	padCell := lipgloss.NewStyle().Background(bg)
	for i := 0; i < h-2; i++ {
		c := ""
		if i < len(content) {
			c = Truncate(content[i], cw)
		}
		rows = append(rows, side+padCell.Render(" ")+c+padCell.Render(strings.Repeat(" ", max(cw-lipgloss.Width(c), 0))+" ")+side)
	}
	rows = append(rows, bottom)
	return strings.Join(rows, "\n")
}

// Hatch is an intentional empty state: the area filled with a faint diagonal hatch and the message
// centered on it, so an empty region reads as "nothing here yet" rather than as a rendering bug.
func Hatch(msg string, w, h int, bg lipgloss.Color) string {
	if w < 1 || h < 1 {
		return ""
	}
	hatch := lipgloss.NewStyle().Foreground(theme.Line).Background(bg)
	msg = Truncate(msg, max(w-4, 0))
	rows := make([]string, h)
	for i := range rows {
		if i == h/2 && msg != "" {
			label := lipgloss.NewStyle().Foreground(theme.Muted).Background(bg).Render(" " + msg + " ")
			left := (w - lipgloss.Width(label)) / 2
			rows[i] = hatch.Render(strings.Repeat("╱", left)) + label + hatch.Render(strings.Repeat("╱", max(w-left-lipgloss.Width(label), 0)))
			continue
		}
		rows[i] = hatch.Render(strings.Repeat("╱", w))
	}
	return strings.Join(rows, "\n")
}
