package wizard

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/amux/tui/internal/api"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// MaxAgents must match the web dashboard's pixel-avatar palette (web/avatar.js's AVATAR_COLORS) —
// a team size the avatar system can't give a distinct color, so bumping one without the other
// silently reuses a color for two teammates.
func TestMaxAgentsMatchesAvatarPaletteSize(t *testing.T) {
	if MaxAgents != 6 {
		t.Errorf("MaxAgents is %d, want 6 to match web/avatar.js's AVATAR_COLORS (blue/yellow/red/purple/green/pink)", MaxAgents)
	}
}

// A fake core server: /agents and /auth record what was posted so tests can assert on them.
func fakeCore(t *testing.T) (client *api.Client, saved func() []api.AgentConfig, authed func() []string) {
	var savedAgents []api.AgentConfig
	var savedAuth []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/agents" && r.Method == "POST":
			var body struct {
				Agents []api.AgentConfig `json:"agents"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			savedAgents = body.Agents
			json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		case r.URL.Path == "/auth" && r.Method == "POST":
			var cred map[string]string
			json.NewDecoder(r.Body).Decode(&cred)
			savedAuth = append(savedAuth, cred["provider"])
			json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		default:
			json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		}
	}))
	t.Cleanup(srv.Close)
	return api.New(srv.URL, "tok"),
		func() []api.AgentConfig { return savedAgents },
		func() []string { return savedAuth }
}

// loaded returns a Picker sitting on the team-size prompt with one credentialed provider
// (anthropic) and one that still needs a key (openai) — the two paths every test below exercises.
func loaded(t *testing.T, client *api.Client) Picker {
	t.Helper()
	next, _ := NewPicker(client, nil).Update(providersMsg{
		creds: []api.Credential{{Provider: "anthropic", Type: "api"}},
		providers: []api.ProviderInfo{
			{ID: "openai", Label: "OpenAI", Category: "byok"},
			{ID: "anthropic", Label: "Anthropic", Category: "byok"},
		},
	})
	m := next.(Picker)
	if m.stage != "size" {
		t.Fatalf("expected the size prompt once the catalog loads, got %q", m.stage)
	}
	return m
}

// step submits the highlighted list row (or `val` on a free-text stage) and returns the new state.
func step(t *testing.T, m Picker, val string) Picker {
	t.Helper()
	next, _ := m.advance(val)
	return next.(Picker)
}

func TestPickerBuildsASoloTeammateWithADescription(t *testing.T) {
	client, saved, _ := fakeCore(t)
	m := loaded(t, client)

	m = step(t, m, "") // 1 teammate (cursor starts on the first row)
	if m.teamSize != 1 || m.stage != "provider" {
		t.Fatalf("expected a team of 1 and the provider prompt, got size=%d stage=%s", m.teamSize, m.stage)
	}
	// Credentialed providers are listed first, so the highlighted row is anthropic — not openai,
	// which came first from the server.
	m = step(t, m, "")
	if m.provider != "anthropic" || m.stage != "loading" {
		t.Fatalf("expected anthropic to be picked and models to load, got provider=%s stage=%s", m.provider, m.stage)
	}

	upd, _ := m.Update(modelsMsg{models: []string{"claude-opus-4-8", "claude-sonnet-5"}})
	m = upd.(Picker)
	m = step(t, m, "") // first model
	if m.pendModel != "claude-opus-4-8" || m.stage != "role" {
		t.Fatalf("expected the first model and the role prompt, got model=%s stage=%s", m.pendModel, m.stage)
	}

	m = step(t, m, "Architect")
	if m.stage != "desc" {
		t.Fatalf("expected the description prompt after naming a role, got %s", m.stage)
	}
	m = step(t, m, "Owns the API surface.")

	if !m.Completed {
		t.Fatalf("a team of one should finish after its description, stage=%s", m.stage)
	}
	got := saved()
	if len(got) != 1 || !got[0].Lead {
		t.Fatalf("expected one agent saved as lead, got %+v", got)
	}
	if !strings.Contains(got[0].SystemPrompt, "Owns the API surface.") {
		t.Errorf("the description should carry into the system prompt, got %q", got[0].SystemPrompt)
	}
	if got[0].Provider != "anthropic" || got[0].Model != "claude-opus-4-8" || got[0].ID != "architect" {
		t.Errorf("unexpected agent: %+v", got[0])
	}
}

func TestPickerAsksForAKeyWhenTheProviderHasNone(t *testing.T) {
	client, _, authed := fakeCore(t)
	m := loaded(t, client)
	m = step(t, m, "") // 1 teammate
	m.list.Move(1)     // second provider row: openai, which has no stored credential
	m = step(t, m, "") //
	if m.stage != "key" || m.provider != "openai" {
		t.Fatalf("expected the key prompt for openai, got stage=%s provider=%s", m.stage, m.provider)
	}
	m = step(t, m, "sk-test-123")
	if m.stage != "loading" {
		t.Fatalf("expected models to load once the key is saved, got %s", m.stage)
	}
	if got := authed(); len(got) != 1 || got[0] != "openai" {
		t.Fatalf("expected the openai credential to be posted, got %v", got)
	}
	if !m.creds["openai"] {
		t.Error("the provider should be marked as credentialed after a successful save")
	}
}

func TestPickerLoopsOncePerTeammateThenPicksAnOrchestrator(t *testing.T) {
	client, saved, _ := fakeCore(t)
	m := loaded(t, client)
	m.list.Move(1) // 2 teammates
	m = step(t, m, "")

	for i := 0; i < 2; i++ {
		m = step(t, m, "") // anthropic
		upd, _ := m.Update(modelsMsg{models: []string{"claude-opus-4-8"}})
		m = upd.(Picker)
		m = step(t, m, "")         // model
		m = step(t, m, "Engineer") // role — the same name twice, on purpose
		m = step(t, m, "builds things")
		if i == 0 && m.stage != "provider" {
			t.Fatalf("expected the loop to return to the provider prompt for teammate 2, got %s", m.stage)
		}
	}
	if m.stage != "orchestrator" {
		t.Fatalf("expected the orchestrator prompt once the team is full, got %s", m.stage)
	}

	m.list.Move(1) // hand the lead to the second teammate
	m = step(t, m, "")
	got := saved()
	if len(got) != 2 {
		t.Fatalf("expected 2 agents saved, got %d", len(got))
	}
	if got[0].ID == got[1].ID {
		t.Errorf("duplicate role names must still produce distinct ids, got %q twice", got[0].ID)
	}
	if got[0].Lead || !got[1].Lead {
		t.Errorf("expected the second agent to lead, got %+v", got)
	}
}

func TestPickerEscapeStepsBackAndUndoesTheLastTeammate(t *testing.T) {
	client, _, _ := fakeCore(t)
	m := loaded(t, client)
	m.list.Move(1) // 2 teammates
	m = step(t, m, "")
	m = step(t, m, "") // anthropic
	upd, _ := m.Update(modelsMsg{models: []string{"claude-opus-4-8"}})
	m = upd.(Picker)
	m = step(t, m, "")
	m = step(t, m, "Architect")
	m = step(t, m, "owns the api") // teammate 1 done, back on the provider prompt

	if len(m.roles) != 1 {
		t.Fatalf("expected one teammate configured, got %d", len(m.roles))
	}
	back, _ := m.back()
	m = back.(Picker)
	if len(m.roles) != 0 || m.stage != "provider" {
		t.Fatalf("esc on the provider prompt should undo the previous teammate, got %d roles stage=%s", len(m.roles), m.stage)
	}
	if m.usedIDs["architect"] {
		t.Error("undoing a teammate should release its id for reuse")
	}
}

func TestSanitize(t *testing.T) {
	cases := map[string]string{
		"Frontend Designer": "frontend-designer",
		"  API   Owner  ":   "api-owner",
		"!!!":               "agent", // no alphanumerics at all still needs a usable id
	}
	for in, want := range cases {
		if got := sanitize(in); got != want {
			t.Errorf("sanitize(%q) = %q, want %q", in, got, want)
		}
	}
}

// Every stage of the picker renders as a card inside the terminal, at any size worth supporting.
func TestPickerViewFitsTheTerminal(t *testing.T) {
	client, _, _ := fakeCore(t)
	base := loaded(t, client)
	base.roles = []api.AgentConfig{{ID: "a", Role: "Architect", Provider: "anthropic", Model: "m"}}
	base.pendRole, base.pendModel, base.provider = "Architect", "claude-opus-4-8", "anthropic"

	for _, stage := range []string{"size", "provider", "key", "model", "role", "desc", "orchestrator", "loading", "error"} {
		for _, size := range []struct{ w, h int }{{120, 40}, {80, 24}, {50, 14}} {
			m := base
			m.stage, m.width, m.height = stage, size.w, size.h
			out := m.View()
			if got := lipgloss.Width(out); got > size.w {
				t.Errorf("stage %q at %dx%d is %d columns wide", stage, size.w, size.h, got)
			}
			if got := lipgloss.Height(out); got > size.h {
				t.Errorf("stage %q at %dx%d is %d rows tall", stage, size.w, size.h, got)
			}
		}
	}
}

// The card is sized to what it holds, in both directions. Before this it was drawn at a fixed
// width and a fixed ten rows, so a three-model catalog sat in a box with seven empty rows under it
// — and the box collapsed to a sane size only once a keystroke filtered the list.
func TestCardIsSizedToItsContent(t *testing.T) {
	client, _, _ := fakeCore(t)
	m := loaded(t, client)
	updated, _ := m.Update(tea.WindowSizeMsg{Width: 160, Height: 44})
	m = updated.(Picker)

	tall := cardRows(m.View())
	// Typing "1" narrows five options to one; the card must lose the four rows it no longer needs.
	m.input.SetValue("1")
	m.list.SetQuery("1")
	short := cardRows(m.View())
	if short >= tall {
		t.Errorf("a one-option card is %d rows, a five-option one %d — it must shrink", short, tall)
	}

	// And it never claims the whole terminal: the card is centered content, not a full-width bar.
	for _, line := range strings.Split(m.View(), "\n") {
		if strings.Contains(line, "╭") && lipgloss.Width(strings.TrimSpace(line)) > cardMax+2 {
			t.Errorf("the card is %d columns wide on a 160-column terminal", lipgloss.Width(strings.TrimSpace(line)))
		}
	}
}

// The card must not be blown out to full width by the prompt behind it — the textinput is sized to
// the card, which is why an untyped placeholder no longer stretches the box across the screen.
func TestPlaceholderDoesNotWidenTheCard(t *testing.T) {
	client, _, _ := fakeCore(t)
	m := loaded(t, client)
	updated, _ := m.Update(tea.WindowSizeMsg{Width: 200, Height: 44})
	m = updated.(Picker)

	empty := cardRule(t, m.View())
	m.input.SetValue("1")
	m.list.SetQuery("1")
	typed := cardRule(t, m.View())
	if empty != typed {
		t.Errorf("the card is %d wide empty and %d wide after a keystroke — width must not depend on typing", empty, typed)
	}
}

// cardRows is how many rows the card body occupies inside the centered screen.
func cardRows(view string) int {
	n := 0
	for _, line := range strings.Split(view, "\n") {
		if strings.Contains(line, "│") {
			n++
		}
	}
	return n
}

// cardRule is the width of the card's top border.
func cardRule(t *testing.T, view string) int {
	t.Helper()
	for _, line := range strings.Split(view, "\n") {
		if strings.Contains(line, "╭") {
			return lipgloss.Width(strings.TrimSpace(line))
		}
	}
	t.Fatal("no card in the view")
	return 0
}

// A saved roster must be reusable in one keystroke. Before this, the picker opened on the size
// question every launch — 26 answers for a team of 6 — and ctrl+c out of it quit amux entirely.
func withExisting(t *testing.T, client *api.Client) Picker {
	t.Helper()
	existing := []api.AgentConfig{{ID: "fe", Provider: "anthropic", Model: "claude", Role: "Frontend"}}
	next, _ := NewPicker(client, existing).Update(providersMsg{
		creds:     []api.Credential{{Provider: "anthropic", Type: "api"}},
		providers: []api.ProviderInfo{{ID: "anthropic", Label: "Anthropic", Category: "byok"}},
	})
	m := next.(Picker)
	if m.stage != "team" {
		t.Fatalf("expected the keep-or-repick prompt with a saved roster, got %q", m.stage)
	}
	return m
}

func TestEnterKeepsTheSavedTeamWithoutRewritingTheConfig(t *testing.T) {
	client, saved, _ := fakeCore(t)
	m := step(t, withExisting(t, client), "")

	if !m.Completed || !m.Kept {
		t.Fatalf("expected the saved team to be kept, got Completed=%v Kept=%v", m.Completed, m.Kept)
	}
	if len(m.roles) != 1 || m.roles[0].ID != "fe" {
		t.Fatalf("expected the existing roster to carry through, got %+v", m.roles)
	}
	if got := saved(); len(got) != 0 {
		t.Fatalf("keeping the team must not POST /agents, but it saved %+v", got)
	}
}

func TestChoosingANewTeamFallsThroughToTheSizePrompt(t *testing.T) {
	client, _, _ := fakeCore(t)
	m := withExisting(t, client)
	m.list.Move(1) // "Pick a new team"
	next := step(t, m, "")
	if next.stage != "size" {
		t.Fatalf("expected the size prompt after choosing a new team, got %q", next.stage)
	}
	if next.Completed {
		t.Fatal("picking a new team should not finish the picker")
	}
}

func TestBackingOutOfTheKeepPromptKeepsRatherThanQuitting(t *testing.T) {
	client, _, _ := fakeCore(t)
	next, _ := withExisting(t, client).back()
	m := next.(Picker)
	if !m.Completed || !m.Kept {
		t.Fatalf("esc on the keep prompt should keep the team, got Completed=%v Kept=%v", m.Completed, m.Kept)
	}
}
