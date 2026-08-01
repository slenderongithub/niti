package session

import (
	"strings"
	"testing"

	"github.com/amux/tui/internal/api"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/muesli/termenv"
)

func sized(agents, w, h int) Model {
	m := model(agents)
	updated, _ := m.Update(tea.WindowSizeMsg{Width: w, Height: h})
	return updated.(Model)
}

// A popup takes only the rows its content needs. The old fixed-height box left a block of empty
// pane under a short list, which is what "extra space for nothing" meant.
func TestPopupsAreSizedToTheirContent(t *testing.T) {
	m := sized(1, 120, 40)
	m.openCarousel()
	m.setCarouselModels(modelsLoadedMsg{options: []modelOption{{"google", "a"}, {"google", "b"}}})

	small := lipgloss.Height(m.carouselView(120, 40))
	many := make([]modelOption, 30)
	for i := range many {
		many[i] = modelOption{"google", strings.Repeat("m", i+1)}
	}
	m.setCarouselModels(modelsLoadedMsg{options: many})
	big := lipgloss.Height(m.carouselView(120, 40))

	if small >= big {
		t.Errorf("a 2-model box (%d rows) must be shorter than a 30-model one (%d rows)", small, big)
	}
	if small > 8 { // title + 2 rows + blank + hint + 2 border rows
		t.Errorf("a 2-model box is %d rows tall — it should hug its content", small)
	}
}

// A popup must not blank the sidebar it floats over: the overlay keeps the base line's left half,
// so the sidebar's own background survives every row the box covers.
func TestOverlayKeepsTheSidebarPainted(t *testing.T) {
	lipgloss.SetColorProfile(termenv.TrueColor)
	defer lipgloss.SetColorProfile(termenv.ColorProfile())

	m := sized(2, 120, 34)
	m.out = output{open: true, title: "COMMANDS", lines: m.helpLines()}
	sidebarBg := "\x1b[48;2;17;20;31m" // BgPane of the default theme

	frame := strings.Split(m.View(), "\n")
	covered := 0
	for i, line := range frame {
		if i < headerRows || i >= len(frame)-2 {
			continue
		}
		if strings.Contains(ansi.Strip(line), "│") { // a row the box covers
			covered++
		}
		if !strings.HasPrefix(line, sidebarBg) {
			t.Fatalf("row %d lost the sidebar background: %q", i, ansi.Strip(line)[:20])
		}
	}
	if covered == 0 {
		t.Fatal("the popup never overlapped the body — the test proves nothing")
	}
}

// A one-line answer belongs in the footer; a table belongs in a window. Neither belongs in the
// agent-to-agent feed, which is what used to stack command output over the real traffic.
func TestCommandResultsRouteByShape(t *testing.T) {
	m := sized(1, 120, 40)

	one, _ := m.Update(commandResultMsg{name: "clear", result: api.CommandResult{Ok: true, Message: "cleared 0 task(s)"}})
	m = one.(Model)
	if m.out.open {
		t.Error("a one-line result must not open the pager")
	}
	if !strings.Contains(m.status, "cleared 0 task(s)") {
		t.Errorf("a one-line result belongs in the footer, got status %q", m.status)
	}
	if len(m.feed) != 0 {
		t.Errorf("command output must stay out of the agent feed, got %v", m.feed)
	}

	many, _ := m.Update(commandResultMsg{name: "agents", result: api.CommandResult{Ok: true, Message: "a one\nb two\nc three"}})
	m = many.(Model)
	if !m.out.open || m.out.title != "/agents" || len(m.out.lines) != 3 {
		t.Fatalf("a multi-line result must open the pager, got %+v", m.out)
	}
	if len(m.feed) != 0 {
		t.Errorf("command output must stay out of the agent feed, got %v", m.feed)
	}

	closed, _ := m.onKey(tea.KeyMsg{Type: tea.KeyEsc})
	if closed.(Model).out.open {
		t.Error("esc must close the pager")
	}
}

// /help is answered by the client, because only the client knows the whole command set — the server
// registry plus /quit, /theme, /graph and the settings tabs.
func TestHelpOpensAWindowListingEveryCommand(t *testing.T) {
	m := sized(1, 120, 40)
	m.commands = []api.Command{{Name: "tasks", Description: "task board"}}
	m.menu.Set(m.menuItems())

	if cmd := m.submit("/help"); cmd != nil {
		t.Error("/help is local — it must not round-trip to the server")
	}
	if !m.out.open {
		t.Fatal("/help must open the command window")
	}
	body := strings.Join(m.out.lines, "\n")
	for _, want := range []string{"/help", "/tasks", "/quit", "/theme", "/settings"} {
		if !strings.Contains(body, want) {
			t.Errorf("/help is missing %s:\n%s", want, body)
		}
	}
}

// Bare /model opens the same centred picker ctrl+p does; with arguments it stays scriptable and
// goes to the server.
func TestBareModelOpensThePicker(t *testing.T) {
	m := sized(2, 120, 40)
	m.submit("/model")
	if !m.car.open {
		t.Fatal("/model with no arguments must open the model picker")
	}

	m2 := sized(2, 120, 40)
	m2.commands = []api.Command{{Name: "model", Description: "switch"}}
	if cmd := m2.submit("/model a google/gemini"); cmd == nil {
		t.Error("/model with arguments must still dispatch to the server")
	}
	if m2.car.open {
		t.Error("/model with arguments must not open the picker")
	}
}

// One stray ctrl+c must not take a live session down with it.
func TestCtrlCNeedsTwoPresses(t *testing.T) {
	m := sized(1, 120, 40)
	first, cmd := m.onKey(tea.KeyMsg{Type: tea.KeyCtrlC})
	m = first.(Model)
	if cmd != nil || m.quitting {
		t.Fatal("the first ctrl+c must arm, not quit")
	}
	if !strings.Contains(m.status, "again") {
		t.Errorf("the first ctrl+c must say what a second one does, got %q", m.status)
	}

	second, cmd := m.onKey(tea.KeyMsg{Type: tea.KeyCtrlC})
	if cmd == nil || !second.(Model).quitting {
		t.Fatal("a second ctrl+c must quit")
	}

	// Anything in between disarms it.
	again, _ := m.onKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'x'}})
	third, _ := again.(Model).onKey(tea.KeyMsg{Type: tea.KeyCtrlC})
	if third.(Model).quitting {
		t.Error("a keystroke between the two presses must disarm the quit")
	}
}
