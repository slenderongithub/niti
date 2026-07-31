// Picker is the every-launch model/role selection flow: pick a model + designation from providers
// that already have a key stored, optionally add up to MaxAgents, then hand off to the session.
// Unlike Model (the first-run onboarding wizard, which also collects API keys), Picker assumes
// credentials already exist — it runs on every `./amux`, not just the first one, because a static
// agents.yaml stops being useful the moment you want to try a different model without hand-editing
// YAML.
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

const MaxAgents = 5

type providersMsg struct {
	creds []api.Credential
	err   error
}

type modelsMsg struct {
	models []string
	err    error
}

type Picker struct {
	client    *api.Client
	input     textinput.Model
	stage     string // loading | provider | model | role | again | orchestrator | error
	status    string
	err       string
	providers []string // provider ids with a stored credential
	models    []string // catalog models for the currently chosen provider
	provider  string
	pendModel string
	roles     []api.AgentConfig
	usedIDs   map[string]bool
	Completed bool
	quitting  bool
	width     int
	height    int
}

func NewPicker(client *api.Client) Picker {
	ti := textinput.New()
	ti.Focus()
	ti.CharLimit = 200
	ti.Prompt = "" // the frame draws its own ▸
	return Picker{client: client, input: ti, stage: "loading", usedIDs: map[string]bool{}}
}

func (m Picker) Init() tea.Cmd {
	return tea.Batch(textinput.Blink, fetchCredentials(m.client))
}

func fetchCredentials(client *api.Client) tea.Cmd {
	return func() tea.Msg {
		creds, err := client.Credentials()
		return providersMsg{creds: creds, err: err}
	}
}

func fetchModels(client *api.Client, provider string) tea.Cmd {
	return func() tea.Msg {
		models, err := client.Models(provider)
		return modelsMsg{models: models, err: err}
	}
}

func (m Picker) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.input.Width = msg.Width - 5
		return m, nil

	case providersMsg:
		if msg.err != nil {
			m.stage, m.err = "error", "could not load credentials: "+msg.err.Error()
			return m, nil
		}
		seen := map[string]bool{}
		for _, c := range msg.creds {
			if !seen[c.Provider] {
				seen[c.Provider] = true
				m.providers = append(m.providers, c.Provider)
			}
		}
		if len(m.providers) == 0 {
			m.stage, m.err = "error", "no providers configured — run 'amux-core auth login <provider>' first"
			return m, nil
		}
		m.stage = "provider"
		m.input.Placeholder = "provider number, or type an id"
		return m, nil

	case modelsMsg:
		m.models = msg.models // an error or an empty catalog just means "type your own model id" below
		m.stage = "model"
		m.input.Placeholder = "model number, or type a model id"
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

func (m Picker) advance(val string) (tea.Model, tea.Cmd) {
	m.status = ""
	m.input.SetValue("")
	switch m.stage {
	case "provider":
		provider := resolveByNumber(val, m.providers)
		if provider == "" {
			m.status = "unknown provider — pick a number from the list, or type its id"
			return m, nil
		}
		m.provider = provider
		m.models = nil
		m.stage = "loading"
		return m, fetchModels(m.client, provider)

	case "model":
		model := val
		if n, err := strconv.Atoi(val); err == nil && n >= 1 && n <= len(m.models) {
			model = m.models[n-1]
		}
		if model == "" {
			m.status = "enter a model number or id"
			return m, nil
		}
		m.pendModel = model
		m.stage = "role"
		m.input.Placeholder = "designation for this model (e.g. Frontend Designer)"
		return m, nil

	case "role":
		role := val
		if role == "" {
			role = "Engineer"
		}
		m.addRole(m.provider, m.pendModel, role)
		m.status = fmt.Sprintf("✓ %s → %s/%s", role, m.provider, m.pendModel)
		if len(m.roles) >= MaxAgents {
			return m.toOrchestratorOrFinish()
		}
		m.stage = "again"
		m.input.Placeholder = fmt.Sprintf("[1] start building   [2] choose another model (%d/%d)", len(m.roles), MaxAgents)
		return m, nil

	case "again":
		if val == "2" || strings.HasPrefix(strings.ToLower(val), "a") { // "add"/"another"
			m.stage = "provider"
			m.input.Placeholder = "provider number, or type an id"
			return m, nil
		}
		return m.toOrchestratorOrFinish()

	case "orchestrator":
		idx, _ := strconv.Atoi(val)
		if idx < 1 || idx > len(m.roles) {
			idx = 1
		}
		for i := range m.roles {
			m.roles[i].Lead = i == idx-1
		}
		return m.finish()
	}
	return m, nil
}

// Once the model/role loop ends (user chose "start building", or the MaxAgents cap was hit): a
// single agent needs no orchestrator prompt (it leads by default); more than one asks which leads.
func (m Picker) toOrchestratorOrFinish() (tea.Model, tea.Cmd) {
	if len(m.roles) == 0 {
		m.status = "add at least one model first"
		m.stage = "provider"
		return m, nil
	}
	if len(m.roles) == 1 {
		m.roles[0].Lead = true
		return m.finish()
	}
	m.stage = "orchestrator"
	m.input.Placeholder = fmt.Sprintf("orchestrator number 1-%d (looks over everything)", len(m.roles))
	return m, nil
}

func (m Picker) finish() (tea.Model, tea.Cmd) {
	if err := m.client.SaveAgents(m.roles); err != nil {
		m.status = "save error: " + err.Error()
		return m, nil
	}
	m.Completed = true
	m.quitting = true
	return m, tea.Quit
}

func (m *Picker) addRole(provider, model, role string) {
	id := sanitize(role)
	for m.usedIDs[id] {
		id += "-2"
	}
	m.usedIDs[id] = true
	m.roles = append(m.roles, api.AgentConfig{
		ID: id, Provider: provider, Model: model, Role: role,
		SystemPrompt: fmt.Sprintf("You are the %s. Implement your assigned tasks directly and keep responses concise.", role),
		AllowedTools: []string{"read_file", "write_file", "edit", "shell"},
	})
}

func resolveByNumber(val string, options []string) string {
	if n, err := strconv.Atoi(val); err == nil && n >= 1 && n <= len(options) {
		return options[n-1]
	}
	for _, o := range options {
		if o == val {
			return val // a typed id outside the credentialed list is still accepted — the server validates it
		}
	}
	if val != "" {
		return val
	}
	return ""
}

func (m Picker) View() string {
	if m.quitting {
		if m.Completed {
			return lipgloss.NewStyle().Foreground(theme.Green).Render("\n✓ launching amux…\n")
		}
		return "\ncancelled.\n"
	}
	var prompt, hint string
	switch m.stage {
	case "loading":
		prompt = "loading…"
	case "error":
		return frame(m.width, m.height, "pick your team",
			lipgloss.NewStyle().Foreground(theme.Amber).Background(theme.BgPane).Render(m.err), "")
	case "provider":
		prompt = renderRoles(m.roles) + "\n\n" + numberedList(m.providers)
		hint = "pick a provider — number, or type its id"
	case "model":
		prompt = numberedList(m.models)
		hint = "pick a model — number, or type an id directly"
	case "role":
		prompt = section("MODEL") + "\n  " + m.provider + "/" + m.pendModel
		hint = "what is this agent's designation? (e.g. Architect, Backend Designer)"
	case "again":
		prompt = renderRoles(m.roles)
		hint = fmt.Sprintf("[1] start building    [2] choose another model    (%d/%d)", len(m.roles), MaxAgents)
	case "orchestrator":
		prompt = renderRoles(m.roles)
		hint = "which one looks over everything and decides the chronology?"
	}
	if m.status != "" {
		hint = m.status + "\n" + hint
	}
	return frame(m.width, m.height, "pick your team", prompt, hint) + inputRow(m.width, m.input.View())
}

func numberedList(items []string) string {
	if len(items) == 0 {
		return lipgloss.NewStyle().Foreground(theme.Line).Background(theme.BgPane).Render("  (type a value directly)")
	}
	var lines []string
	for i, it := range items {
		lines = append(lines, lipgloss.NewStyle().Foreground(theme.Muted).Background(theme.BgPane).
			Render(fmt.Sprintf("  %d. ", i+1))+
			lipgloss.NewStyle().Foreground(theme.Fg).Background(theme.BgPane).Render(it))
	}
	return strings.Join(lines, "\n")
}
