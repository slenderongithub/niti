package wizard

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/amux/tui/internal/api"
	"github.com/charmbracelet/lipgloss"
)

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
	next, _ := NewPicker(client).Update(providersMsg{
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
