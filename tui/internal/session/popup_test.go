package session

import (
	"strings"
	"testing"

	"github.com/niti/tui/internal/api"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
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

// A popup must not blank the panel it floats over: the overlay keeps the base line's left half, so
// the Agents panel's frame survives on every row the box covers.
func TestOverlayKeepsTheSidebarPainted(t *testing.T) {
	m := sized(2, 120, 34)
	m.out = output{open: true, title: "COMMANDS", lines: m.helpLines()}
	frame := strings.Split(ansi.Strip(m.View()), "\n")
	covered := 0
	for i, line := range frame {
		if i < headerRows || i >= len(frame)-4 { // header; prompt panel + footer
			continue
		}
		if strings.Count(line, "│") > 2 { // a row the box covers: frame + box sides
			covered++
		}
		if r := []rune(line); len(r) == 0 || !strings.ContainsRune("│╭╰", r[0]) {
			t.Fatalf("row %d lost the Agents panel frame: %q", i, line[:min(20, len(line))])
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

// /tasks is drawn by the TUI from the live board: status spelled out, the agent by its role, long
// descriptions wrapped rather than cut, dependencies under the task that waits — and it moves when
// the board does.
func TestTasksWindowIsATableThatFollowsTheBoard(t *testing.T) {
	m := sized(2, 120, 40)
	first := m.order[0]
	m.tasks = []api.Task{
		{ID: "t1", Description: "Design the cart schema", AssignedTo: first, Status: "done"},
		{ID: "t2", Description: "Implement the checkout endpoint with validation, idempotency keys and a retry-safe payment step that survives duplicate submits", AssignedTo: m.agents[m.order[1]].cfg.Role, Status: "in_progress", DependsOn: []string{"t1"}},
		{ID: "t3", Description: "Write tests", Status: "pending"},
	}
	m.submit("/tasks")
	if !m.out.open || m.out.kind != "tasks" {
		t.Fatalf("/tasks should open the tasks window, got %+v", m.out)
	}
	v := screen(m)
	for _, want := range []string{"1/3 done · 1 running · 1 pending", "STATUS", "AGENT", "TASK", "● done", "◐ running", "○ pending", "↳ after t1", "duplicate submits"} {
		if !strings.Contains(v, want) {
			t.Errorf("tasks window missing %q:\n%s", want, v)
		}
	}
	m.setTask("t2", "done")
	if v := screen(m); !strings.Contains(v, "2/3 done · 1 pending") {
		t.Errorf("the open window should follow the board:\n%s", v)
	}
}

func TestAgentsWindowListsTheTeamWithModelsAndTools(t *testing.T) {
	m := sized(2, 120, 40)
	m.submit("/agents")
	if m.out.kind != "agents" {
		t.Fatalf("/agents should open the agents window, got %+v", m.out)
	}
	v := screen(m)
	for _, want := range []string{"ROLE", "MODEL", "STATE", "TOOLS", m.agents[m.order[0]].cfg.Role, m.agents[m.order[1]].cfg.Role} {
		if !strings.Contains(v, want) {
			t.Errorf("agents window missing %q:\n%s", want, v)
		}
	}
}
