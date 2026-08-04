package session

import (
	"fmt"
	"strings"

	"github.com/niti/tui/internal/theme"
	"github.com/niti/tui/internal/ui"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// Commands like /help, /agents, /tasks and /sessions answer with a table, not a sentence. Those
// used to be pushed into the one-line footer and the agent-to-agent feed, where a five-row answer
// arrived as five stacked lines of debris that pushed the real traffic off screen. A multi-line
// result now opens this pager instead: a scrollable box in the middle of the screen, esc to close.
// One-line results still go to the footer, where a one-line answer belongs.

type output struct {
	open  bool
	title string
	lines []string
	top   int
}

// show routes a command result by shape rather than by name — anything that wraps to more than one
// line is a document, and documents get a window.
func (m *Model) show(title, message string) {
	message = strings.TrimRight(message, "\n")
	if message == "" {
		return
	}
	if !strings.Contains(message, "\n") {
		m.status = title + ": " + message
		return
	}
	m.out = output{open: true, title: title, lines: strings.Split(message, "\n")}
}

func (m *Model) outputKey(k tea.KeyMsg) tea.Cmd {
	page := max(m.outputRows()-1, 1)
	switch k.String() {
	case "esc", "q", "enter", "ctrl+c":
		m.out = output{}
	case "up", "k":
		m.out.top = max(m.out.top-1, 0)
	case "down", "j":
		m.out.top = min(m.out.top+1, m.outputMaxTop())
	case "pgup":
		m.out.top = max(m.out.top-page, 0)
	case "pgdown", " ":
		m.out.top = min(m.out.top+page, m.outputMaxTop())
	case "home", "g":
		m.out.top = 0
	case "end", "G":
		m.out.top = m.outputMaxTop()
	}
	return nil
}

func (m Model) outputRows() int   { return clamp(m.height-10, 3, 24) }
func (m Model) outputMaxTop() int { return max(len(m.out.lines)-m.outputRows(), 0) }

func (m Model) outputView(w, h int) string {
	bg := theme.BgPane
	rows := min(m.outputRows(), len(m.out.lines))
	top := clamp(m.out.top, 0, m.outputMaxTop())

	// The hint is finished before the box is measured, so a long "(12–34 of 90)" widens the box
	// rather than being truncated by it.
	hint := "esc closes"
	if len(m.out.lines) > rows {
		hint = fmt.Sprintf("↑↓ scroll · esc closes   (%d–%d of %d)", top+1, min(top+rows, len(m.out.lines)), len(m.out.lines))
	}
	// Width follows the content, capped by the terminal — a two-column list shouldn't get a box
	// sized for the widest command output imaginable.
	natural := widest(m.out.title, hint)
	for _, l := range m.out.lines {
		natural = max(natural, lipgloss.Width(l))
	}
	boxW := clamp(natural+6, 30, max(w-6, 30))
	inner := boxW - 4

	var lines []string
	for i := top; i < len(m.out.lines) && i < top+rows; i++ {
		lines = append(lines, txt(theme.Fg, bg).Render(padRight(truncate(m.out.lines[i], inner), inner, bg)))
	}
	return ui.Box(m.out.title, strings.Join(lines, "\n"), hint, boxW)
}

// padRight fills a line out to w so the pager's rows are a solid block rather than ragged text on
// the pane background.
func padRight(s string, w int, bg lipgloss.Color) string {
	if gap := w - lipgloss.Width(s); gap > 0 {
		return s + lipgloss.NewStyle().Background(bg).Render(strings.Repeat(" ", gap))
	}
	return s
}
