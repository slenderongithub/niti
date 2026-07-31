package session

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/amux/tui/internal/api"
	"github.com/amux/tui/internal/theme"
	"github.com/charmbracelet/bubbles/textinput"
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
	ti := textinput.New()
	ti.Focus()
	m := Model{agents: map[string]*agentState{}, view: "panes", mode: "build", cancel: func() {},
		root: "/Users/someone/code/amux", costKnown: true, input: ti}
	for i := 0; i < agents; i++ {
		id := string(rune('a' + i))
		m.order = append(m.order, id)
		m.agents[id] = &agentState{cfg: api.AgentConfig{ID: id, Role: "Role " + id, Provider: "p", Model: "m"},
			status: "idle", color: theme.AgentColor(i), avatar: theme.Avatar(i), ctxLimit: 200000}
	}
	m.menu.Set(m.menuItems())
	return m
}

// typing feeds a string through onKey one rune at a time, the way the terminal delivers it.
func typing(m Model, s string) Model {
	for _, r := range s {
		next, _ := m.onKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
		m = next.(Model)
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

// shift+tab flips BUILD↔PLAN, and the mode is what gets sent with the next prompt. (ctrl+p is the
// model carousel — see TestCarousel* below.)
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
	toggled, _ := m.onKey(tea.KeyMsg{Type: tea.KeyShiftTab})
	m = toggled.(Model)
	if m.mode != "plan" {
		t.Fatalf("shift+tab should switch to plan mode, got %q", m.mode)
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

// Typing "/" opens the suggestion window; typing more narrows it; tab completes the highlighted
// command without running it. This is the whole point of the menu — commands are discovered, not
// memorised.
func TestSlashMenuFiltersAndCompletes(t *testing.T) {
	m := model(1)
	m.commands = []api.Command{
		{Name: "model", Description: "switch a model"},
		{Name: "mcp", Description: "list mcp servers"},
		{Name: "undo", Description: "revert a write"},
	}
	m.menu.Set(m.menuItems())

	if m.menuOpen {
		t.Fatal("the menu must stay closed until a / is typed")
	}
	m = typing(m, "/")
	if !m.menuOpen || m.menu.Len() != 5 { // 3 server commands + /theme + /quit
		t.Fatalf("expected all commands offered on /, open=%v len=%d", m.menuOpen, m.menu.Len())
	}
	m = typing(m, "m")
	if m.menu.Len() != 3 { // /model, /mcp, and /theme — which merely contains an m, so it ranks last
		t.Fatalf("expected the m filter to keep 3 commands, got %d", m.menu.Len())
	}
	if it, _ := m.menu.Selected(); it.Value != "/model" {
		t.Errorf("a name starting with the query should be highlighted first, got %q", it.Value)
	}

	completed, _ := m.onKey(tea.KeyMsg{Type: tea.KeyTab})
	m = completed.(Model)
	if m.input.Value() != "/model " {
		t.Fatalf("tab should complete the highlighted command, got %q", m.input.Value())
	}
	if m.menuOpen {
		t.Error("a completed command name (with its trailing space) should close the menu")
	}

	// Plain text must leave the menu alone.
	m = model(1)
	m = typing(m, "build a todo app")
	if m.menuOpen {
		t.Error("a normal prompt must not open the command menu")
	}
}

// Enter on a highlighted suggestion runs it, rather than sending the half-typed text as a goal.
func TestSlashMenuEnterRunsTheHighlightedCommand(t *testing.T) {
	var ran string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ran = r.URL.Path
		w.Write([]byte(`{"ok":true,"message":"done"}`))
	}))
	defer srv.Close()

	m := model(1)
	m.client = api.New(srv.URL, "tok")
	m.commands = []api.Command{{Name: "undo", Description: "revert a write"}}
	m.menu.Set(m.menuItems())
	m = typing(m, "/un")

	entered, cmd := m.onKey(tea.KeyMsg{Type: tea.KeyEnter})
	m = entered.(Model)
	if cmd == nil {
		t.Fatal("enter on a suggestion should dispatch it")
	}
	cmd()
	if ran != "/commands/undo" {
		t.Errorf("expected /undo to be dispatched, server saw %q", ran)
	}
	if m.input.Value() != "" {
		t.Errorf("the input should be cleared after running, got %q", m.input.Value())
	}
}

// ctrl+p opens the carousel; with one agent there's nothing to choose, so it goes straight to
// models and enter applies the switch.
func TestCarouselSwitchesTheModel(t *testing.T) {
	var got map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/model" {
			json.NewDecoder(r.Body).Decode(&got)
		}
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	m := model(1)
	m.client = api.New(srv.URL, "tok")
	opened, cmd := m.onKey(tea.KeyMsg{Type: tea.KeyCtrlP})
	m = opened.(Model)
	if !m.car.open || m.car.stage != "model" || cmd == nil {
		t.Fatalf("ctrl+p with one agent should open straight on models, open=%v stage=%q", m.car.open, m.car.stage)
	}
	m.setCarouselModels(modelsLoadedMsg{options: []modelOption{
		{provider: "anthropic", model: "claude-opus-4-8"},
		{provider: "openai", model: "gpt-4o"},
	}})
	if m.car.list.Len() != 2 {
		t.Fatalf("expected both models offered, got %d", m.car.list.Len())
	}

	m = typing(m, "gpt") // the carousel owns typing while it's open — this filters, not the prompt
	if m.input.Value() != "" {
		t.Errorf("keystrokes must not leak into the prompt while the carousel is open, got %q", m.input.Value())
	}
	applied, cmd := m.onKey(tea.KeyMsg{Type: tea.KeyEnter})
	m = applied.(Model)
	if cmd == nil {
		t.Fatal("enter should apply the switch")
	}
	cmd()
	if got["agentId"] != "a" || got["provider"] != "openai" || got["model"] != "gpt-4o" {
		t.Errorf("unexpected switch posted: %v", got)
	}
	if m.car.open {
		t.Error("the carousel should close once a model is chosen")
	}
}

// With more than one agent the carousel asks who first, and esc closes it without switching.
func TestCarouselPicksAnAgentFirstAndEscCloses(t *testing.T) {
	m := model(3)
	opened, _ := m.onKey(tea.KeyMsg{Type: tea.KeyCtrlP})
	m = opened.(Model)
	if m.car.stage != "agent" || m.car.list.Len() != 3 {
		t.Fatalf("expected an agent list of 3, stage=%q len=%d", m.car.stage, m.car.list.Len())
	}
	closed, _ := m.onKey(tea.KeyMsg{Type: tea.KeyEsc})
	m = closed.(Model)
	if m.car.open {
		t.Error("esc should close the carousel")
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

// The suggestion menu and the carousel overlay must respect the terminal like everything else —
// the overlay rewrites whole rows, so an off-by-one here is a corrupted screen, not a stray line.
func TestMenuAndCarouselStayInsideTheTerminal(t *testing.T) {
	for _, size := range []struct{ w, h int }{{120, 40}, {80, 24}, {60, 16}, {40, 10}} {
		base := model(3)
		base.commands = []api.Command{{Name: "model", Description: "switch a model"}, {Name: "undo", Description: "revert"}}
		base.menu.Set(base.menuItems())
		sized, _ := base.Update(tea.WindowSizeMsg{Width: size.w, Height: size.h})
		base = sized.(Model)

		withMenu := typing(base, "/")
		opened, _ := base.onKey(tea.KeyMsg{Type: tea.KeyCtrlP})
		withCarousel := opened.(Model)
		withCarousel.setCarouselModels(modelsLoadedMsg{options: []modelOption{{provider: "anthropic", model: "claude-opus-4-8"}}})

		for name, m := range map[string]Model{"menu": withMenu, "carousel": withCarousel} {
			out := m.View()
			if got := lipgloss.Width(out); got > size.w {
				t.Errorf("%s at %dx%d is %d columns wide", name, size.w, size.h, got)
			}
			if got := lipgloss.Height(out); got > size.h {
				t.Errorf("%s at %dx%d is %d rows tall", name, size.w, size.h, got)
			}
		}
	}
}
