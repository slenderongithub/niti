package session

import (
	"sort"
	"strings"

	"github.com/niti/tui/internal/api"
	"github.com/niti/tui/internal/theme"
	"github.com/niti/tui/internal/ui"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
)

// /api replaces a provider's API key without leaving the session. A mistyped or revoked key used to
// mean every call failing until the user quit, found ~/.config/niti/auth.json and restarted. Pick
// the provider, paste the key (masked), and the core rebuilds every agent on that provider with it.

type apiKeyPicker struct {
	open     bool
	stage    string // "provider" | "key"
	list     ui.List
	input    textinput.Model
	provider string
	status   string
	saving   bool
}

type apiCredsMsg struct{ creds []api.Credential }

type apiKeySavedMsg struct {
	provider string
	agents   []string
	err      error
}

// openAPIKey lists the team's providers first (the key at fault is almost always one of them), then
// any other provider with a saved key.
func (m *Model) openAPIKey() tea.Cmd {
	m.akp = apiKeyPicker{open: true, stage: "provider"}
	m.akp.list.Set(m.apiKeyItems(nil))
	c := m.client
	return func() tea.Msg {
		creds, _ := c.Credentials() // a failure only loses the "key saved" marks
		return apiCredsMsg{creds}
	}
}

func (m Model) apiKeyItems(creds []api.Credential) []ui.Item {
	saved := map[string]bool{}
	for _, c := range creds {
		saved[c.Provider] = c.Type == "api"
	}
	users := map[string][]string{}
	var order []string
	for _, id := range m.order {
		p := m.agents[id].cfg.Provider
		if users[p] == nil {
			order = append(order, p)
		}
		users[p] = append(users[p], m.agents[id].cfg.Role)
	}
	var others []string
	for p := range saved {
		if users[p] == nil {
			others = append(others, p)
		}
	}
	sort.Strings(others)
	var items []ui.Item
	for _, p := range append(order, others...) {
		desc := "not on the team"
		if u := users[p]; u != nil {
			desc = "used by " + strings.Join(u, ", ")
		}
		if saved[p] {
			desc += " · key saved"
		}
		items = append(items, ui.Item{Label: p, Value: p, Desc: desc})
	}
	return items
}

func (m *Model) apiKeyKey(k tea.KeyMsg) tea.Cmd {
	if m.akp.saving {
		return nil
	}
	if m.akp.stage == "provider" {
		switch k.String() {
		case "esc":
			m.akp = apiKeyPicker{}
		case "up", "shift+tab":
			m.akp.list.Move(-1)
		case "down", "tab":
			m.akp.list.Move(1)
		case "enter":
			if sel, ok := m.akp.list.Selected(); ok {
				in := textinput.New()
				in.EchoMode = textinput.EchoPassword // over someone's shoulder or in a screen share
				in.EchoCharacter = '•'
				in.Placeholder = "paste the new key"
				in.Prompt = "▸ "
				in.Focus()
				m.akp.stage, m.akp.provider, m.akp.input, m.akp.status = "key", sel.Value, in, ""
			}
		}
		return nil
	}
	switch k.String() {
	case "esc":
		m.akp.stage, m.akp.status = "provider", ""
		return nil
	case "enter":
		key := strings.TrimSpace(m.akp.input.Value())
		if key == "" {
			m.akp.status = "paste the key first"
			return nil
		}
		m.akp.saving, m.akp.status = true, "saving…"
		c, p := m.client, m.akp.provider
		return func() tea.Msg {
			agents, err := c.SetAPIKey(p, key)
			return apiKeySavedMsg{provider: p, agents: agents, err: err}
		}
	}
	var cmd tea.Cmd
	m.akp.input, cmd = m.akp.input.Update(k)
	return cmd
}

// apiKeySaved closes the overlay (dropping the typed key with it) and says who uses the new key.
func (m *Model) apiKeySaved(msg apiKeySavedMsg) {
	if msg.err != nil {
		m.akp.saving, m.akp.status = false, "not saved: "+msg.err.Error()
		return
	}
	m.akp = apiKeyPicker{}
	var roles []string
	for _, id := range msg.agents {
		if st := m.agents[id]; st != nil {
			roles = append(roles, st.cfg.Role)
		}
	}
	m.status = msg.provider + " key saved"
	if len(roles) > 0 {
		m.status += " — " + strings.Join(roles, ", ") + " use it from the next call"
	}
}

func (m Model) apiKeyView(w, h int) string {
	boxW := clamp(max(m.akp.list.NaturalWidth()+6, 56), 30, max(w-6, 30))
	if m.akp.stage == "provider" {
		rows := m.akp.list.Rows(clamp(h-8, 3, 12))
		return ui.Box("Change API key", m.akp.list.Render(boxW-4, rows, theme.BgPane), "↑↓ choose · enter select · esc cancel", boxW)
	}
	in := m.akp.input
	in.Width = boxW - 8
	lines := []string{
		txt(theme.Fg, theme.BgPane).Render("New key for ") + txt(theme.Accent, theme.BgPane).Bold(true).Render(m.akp.provider),
		"",
		in.View(),
	}
	if m.akp.status != "" {
		lines = append(lines, "", txt(theme.Amber, theme.BgPane).Render(m.akp.status))
	}
	return ui.Box("Change API key", strings.Join(lines, "\n"), "enter save · esc back", boxW)
}
