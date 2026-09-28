package session

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/niti/tui/internal/theme"
	"github.com/niti/tui/internal/ui"
	tea "github.com/charmbracelet/bubbletea"
)

// The end of a run, the way Claude Code ends a turn: a short summary of what changed, the files it
// touched with their +/- counts, and a suggested next prompt waiting in the prompt as grey text —
// tab takes it, typing replaces it.

const defaultPlaceholder = "describe the project…"

// refreshPlaceholder shows the first suggestion as the prompt's ghost text.
func (m *Model) refreshPlaceholder() {
	if len(m.suggestions) > 0 {
		m.input.Placeholder = m.suggestions[0] + "   (tab to use)"
		return
	}
	m.input.Placeholder = defaultPlaceholder
}

// acceptSuggestion puts the first suggestion in the prompt, ready to edit or send.
func (m *Model) acceptSuggestion() tea.Cmd {
	if len(m.suggestions) == 0 {
		return nil
	}
	m.input.SetValue(m.suggestions[0])
	m.input.CursorEnd()
	return nil
}

// clearTurn drops the last run's card and suggestions — a new goal is a new turn.
func (m *Model) clearTurn() {
	m.card = nil
	m.suggestions = nil
	m.refreshPlaceholder()
}

// cardRows is how many rows the card needs at the bottom of the transcript.
func (m Model) cardRows() int {
	if m.card == nil {
		return 0
	}
	return len(m.cardBody()) + 2
}

func (m Model) cardBody() []string {
	c := m.card
	var lines []string
	for _, l := range strings.Split(strings.TrimSpace(c.Summary), "\n") {
		if strings.TrimSpace(l) != "" {
			lines = append(lines, cleanMarkdown(l))
		}
	}
	lines = lines[:min(len(lines), 6)]
	files := c.Files
	if len(files) > 5 {
		files = files[:5]
	}
	for _, f := range files {
		counts := fmt.Sprintf("%c+%d%c", mkBold, f.Added, mkBoldEnd)
		if f.Removed > 0 {
			counts += fmt.Sprintf(" −%d", f.Removed)
		}
		lines = append(lines, fmt.Sprintf("%c%s%c  %s", mkCode, f.Path, mkCodeEnd, counts))
	}
	if n := len(c.Files) - len(files); n > 0 {
		lines = append(lines, fmt.Sprintf("… and %d more file(s)", n))
	}
	if len(lines) == 0 {
		lines = []string{"no summary"}
	}
	return lines
}

// cardView draws the card as a panel: green title when every task finished, amber otherwise.
func (m Model) cardView(w int) string {
	c := m.card
	title, color := "Done", theme.Green
	switch {
	case c.Cancelled:
		title, color = "Cancelled", theme.Amber
	case !c.Ok:
		title, color = "Finished with failures", theme.Amber
	}
	title += " · " + fmtDur(time.Duration(c.DurationMs)*time.Millisecond)
	if c.Tokens > 0 {
		title += " · " + fmtTok(c.Tokens) + " tok"
	}
	if c.Cost > 0 {
		title += fmt.Sprintf(" · $%.2f", c.Cost)
	}
	sub := ""
	if len(m.suggestions) > 0 {
		sub = "next: " + m.suggestions[0] + " · tab"
	}
	var rows []string
	for _, l := range m.cardBody() {
		rows = append(rows, renderLine(l, max(w-4, 1), theme.BgDeep))
	}
	return ui.Panel{Title: title, Subtitle: sub, Focused: true, TitleLeft: true, Color: color}.Render(strings.Join(rows, "\n"), w, m.cardRows())
}

// notifyCmd rings the terminal bell, and on macOS posts a desktop notification — for a run long
// enough that the user has probably looked away. Best effort: a failure changes nothing.
func notifyCmd(text string) tea.Cmd {
	return func() tea.Msg {
		_, _ = os.Stderr.WriteString("\a")
		if runtime.GOOS == "darwin" {
			script := fmt.Sprintf("display notification %q with title %q", text, "niti")
			_ = exec.Command("osascript", "-e", script).Run()
		}
		return nil
	}
}
