// Picker is the every-launch team selection flow: choose how many teammates you want (1–5), then
// for each one pick a provider and model from the full catalog, name it, and say what it does.
// Unlike Model (the first-run onboarding wizard) it doesn't insist on collecting credentials up
// front — a provider without a stored key simply asks for one at the moment you choose it, which
// is why the whole catalog can be offered here rather than only the providers already set up.
package wizard

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/amux/tui/internal/api"
	"github.com/amux/tui/internal/theme"
	"github.com/amux/tui/internal/ui"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

const MaxAgents = 5

type providersMsg struct {
	creds     []api.Credential
	providers []api.ProviderInfo
	err       error
}

type modelsMsg struct {
	models []string
	err    error
}

type Picker struct {
	client    *api.Client
	input     textinput.Model
	list      ui.List
	stage     string // loading | size | provider | key | model | role | desc | orchestrator | error
	status    string
	err       string
	creds     map[string]bool    // provider id → a credential is already stored
	providers []api.ProviderInfo // the whole catalog, credentialed ones first
	models    []string           // catalog models for the currently chosen provider
	teamSize  int                // how many teammates the user asked for
	provider  string
	pendModel string
	pendRole  string
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
	ti.Prompt = "" // the card draws its own ▸
	return Picker{client: client, input: ti, stage: "loading", usedIDs: map[string]bool{}, creds: map[string]bool{}}
}

func (m Picker) Init() tea.Cmd {
	return tea.Batch(textinput.Blink, fetchCatalog(m.client))
}

// One command for both halves of "what can I pick": the provider catalog and which of those
// already have a key. Either failing alone isn't fatal — an empty catalog still lets you type an
// id, and an unreadable credential list just means nothing is marked as ready.
func fetchCatalog(client *api.Client) tea.Cmd {
	return func() tea.Msg {
		providers, err := client.AllProviders()
		creds, credErr := client.Credentials()
		if err == nil && credErr != nil {
			err = credErr
		}
		return providersMsg{creds: creds, providers: providers, err: err}
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
		m.width, m.height = msg.Width, msg.Height // View() sizes the input to the card, not the terminal
		return m, nil

	case providersMsg:
		if len(msg.providers) == 0 {
			m.stage, m.err = "error", "could not load the provider catalog: "+errText(msg.err)
			return m, nil
		}
		for _, c := range msg.creds {
			m.creds[c.Provider] = true
		}
		m.providers = sortProviders(msg.providers, m.creds)
		m.toSize()
		return m, nil

	case modelsMsg:
		m.models = msg.models // an error or an empty catalog just means "type your own model id"
		m.toModel()
		return m, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c":
			m.quitting = true
			return m, tea.Quit
		case "up", "ctrl+p", "shift+tab":
			m.list.Move(-1)
			return m, nil
		case "down", "ctrl+n", "tab":
			m.list.Move(1)
			return m, nil
		case "esc":
			return m.back()
		case "enter":
			return m.advance(strings.TrimSpace(m.input.Value()))
		}
	}
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	if m.listStage() {
		m.list.SetQuery(m.input.Value()) // typing narrows the list instead of being read literally
	}
	return m, cmd
}

func (m Picker) listStage() bool {
	switch m.stage {
	case "size", "provider", "model", "orchestrator":
		return true
	}
	return false
}

// choice is what enter means on a list stage: the highlighted row, or — when the typed text
// matches nothing — the text itself, so a model id missing from the catalog is still reachable.
func (m Picker) choice(typed string) string {
	if it, ok := m.list.Selected(); ok {
		return it.Value
	}
	return typed
}

func (m Picker) advance(val string) (tea.Model, tea.Cmd) {
	m.status = ""
	pick := m.choice(val)
	m.input.SetValue("")

	switch m.stage {
	case "size":
		n, err := strconv.Atoi(pick)
		if err != nil || n < 1 || n > MaxAgents {
			m.status = fmt.Sprintf("pick a number from 1 to %d", MaxAgents)
			return m, nil
		}
		m.teamSize = n
		m.toProvider()
		return m, nil

	case "provider":
		if pick == "" {
			m.status = "pick a provider"
			return m, nil
		}
		m.provider = pick
		if !m.creds[pick] {
			// Chosen but not set up: collect the key here rather than sending the user back to a
			// separate onboarding run just because they picked something new.
			m.stage = "key"
			m.list.Set(nil)
			m.input.Placeholder = "API key for " + pick + " (or a base URL for a local endpoint)"
			return m, nil
		}
		m.models = nil
		m.stage = "loading"
		return m, fetchModels(m.client, pick)

	case "key":
		if val == "" {
			m.status = "a key (or base URL) is needed to use " + m.provider
			return m, nil
		}
		cred := map[string]string{"provider": m.provider, "type": "api", "key": val}
		if strings.HasPrefix(val, "http") {
			cred = map[string]string{"provider": m.provider, "type": "local", "baseURL": val}
		}
		if err := m.client.SaveAuth(cred); err != nil {
			m.status = "auth error: " + err.Error()
			return m, nil
		}
		m.creds[m.provider] = true
		m.status = "✓ saved " + m.provider
		m.models = nil
		m.stage = "loading"
		return m, fetchModels(m.client, m.provider)

	case "model":
		if pick == "" {
			m.status = "pick a model, or type an id"
			return m, nil
		}
		m.pendModel = pick
		m.stage = "role"
		m.list.Set(nil)
		m.input.Placeholder = "designation (e.g. Frontend Designer)"
		return m, nil

	case "role":
		m.pendRole = val
		if m.pendRole == "" {
			m.pendRole = fmt.Sprintf("Engineer %d", len(m.roles)+1)
		}
		m.stage = "desc"
		m.input.Placeholder = "what does " + m.pendRole + " do? (enter to skip)"
		return m, nil

	case "desc":
		m.addRole(m.provider, m.pendModel, m.pendRole, val)
		m.status = fmt.Sprintf("✓ %s → %s/%s", m.pendRole, m.provider, m.pendModel)
		if len(m.roles) >= m.teamSize {
			return m.toOrchestratorOrFinish()
		}
		m.toProvider()
		return m, nil

	case "orchestrator":
		idx, _ := strconv.Atoi(pick)
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

// back steps one prompt at a time. A five-member setup is twenty answers deep — without this, one
// mistyped model id means starting the whole thing over.
func (m Picker) back() (tea.Model, tea.Cmd) {
	m.status = ""
	m.input.SetValue("")
	switch m.stage {
	case "provider":
		if len(m.roles) > 0 { // undo the last completed teammate rather than re-picking the size
			last := m.roles[len(m.roles)-1]
			delete(m.usedIDs, last.ID)
			m.roles = m.roles[:len(m.roles)-1]
			m.toProvider()
			return m, nil
		}
		m.toSize()
	case "key", "model":
		m.toProvider()
	case "role":
		m.toModel()
	case "desc":
		m.stage = "role"
		m.input.Placeholder = "designation (e.g. Frontend Designer)"
	case "orchestrator":
		if len(m.roles) > 0 {
			last := m.roles[len(m.roles)-1]
			delete(m.usedIDs, last.ID)
			m.roles = m.roles[:len(m.roles)-1]
		}
		m.toProvider()
	}
	return m, nil
}

func (m *Picker) toSize() {
	m.stage = "size"
	items := make([]ui.Item, 0, MaxAgents)
	for i := 1; i <= MaxAgents; i++ {
		label := fmt.Sprintf("%d teammate", i)
		if i > 1 {
			label += "s"
		}
		items = append(items, ui.Item{Label: label, Value: strconv.Itoa(i), Desc: teamHint(i)})
	}
	m.list.Set(items)
	m.input.Placeholder = "how big is the team?"
}

func teamHint(n int) string {
	switch n {
	case 1:
		return "solo — one model does everything"
	case 2:
		return "a lead and a builder"
	default:
		return fmt.Sprintf("%d models working in parallel", n)
	}
}

func (m *Picker) toProvider() {
	m.stage = "provider"
	items := make([]ui.Item, 0, len(m.providers))
	for _, p := range m.providers {
		tag, desc := "○", p.Category
		if m.creds[p.ID] {
			tag, desc = "✓", p.Category+" · key stored"
		}
		items = append(items, ui.Item{Label: p.Label, Value: p.ID, Desc: desc, Tag: tag})
	}
	m.list.Set(items)
	m.input.Placeholder = fmt.Sprintf("teammate %d of %d — filter providers…", len(m.roles)+1, m.teamSize)
}

func (m *Picker) toModel() {
	m.stage = "model"
	items := make([]ui.Item, 0, len(m.models))
	for _, mo := range m.models {
		items = append(items, ui.Item{Label: mo, Value: mo})
	}
	m.list.Set(items)
	m.input.Placeholder = "filter models, or type any model id"
}

// Once every teammate is configured: a single agent needs no orchestrator prompt (it leads by
// default); more than one asks which one looks over the rest.
func (m Picker) toOrchestratorOrFinish() (tea.Model, tea.Cmd) {
	if len(m.roles) == 0 {
		m.status = "add at least one model first"
		m.toProvider()
		return m, nil
	}
	if len(m.roles) == 1 {
		m.roles[0].Lead = true
		return m.finish()
	}
	m.stage = "orchestrator"
	items := make([]ui.Item, 0, len(m.roles))
	for i, r := range m.roles {
		items = append(items, ui.Item{Label: r.Role, Value: strconv.Itoa(i + 1), Desc: r.Provider + "/" + r.Model})
	}
	m.list.Set(items)
	m.input.Placeholder = "who looks over everything?"
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

func (m *Picker) addRole(provider, model, role, desc string) {
	id := sanitize(role)
	for m.usedIDs[id] {
		id += "-2"
	}
	m.usedIDs[id] = true
	m.roles = append(m.roles, api.AgentConfig{
		ID: id, Provider: provider, Model: model, Role: role,
		SystemPrompt: systemPrompt(role, desc),
		AllowedTools: []string{"read_file", "write_file", "edit", "shell"},
	})
}

// The user's own description of the teammate is the most valuable half of its system prompt — it's
// the only part that says what this agent is for on this project — so it goes in verbatim.
func systemPrompt(role, desc string) string {
	p := fmt.Sprintf("You are the %s.", role)
	if desc = strings.TrimSpace(desc); desc != "" {
		p += " " + desc
	}
	return p + " Implement your assigned tasks directly and keep responses concise."
}

// Credentialed providers first (they're one keystroke from usable), then the rest of the catalog in
// the order the server sent it — byok, local, login.
func sortProviders(all []api.ProviderInfo, creds map[string]bool) []api.ProviderInfo {
	ready, rest := []api.ProviderInfo{}, []api.ProviderInfo{}
	for _, p := range all {
		if creds[p.ID] {
			ready = append(ready, p)
		} else {
			rest = append(rest, p)
		}
	}
	return append(ready, rest...)
}

// sanitize turns a human role name into an agent id: lowercase, alphanumerics, single dashes.
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
	if out := strings.Trim(b.String(), "-"); out != "" {
		return out
	}
	return "agent" // a role name with no alphanumerics at all still needs a usable id
}

func renderRoles(roles []api.AgentConfig) string {
	bg := theme.BgPane
	if len(roles) == 0 {
		return section("TEAM") + "\n" + lipgloss.NewStyle().Foreground(theme.Line).Background(bg).Render("  (nobody yet)")
	}
	parts := []string{section("TEAM")}
	for i, r := range roles {
		lead := ""
		if r.Lead {
			lead = lipgloss.NewStyle().Foreground(theme.Alt).Background(bg).Render(" ★")
		}
		parts = append(parts,
			lipgloss.NewStyle().Foreground(theme.Muted).Background(bg).Render(fmt.Sprintf("  %d. ", i+1))+
				lipgloss.NewStyle().Foreground(theme.AgentColor(i)).Background(bg).Bold(true).Render(r.Role)+
				lipgloss.NewStyle().Foreground(theme.Muted).Background(bg).Render("  "+r.Provider+"/"+r.Model)+lead)
	}
	return strings.Join(parts, "\n")
}

func errText(err error) string {
	if err == nil {
		return "empty catalog"
	}
	return err.Error()
}

func (m Picker) View() string {
	if m.quitting {
		if m.Completed {
			return lipgloss.NewStyle().Foreground(theme.Green).Render("\n✓ launching amux…\n")
		}
		return "\ncancelled.\n"
	}
	if m.stage == "error" {
		return screen(m.width, m.height, "pick your team", fit(m.width, widest(m.err)),
			lipgloss.NewStyle().Foreground(theme.Amber).Background(theme.BgPane).Render(m.err), "", "")
	}
	if m.stage == "loading" {
		return screen(m.width, m.height, "pick your team", cardMin, "loading…", "", "")
	}

	// Two passes: work out how wide the card wants to be from the text that will go in it, then draw
	// the list into exactly that width. Otherwise a three-model catalog gets a card sized for forty.
	head, hint, fixed := m.stageText()
	roles := ""
	if m.stage == "provider" {
		roles = renderRoles(m.roles)
	}
	cardW := fit(m.width, widest(head, hint, fixed, roles, m.input.Placeholder)+2, m.list.NaturalWidth())
	inner := cardW - 2

	listRows := m.list.Rows(clamp(m.height-14, 3, 14))
	body := head
	switch {
	case fixed != "":
		body += "\n  " + fixed
	case m.listStage():
		body += "\n" + m.list.Render(inner, listRows, theme.BgPane)
	}
	if roles != "" {
		body = roles + "\n\n" + body
	}
	if m.status != "" {
		hint = m.status + "\n" + hint
	}
	// The prompt is the last line of the card, so it gets the card's width and no more — a textinput
	// sized to the terminal is what used to blow the card out to full width before anything was typed.
	m.input.Width = max(inner-2, 8)
	return screen(m.width, m.height, "pick your team", cardW, body, hint, m.input.View())
}

// stageText is the per-stage copy: the section heading, the hint under the body, and — for the
// stages that show a value instead of a list — that value.
func (m Picker) stageText() (head, hint, fixed string) {
	switch m.stage {
	case "size":
		return section("HOW MANY"), "↑↓ choose · enter confirms — each teammate gets its own model", ""
	case "provider":
		return section("PROVIDER"), "↑↓ choose · type to filter · esc goes back", ""
	case "key":
		return section("PROVIDER"), "paste the API key (or a local base URL) — stored outside the repo", m.provider
	case "model":
		return section(strings.ToUpper(m.provider)), "↑↓ choose · type any model id the catalog doesn't list", ""
	case "role":
		return section("MODEL"), "what is this teammate called? (e.g. Architect, Backend Designer)", m.provider + "/" + m.pendModel
	case "desc":
		return section(strings.ToUpper(m.pendRole)), "describe its job — it becomes this agent's system prompt", m.provider + "/" + m.pendModel
	case "orchestrator":
		return section("ORCHESTRATOR"), "which one looks over everything and decides the chronology?", ""
	}
	return "", "", ""
}
