package session

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

// /api: pick the team's provider, type the key masked, enter saves it to the core — and the key is
// never on screen or left in memory afterwards.
func TestAPICommandReplacesAProvidersKey(t *testing.T) {
	m := sized(1, 120, 30)
	client, calls := fakeCore(t)
	m.client = client
	provider := m.agents[m.order[0]].cfg.Provider

	m.input.SetValue("/api")
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(Model)
	if !m.akp.open || !strings.Contains(ansi.Strip(m.View()), provider) {
		t.Fatalf("/api should open on the team's provider %q:\n%s", provider, ansi.Strip(m.View()))
	}

	press := func(k tea.KeyMsg) tea.Cmd {
		next, cmd := m.Update(k)
		m = next.(Model)
		return cmd
	}
	press(tea.KeyMsg{Type: tea.KeyEnter}) // choose the provider
	press(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("sk-new-secret"), Paste: true})
	if strings.Contains(ansi.Strip(m.View()), "sk-new-secret") {
		t.Fatal("the key must be masked while typed")
	}
	cmd := press(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("enter should save the key")
	}
	next, _ = m.Update(cmd())
	m = next.(Model)

	if len(*calls) != 1 || !strings.Contains((*calls)[0], "/auth") || !strings.Contains((*calls)[0], `"key":"sk-new-secret"`) || !strings.Contains((*calls)[0], `"provider":"`+provider+`"`) {
		t.Fatalf("expected one POST /auth with the key, got %v", *calls)
	}
	if m.akp.open || m.akp.input.Value() != "" || !strings.Contains(m.status, provider+" key saved") {
		t.Errorf("the overlay should close, drop the key and confirm: open=%v status=%q", m.akp.open, m.status)
	}
}

func TestKeyErrorsPointAtAPI(t *testing.T) {
	for payload, want := range map[string]bool{
		"google: 400 API key not valid. Please pass a valid API key.": true,
		"openai: 401 Unauthorized":                                    true,
		"Retryable HTTP Error: Too Many Requests":                     false,
	} {
		if got := strings.Contains(humanize("error", payload), "/api"); got != want {
			t.Errorf("%q: /api hint %v, want %v", payload, got, want)
		}
	}
}
