// Package wizard is the first-run onboarding flow: add provider credentials, assign models to
// custom roles, and pick the orchestrator — then persist to .amux/agents.yaml via the core.
package wizard

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/amux/tui/internal/api"
	"github.com/amux/tui/internal/theme"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type Model struct {
	client           *api.Client
	input            textinput.Model
	stage            string // welcome | provider | key | roleModel | roleName | roleTools | orchestrator
	status           string
	provider         string
	pendModel        string
	pendRole         string
	roles            []api.AgentConfig
	usedIDs          map[string]bool
	credentialsAdded int // count of successful SaveAuth calls — gates "add at least one provider"
	Completed        bool
	quitting         bool
	width            int
}

func New(client *api.Client) Model {
	ti := textinput.New()
	ti.Focus()
	ti.CharLimit = 200
	return Model{client: client, input: ti, stage: "welcome", usedIDs: map[string]bool{}}
}

func (m Model) Init() tea.Cmd { return textinput.Blink }

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.input.Width = msg.Width - 4
		return m, nil
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c":
			m.quitting = true
			return m, tea.Quit
		case "enter":
			return m.advance(strings.TrimSpace(m.input.Value()))
		}
	}
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return m, cmd
}

func (m Model) advance(val string) (tea.Model, tea.Cmd) {
	m.status = ""
	m.input.SetValue("")
	switch m.stage {
	case "welcome":
		m.stage = "provider"
		m.input.Placeholder = "provider id (openai, anthropic, google, github-copilot) — or 'done'"
	case "provider":
		if val == "done" || val == "" {
			if m.credentialsAdded == 0 {
				m.status = "add at least one provider first"
				return m, nil
			}
			m.stage = "roleModel"
			m.input.Placeholder = "model as provider/model (e.g. anthropic/claude-opus-4-8)"
			return m, nil
		}
		m.provider = val
		m.stage = "key"
		m.input.Placeholder = fmt.Sprintf("API key for %s (or a base URL for a local endpoint)", val)
	case "key":
		cred := map[string]string{"provider": m.provider, "type": "api", "key": val}
		if strings.HasPrefix(val, "http") {
			cred = map[string]string{"provider": m.provider, "type": "local", "baseURL": val}
		}
		if err := m.client.SaveAuth(cred); err != nil {
			m.status = "auth error: " + err.Error()
		} else {
			m.status = "✓ saved " + m.provider
			m.credentialsAdded++
		}
		m.stage = "provider"
		m.input.Placeholder = "another provider id — or 'done'"
	case "roleModel":
		if val == "done" {
			if len(m.roles) == 0 {
				m.status = "assign at least one role"
				return m, nil
			}
			m.stage = "orchestrator"
			m.input.Placeholder = fmt.Sprintf("orchestrator number 1-%d (looks over everything)", len(m.roles))
			return m, nil
		}
		if !validModelID(val) {
			m.status = "use provider/model (both non-empty, e.g. anthropic/claude-opus-4-8)"
			return m, nil
		}
		m.pendModel = val
		m.stage = "roleName"
		m.input.Placeholder = "role name (e.g. Frontend Designer)"
	case "roleName":
		m.pendRole = val
		if m.pendRole == "" {
			m.pendRole = "Engineer"
		}
		m.stage = "roleTools"
		m.input.Placeholder = "allowed tools [read_file,write_file,shell]"
	case "roleTools":
		tools := val
		if tools == "" {
			tools = "read_file,write_file,shell"
		}
		m.addRole(m.pendModel, m.pendRole, tools)
		m.status = "✓ " + m.pendRole
		m.stage = "roleModel"
		m.input.Placeholder = "another model/role — or 'done'"
	case "orchestrator":
		idx, _ := strconv.Atoi(val)
		if idx < 1 || idx > len(m.roles) {
			idx = 1
		}
		for i := range m.roles {
			m.roles[i].Lead = i == idx-1
		}
		if err := m.client.SaveAgents(m.roles); err != nil {
			m.status = "save error: " + err.Error()
			return m, nil
		}
		m.Completed = true
		m.quitting = true
		return m, tea.Quit
	}
	return m, nil
}

// validModelID requires a single '/' with non-empty text on both sides — "/opus" and "anthropic/"
// pass a bare Contains("/") check but would produce a broken agent config (empty provider or model).
func validModelID(s string) bool {
	slash := strings.Index(s, "/")
	return slash > 0 && slash < len(s)-1
}

func (m *Model) addRole(modelID, role, tools string) {
	if !validModelID(modelID) {
		return // guarded upstream (roleModel stage); defensive no-op if ever called otherwise
	}
	slash := strings.Index(modelID, "/")
	provider, model := modelID[:slash], modelID[slash+1:]
	id := sanitize(role)
	for m.usedIDs[id] {
		id += "-2"
	}
	m.usedIDs[id] = true
	var toolList []string
	for _, t := range strings.Split(tools, ",") {
		if t = strings.TrimSpace(t); t != "" {
			toolList = append(toolList, t)
		}
	}
	m.roles = append(m.roles, api.AgentConfig{ID: id, Provider: provider, Model: model, Role: role, AllowedTools: toolList})
}

func sanitize(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	prevDash := false
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			prevDash = false
		} else if !prevDash {
			b.WriteRune('-')
			prevDash = true
		}
	}
	return strings.Trim(b.String(), "-")
}

func (m Model) View() string {
	if m.quitting {
		if m.Completed {
			return lipgloss.NewStyle().Foreground(theme.Green).Render("\n✓ setup complete — launching amux…\n")
		}
		return "\ncancelled.\n"
	}
	title := lipgloss.NewStyle().Foreground(theme.Violet).Bold(true).Render("amux setup")
	var prompt string
	switch m.stage {
	case "welcome":
		prompt = "Assign different models to custom roles and watch them build together.\nPress enter to begin."
	case "provider":
		prompt = "Add a provider. Type its id, then its API key. Type 'done' when finished."
	case "key":
		prompt = "Paste the API key (or a local base URL)."
	case "roleModel":
		prompt = renderRoles(m.roles) + "\nAssign a model to a role (provider/model), or 'done'."
	case "roleName":
		prompt = "Name this role — e.g. \"Frontend Designer\", \"Backend Engineer\"."
	case "roleTools":
		prompt = "Which tools may it use?"
	case "orchestrator":
		prompt = renderRoles(m.roles) + "\nWhich model looks over everything and decides the chronology?"
	}
	status := ""
	if m.status != "" {
		status = "\n" + lipgloss.NewStyle().Foreground(theme.Amber).Render(m.status)
	}
	return fmt.Sprintf("\n%s\n\n%s\n\n%s %s%s\n",
		title,
		lipgloss.NewStyle().Foreground(theme.Muted).Render(prompt),
		lipgloss.NewStyle().Foreground(theme.Green).Render("▸"),
		m.input.View(),
		status)
}

func renderRoles(roles []api.AgentConfig) string {
	if len(roles) == 0 {
		return lipgloss.NewStyle().Foreground(theme.Line).Render("(no roles yet)")
	}
	var parts []string
	for i, r := range roles {
		parts = append(parts, fmt.Sprintf("%d. %s → %s/%s", i+1, r.Role, r.Provider, r.Model))
	}
	return lipgloss.NewStyle().Foreground(theme.Muted).Render(strings.Join(parts, "\n"))
}
