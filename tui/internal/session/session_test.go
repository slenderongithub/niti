package session

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/amux/tui/internal/api"
	"github.com/amux/tui/internal/theme"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

func TestTruncate(t *testing.T) {
	cases := []struct {
		name string
		s    string
		n    int
		want string
	}{
		{"under limit returned as-is", "hi", 10, "hi"},
		{"exact limit returned as-is", "hello", 5, "hello"},
		{"over limit truncated with ellipsis", "hello world", 5, "hell…"},
		{"newlines collapsed to spaces first", "a\nb\nc", 10, "a b c"},
		{"n zero never panics, returns empty", "hello", 0, ""},
		{"n negative never panics, returns empty", "hello", -5, ""},
		{"n one returns just the ellipsis", "hello", 1, "…"},
		{"empty string with n<=0", "", 0, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := truncate(c.s, c.n)
			if got != c.want {
				t.Errorf("truncate(%q, %d) = %q, want %q", c.s, c.n, got, c.want)
			}
		})
	}
}

func model(agents int) Model {
	m := Model{agents: map[string]*agentState{}, view: "panes", mode: "build", cancel: func() {},
		root: "/Users/someone/code/amux", costKnown: true}
	for i := 0; i < agents; i++ {
		id := string(rune('a' + i))
		m.order = append(m.order, id)
		m.agents[id] = &agentState{cfg: api.AgentConfig{ID: id, Role: "Role", Provider: "p", Model: "m"},
			status: "idle", color: theme.AgentColor(i), avatar: theme.Avatar(i), ctxLimit: 200000}
	}
	return m
}

// The panes/feed reflow instead of clipping or leaving dead space when the terminal is resized.
func TestViewReflowsWithTerminalSize(t *testing.T) {
	m := model(3)
	for _, size := range []struct{ w, h int }{{60, 20}, {200, 60}, {30, 12}} {
		updated, _ := m.Update(tea.WindowSizeMsg{Width: size.w, Height: size.h})
		m = updated.(Model)
		out := m.View()
		if got := lipgloss.Width(out); got > size.w {
			t.Errorf("at %dx%d the view is %d columns wide — it must fit", size.w, size.h, got)
		}
		if lipgloss.Height(out) > size.h {
			t.Errorf("at %dx%d the view is %d rows tall — it must fit", size.w, size.h, lipgloss.Height(out))
		}
	}
}

// The view fills the terminal rather than floating a small box in it — the complaint that drove
// the redesign. Every row of the height budget must be used at a realistic size.
func TestViewFillsTheTerminal(t *testing.T) {
	m := model(2)
	updated, _ := m.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	m = updated.(Model)
	out := m.View()
	if got := lipgloss.Height(out); got != 40 {
		t.Errorf("view is %d rows tall at height 40 — it must fill the screen", got)
	}
	if got := lipgloss.Width(out); got != 120 {
		t.Errorf("view is %d columns wide at width 120 — it must fill the screen", got)
	}
}

// The sidebar is dropped rather than squeezed when there isn't room for it.
func TestSidebarOnlyWhenThereIsRoom(t *testing.T) {
	m := model(2)
	m.lsp = []api.LspInfo{{Name: "typescript", Running: true}}
	m.mcp = []api.McpInfo{{Name: "code-review", Tools: 12}}

	wide, _ := m.Update(tea.WindowSizeMsg{Width: 140, Height: 40})
	if out := wide.(Model).View(); !strings.Contains(out, "typescript") || !strings.Contains(out, "code-review") {
		t.Error("a wide terminal must show the LSP/MCP sidebar")
	}
	narrow, _ := m.Update(tea.WindowSizeMsg{Width: 60, Height: 24})
	if out := narrow.(Model).View(); strings.Contains(out, "typescript") {
		t.Error("a narrow terminal must drop the sidebar rather than squeeze it")
	}
}

// Streamed `delta` chunks assemble into whole transcript lines; the unfinished tail stays pending.
func TestDeltaStreamAssemblesLines(t *testing.T) {
	st := &agentState{}
	st.feedDelta("hello ")
	st.feedDelta("world\nsecond li")
	if len(st.log) != 1 || st.log[0] != "hello world" {
		t.Fatalf("expected one completed line %q, got %v", "hello world", st.log)
	}
	if st.pending != "second li" {
		t.Fatalf("expected the partial line to stay pending, got %q", st.pending)
	}
	st.feedDelta("ne\n")
	if len(st.log) != 2 || st.log[1] != "second line" || st.pending != "" {
		t.Fatalf("expected the pending line to flush, got log=%v pending=%q", st.log, st.pending)
	}
	// A model that never emits a newline must not grow `pending` without bound.
	st.feedDelta(strings.Repeat("x", maxPendingLine+10))
	if st.pending != "" {
		t.Errorf("an over-long line should be force-flushed, pending is %d chars", len(st.pending))
	}
}

// ctrl+p flips BUILD↔PLAN, and the mode is what gets sent with the next prompt.
func TestPlanModeTogglesAndIsSubmitted(t *testing.T) {
	var gotMode string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Mode string }
		json.NewDecoder(r.Body).Decode(&body)
		gotMode = body.Mode
		w.Write([]byte(`{"accepted":true}`))
	}))
	defer srv.Close()

	m := model(1)
	m.client = api.New(srv.URL, "tok")
	toggled, _ := m.onKey(tea.KeyMsg{Type: tea.KeyCtrlP})
	m = toggled.(Model)
	if m.mode != "plan" {
		t.Fatalf("ctrl+p should switch to plan mode, got %q", m.mode)
	}
	cmd := m.submit("build a todo app")
	if cmd == nil {
		t.Fatal("submitting a goal should produce a command")
	}
	cmd()
	if gotMode != "plan" {
		t.Errorf("the prompt should carry the active mode, server saw %q", gotMode)
	}
}

// /theme is handled locally (the core has no opinion about this terminal's colors) and an unknown
// name must not blank the UI.
func TestThemeCommandIsLocal(t *testing.T) {
	m := model(1)
	if cmd := m.submit("/theme nord"); cmd != nil || theme.Current() != "nord" {
		t.Errorf("/theme should switch locally, current=%q cmd=%v", theme.Current(), cmd)
	}
	if cmd := m.submit("/theme nonsense"); cmd != nil || theme.Current() != "nord" {
		t.Errorf("an unknown theme must be refused and leave the current one, got %q", theme.Current())
	}
	theme.Use("amux")
}

// Slash commands are dispatched against the server's registry, not a hardcoded switch.
func TestSubmitDispatchesKnownCommandsOnly(t *testing.T) {
	m := model(1)
	m.commands = []api.Command{{Name: "undo", Description: "revert"}}

	if cmd := m.submit("/undo extra args"); cmd == nil {
		t.Error("a registry command should produce a dispatch cmd")
	}
	if cmd := m.submit("/nonsense"); cmd != nil || !strings.Contains(m.status, "unknown command") {
		t.Errorf("an unregistered command should be refused locally, got status %q", m.status)
	}
	if cmd := m.submit("/quit"); cmd == nil || !m.quitting { // /quit stays local: it ends this process
		t.Error("/quit must still quit")
	}
}

// Regression guard: a narrow terminal must never panic here (the bug this fix closed).
func TestTruncateNeverPanics(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("truncate panicked: %v", r)
		}
	}()
	for n := -5; n < 5; n++ {
		truncate("some non-empty status text", n)
	}
}
