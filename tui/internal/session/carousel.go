package session

import (
	"strings"

	"github.com/amux/tui/internal/api"
	"github.com/amux/tui/internal/theme"
	"github.com/amux/tui/internal/ui"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// The carousel is the ctrl+p model switcher: a popup in the middle of the screen that picks a
// teammate, then a model for it. It replaces having to type `/model <agentId> <provider/model>`
// from memory — the same thing opencode's model dialog does, and the reason the slash command
// still exists is scripting, not daily use.

type modelOption struct{ provider, model string }

// modelsLoadedMsg carries the flat provider/model catalog the carousel offers, gathered once when
// it first opens (it can't change while the process runs — the credential set is read at startup).
type modelsLoadedMsg struct {
	options []modelOption
	err     error
}

type carousel struct {
	open    bool
	stage   string // "agent" | "model"
	list    ui.List
	models  []ui.Item // the fetched catalog, held until the model stage is reached
	query   string
	agentID string
	byValue map[string]modelOption
	loading bool
	status  string
}

// fetchSwitchableModels lists every model on a provider that already has a credential — switching
// to one without a key would only fail at the next call, so those aren't offered. Any other model
// id remains reachable by typing it (see carousel.confirm).
func fetchSwitchableModels(client *api.Client) tea.Cmd {
	return func() tea.Msg {
		creds, err := client.Credentials()
		if err != nil {
			return modelsLoadedMsg{err: err}
		}
		var options []modelOption
		seen := map[string]bool{}
		for _, c := range creds {
			if seen[c.Provider] {
				continue
			}
			seen[c.Provider] = true
			models, err := client.Models(c.Provider)
			if err != nil {
				continue // one provider's catalog failing shouldn't empty the whole list
			}
			for _, m := range models {
				options = append(options, modelOption{provider: c.Provider, model: m})
			}
		}
		return modelsLoadedMsg{options: options}
	}
}

// openCarousel starts at the agent list, which is already in memory, and kicks off the model fetch
// in the background so the catalog is usually there by the time an agent has been chosen.
func (m *Model) openCarousel() tea.Cmd {
	m.car = carousel{open: true, stage: "agent", loading: true}
	items := make([]ui.Item, 0, len(m.order))
	for _, id := range m.order {
		st := m.agents[id]
		items = append(items, ui.Item{
			Label: st.cfg.Role,
			Value: id,
			Desc:  st.cfg.Provider + "/" + st.cfg.Model,
			Tag:   st.avatar,
		})
	}
	m.car.list.Set(items)
	if len(items) == 1 {
		m.car.agentID = items[0].Value // a solo team has nothing to choose — go straight to models
		m.car.stage = "model"
	}
	return fetchSwitchableModels(m.client)
}

func (m *Model) setCarouselModels(msg modelsLoadedMsg) {
	m.car.loading = false
	m.car.byValue = map[string]modelOption{}
	items := make([]ui.Item, 0, len(msg.options))
	for _, o := range msg.options {
		v := o.provider + "/" + o.model
		if _, dup := m.car.byValue[v]; dup {
			continue
		}
		m.car.byValue[v] = o
		items = append(items, ui.Item{Label: o.model, Value: v, Desc: o.provider})
	}
	if msg.err != nil {
		m.car.status = "could not list models: " + msg.err.Error()
	}
	if m.car.stage == "model" {
		m.car.list.Set(items)
		m.car.list.SetQuery(m.car.query)
	}
	m.car.models = items
}

// carouselKey handles every keystroke while the popup is open. It returns a command when the
// keystroke did something asynchronous (applying a switch), and swallows everything else so the
// prompt underneath never sees it.
func (m *Model) carouselKey(k tea.KeyMsg) tea.Cmd {
	switch k.String() {
	case "esc", "ctrl+p":
		m.car = carousel{}
		return nil
	case "up", "shift+tab":
		m.car.list.Move(-1)
		return nil
	case "down", "tab":
		m.car.list.Move(1)
		return nil
	case "backspace":
		if r := []rune(m.car.query); len(r) > 0 {
			m.car.query = string(r[:len(r)-1])
			m.car.list.SetQuery(m.car.query)
		}
		return nil
	case "enter":
		return m.carouselConfirm()
	}
	if s := k.String(); len([]rune(s)) == 1 || s == " " {
		m.car.query += s
		m.car.list.SetQuery(m.car.query)
	}
	return nil
}

func (m *Model) carouselConfirm() tea.Cmd {
	sel, ok := m.car.list.Selected()
	switch m.car.stage {
	case "agent":
		if !ok {
			return nil
		}
		m.car.agentID = sel.Value
		m.car.stage = "model"
		m.car.query = ""
		m.car.list.Set(m.car.models)
		return nil
	case "model":
		// The highlighted row, or — when nothing matches what was typed — the typed text itself,
		// so a model the catalog doesn't list is still reachable from here.
		value := strings.TrimSpace(m.car.query)
		if ok {
			value = sel.Value
		}
		if value == "" {
			return nil
		}
		opt, known := m.car.byValue[value]
		if !known {
			provider, model, found := strings.Cut(value, "/")
			if !found {
				m.car.status = "type a model as provider/model"
				return nil
			}
			opt = modelOption{provider: provider, model: model}
		}
		agentID, client := m.car.agentID, m.client
		m.car = carousel{}
		m.status = agentID + " → " + opt.provider + "/" + opt.model
		return func() tea.Msg {
			return actionResultMsg{action: "model switch", err: client.SwitchModel(agentID, opt.provider, opt.model, "")}
		}
	}
	return nil
}

// carouselView renders the popup body; view.go floats it over the middle of the screen. The box is
// sized to the catalog it's showing — three models get a three-row box, not a twelve-row one with
// nine rows of nothing under them.
func (m Model) carouselView(w, h int) string {
	rows := m.car.list.Rows(clamp(h-10, 4, 14))
	title, hint := "SWITCH MODEL — pick a teammate", "↑↓ choose · enter confirms · esc cancels"
	if m.car.stage == "model" {
		st := m.agents[m.car.agentID]
		who := m.car.agentID
		if st != nil {
			who = st.cfg.Role
		}
		title = "SWITCH MODEL — " + who
		hint = "↑↓ choose · type to filter · esc cancels"
		if m.car.loading {
			hint = "loading models… · esc cancels"
		}
	}
	if m.car.status != "" {
		hint = m.car.status + "\n" + hint
	}
	boxW := clamp(max(m.car.list.NaturalWidth(), widest(title, hint, m.car.query))+6, 34, max(w-6, 34))
	body := m.car.list.Render(boxW-4, rows, theme.BgPane)
	if m.car.query != "" {
		body = txt(theme.Green, theme.BgPane).Render("  /"+m.car.query) + "\n" + body
	}
	return ui.Box(title, body, hint, boxW)
}

// widest is the display width of the longest of these lines — how every popup here decides how much
// of the terminal it actually needs.
func widest(lines ...string) int {
	n := 0
	for _, l := range lines {
		for _, part := range strings.Split(l, "\n") {
			n = max(n, lipgloss.Width(part))
		}
	}
	return n
}
