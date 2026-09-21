package session

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/niti/tui/internal/api"
	"github.com/niti/tui/internal/theme"
)

// State models behind the Status and Config tabs. Pure data in, rows out, so they can be tested
// without rendering; settings.go only paints them.

func newSessionID() string {
	b := make([]byte, 4)
	rand.Read(b)
	return hex.EncodeToString(b)
}

type row struct{ Key, Val string }

// statusRows is the Status tab's key-value block. creds is nil until GET /auth has answered.
func (m Model) statusRows(creds []api.Credential) []row {
	mcp := "none connected"
	if len(m.mcp) > 0 {
		mcp = fmt.Sprintf("%d connected", len(m.mcp))
	}
	lead := "—"
	for _, id := range m.order {
		if st := m.agents[id]; st.cfg.Lead || lead == "—" {
			lead = st.cfg.Provider + "/" + st.cfg.Model
		}
	}
	return []row{
		{"Version", version},
		{"Session name", filepath.Base(m.root)},
		{"Session ID", m.sid},
		{"Session kind", "interactive"},
		{"cwd", m.root},
		{"Login method", loginMethod(creds)},
		{"Account / Org", "n/a — your own provider keys"},
		{"Model", lead},
		{"MCP servers", mcp},
		{"Settings sources", settingsSources(m.root)},
	}
}

// loginMethod summarises the stored credentials by auth type: "API key (anthropic, openai)".
func loginMethod(creds []api.Credential) string {
	if len(creds) == 0 {
		return "none stored"
	}
	label := map[string]string{"api": "API key", "oauth": "OAuth", "local": "local endpoint"}
	by := map[string][]string{}
	for _, c := range creds {
		by[c.Type] = append(by[c.Type], c.Provider)
	}
	var parts []string
	for t, ps := range by {
		l := label[t]
		if l == "" {
			l = t
		}
		sort.Strings(ps)
		parts = append(parts, fmt.Sprintf("%s (%s)", l, strings.Join(ps, ", ")))
	}
	sort.Strings(parts)
	return strings.Join(parts, " · ")
}

func settingsSources(root string) string {
	auth := os.Getenv("NITI_AUTH_FILE")
	if auth == "" {
		if home, err := os.UserHomeDir(); err == nil {
			auth = filepath.Join(home, ".config", "niti", "auth.json")
		}
	}
	proj := filepath.Join(root, ".niti", "agents.yaml")
	mark := func(p string) string {
		if _, err := os.Stat(p); err != nil {
			return p + " (missing)"
		}
		return p
	}
	return "global " + mark(auth) + " · project " + mark(proj)
}

// cfgItem is one row of the Config tab; enter/space flips it.
type cfgItem struct {
	Label, Value, Hint string
}

// prefRows are the boolean preferences the core stores for the TUI (agents.yaml, via POST
// /settings). Order here is the row order in the Config tab.
var prefRows = []struct{ Label, Key, Hint string }{
	{"Light mode", "lightMode", "swap the palette for a light background"},
	{"Reduce motion", "reduceMotion", "hold the spinner still and stop animation ticks"},
	{"Show turn duration", "showTurnDuration", "append how long each tool call took"},
	{"Open agents view by default", "openAgentsView", "start on the lead agent's tab, not the overview (next launch)"},
	{"Project instructions", "projectInstructions", "read .niti.md / AGENTS.md into every agent's prompt (next launch)"},
}

func (m Model) configItems() []cfgItem {
	items := []cfgItem{
		{"Mode", m.mode, "build ⇄ plan"},
		{"Theme", theme.Current(), "cycles the installed themes"},
		{"Default permission mode", permMode(m.autoApprove), "manual asks before writes and shell; auto approves all but dangerous commands"},
		{"Collapse tool calls", fmt.Sprint(!m.verbose), "false lists every call separately"},
		{"Auto-compact", fmt.Sprint(m.autoCompact), "summarize old turns at 95% of the context window"},
		{"Thinking mode", fmt.Sprint(m.thinkingMode), "send reasoning parameters to models that support them"},
	}
	for _, p := range prefRows {
		items = append(items, cfgItem{p.Label, fmt.Sprint(m.prefs[p.Key]), p.Hint})
	}
	return items
}

// filterItems keeps rows whose label or value contains q, case-insensitively.
func filterItems(items []cfgItem, q string) []cfgItem {
	q = strings.ToLower(strings.TrimSpace(q))
	if q == "" {
		return items
	}
	var out []cfgItem
	for _, it := range items {
		if strings.Contains(strings.ToLower(it.Label+" "+it.Value), q) {
			out = append(out, it)
		}
	}
	return out
}

// toggle flips the setting called label and returns any command needed to persist it.
func (m *Model) toggle(label string) tea.Cmd {
	switch label {
	case "Mode":
		m.mode = map[string]string{"build": "plan", "plan": "build"}[m.mode]
	case "Theme":
		name, client := theme.Next(), m.client
		return func() tea.Msg { return actionResultMsg{action: "theme", err: client.SetTheme(name)} }
	case "Default permission mode":
		m.autoApprove = !m.autoApprove
		on, client := m.autoApprove, m.client
		return func() tea.Msg { return actionResultMsg{action: "auto", err: client.SetAuto(on)} }
	case "Auto-compact", "Thinking mode":
		key, field := "autoCompact", &m.autoCompact
		if label == "Thinking mode" {
			key, field = "thinkingMode", &m.thinkingMode
		}
		*field = !*field
		on, client := *field, m.client
		return func() tea.Msg { return actionResultMsg{action: key, err: client.SetSetting(key, on)} }
	case "Light mode", "Reduce motion", "Show turn duration", "Open agents view by default", "Project instructions":
		return m.togglePref(label)
	case "Collapse tool calls":
		m.verbose = !m.verbose
		for _, st := range m.agents {
			st.verbose = m.verbose
		}
	}
	return nil
}

type credsMsg struct {
	creds []api.Credential
	err   error
}

func fetchCreds(client *api.Client) tea.Cmd {
	return func() tea.Msg {
		c, err := client.Credentials()
		return credsMsg{c, err}
	}
}

func permMode(auto bool) string {
	if auto {
		return "Auto"
	}
	return "Manual"
}

// togglePref flips one prefRows entry, applies its live effect, and persists it through the core.
func (m *Model) togglePref(label string) tea.Cmd {
	for _, p := range prefRows {
		if p.Label != label {
			continue
		}
		if m.prefs == nil {
			m.prefs = map[string]bool{}
		}
		on := !m.prefs[p.Key]
		m.prefs[p.Key] = on
		switch p.Key {
		case "lightMode":
			theme.SetLight(on)
		case "showTurnDuration":
			for _, st := range m.agents {
				st.showDur = on
			}
		}
		key, client := p.Key, m.client
		return func() tea.Msg { return actionResultMsg{action: key, err: client.SetSetting(key, on)} }
	}
	return nil
}
