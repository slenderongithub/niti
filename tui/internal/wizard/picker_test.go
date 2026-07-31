package wizard

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/amux/tui/internal/api"
)

func TestResolveByNumber(t *testing.T) {
	opts := []string{"anthropic", "google", "openai"}
	if got := resolveByNumber("2", opts); got != "google" {
		t.Errorf("resolveByNumber(2) = %q, want google", got)
	}
	if got := resolveByNumber("openai", opts); got != "openai" {
		t.Errorf("a typed id should pass through, got %q", got)
	}
	if got := resolveByNumber("99", opts); got != "99" {
		t.Errorf("an out-of-range number falls back to the typed text, got %q", got)
	}
	if got := resolveByNumber("", opts); got != "" {
		t.Errorf("empty input should resolve to empty, got %q", got)
	}
}

// A fake core server: /agents records what was saved so the test can assert on it.
func fakeCore(t *testing.T) (*api.Client, func() []api.AgentConfig) {
	var saved []api.AgentConfig
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/agents":
			var body struct {
				Agents []api.AgentConfig `json:"agents"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			saved = body.Agents
			json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		default:
			json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		}
	}))
	t.Cleanup(srv.Close)
	return api.New(srv.URL, "tok"), func() []api.AgentConfig { return saved }
}

func TestPickerAddsOneModelAndFinishesAlone(t *testing.T) {
	client, saved := fakeCore(t)
	m := Picker{client: client, usedIDs: map[string]bool{}, providers: []string{"anthropic"}, stage: "provider"}

	next, _ := m.advance("1") // pick provider by number
	m = next.(Picker)
	if m.stage != "loading" || m.provider != "anthropic" {
		t.Fatalf("expected to move to loading for anthropic, got stage=%s provider=%s", m.stage, m.provider)
	}
	updated, _ := m.Update(modelsMsg{models: []string{"claude-opus-4-8"}})
	m = updated.(Picker)

	next, _ = m.advance("1") // pick model by number
	m = next.(Picker)
	if m.stage != "role" || m.pendModel != "claude-opus-4-8" {
		t.Fatalf("expected role stage with model set, got stage=%s model=%s", m.stage, m.pendModel)
	}

	next, _ = m.advance("Architect")
	m = next.(Picker)
	if len(m.roles) != 1 || m.roles[0].Role != "Architect" {
		t.Fatalf("expected one role named Architect, got %+v", m.roles)
	}
	if m.stage != "again" {
		t.Fatalf("expected the again prompt after adding a role, got %s", m.stage)
	}

	// A single agent skips the orchestrator prompt and leads by default.
	next, _ = m.advance("1") // "start building"
	m = next.(Picker)
	if !m.Completed || !m.quitting {
		t.Fatalf("expected completion with one agent, got completed=%v quitting=%v", m.Completed, m.quitting)
	}
	if got := saved(); len(got) != 1 || !got[0].Lead {
		t.Fatalf("expected the sole agent saved as lead, got %+v", got)
	}
}

func TestPickerCapsAtMaxAgentsAndAsksForOrchestrator(t *testing.T) {
	client, saved := fakeCore(t)

	// Hitting the cap via the real path: add MaxAgents-1 roles through addRole, then the next "role"
	// submission must skip the "again" loop and go straight to picking an orchestrator.
	m2 := Picker{client: client, usedIDs: map[string]bool{}, stage: "role", provider: "anthropic", pendModel: "m"}
	for i := 0; i < MaxAgents-1; i++ {
		m2.addRole("anthropic", "m", "role")
	}
	next2, _ := m2.advance("last one")
	m2 = next2.(Picker)
	if len(m2.roles) != MaxAgents {
		t.Fatalf("expected %d roles, got %d", MaxAgents, len(m2.roles))
	}
	if m2.stage != "orchestrator" {
		t.Fatalf("expected the orchestrator prompt once MaxAgents is reached, got stage=%s", m2.stage)
	}

	next3, _ := m2.advance("2")
	m2 = next3.(Picker)
	if !m2.Completed {
		t.Fatal("expected the picker to finish after choosing an orchestrator")
	}
	got := saved()
	if len(got) != MaxAgents {
		t.Fatalf("expected %d agents saved, got %d", MaxAgents, len(got))
	}
	if !got[1].Lead {
		t.Fatalf("expected agent index 1 to be marked lead, got %+v", got)
	}
}

func TestPickerLoopsBackToProviderOnAddAnother(t *testing.T) {
	client, _ := fakeCore(t)
	m := Picker{client: client, usedIDs: map[string]bool{}, providers: []string{"anthropic"}, stage: "again"}
	m.roles = append(m.roles, api.AgentConfig{ID: "a", Provider: "anthropic", Model: "m", Role: "role"})

	next, _ := m.advance("2") // "add another model"
	m = next.(Picker)
	if m.stage != "provider" {
		t.Fatalf("expected to loop back to provider selection, got %s", m.stage)
	}
	if m.Completed {
		t.Fatal("must not finish when the user chose to add another model")
	}
}
