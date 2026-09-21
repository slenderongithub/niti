package session

import (
	"encoding/json"
	tea "github.com/charmbracelet/bubbletea"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
	"github.com/niti/tui/internal/api"
	"github.com/niti/tui/internal/theme"
)

func TestStatusRowsCoverTheSpec(t *testing.T) {
	m := Model{root: "/work/niti", sid: "ab12cd34", mode: "build", agents: map[string]*agentState{}}
	got := map[string]string{}
	for _, r := range m.statusRows([]api.Credential{{Provider: "openai", Type: "api"}, {Provider: "anthropic", Type: "api"}}) {
		got[r.Key] = r.Val
	}
	for _, k := range []string{"Version", "Session name", "Session ID", "Session kind", "cwd", "Login method", "Account / Org", "Model", "MCP servers", "Settings sources"} {
		if got[k] == "" {
			t.Errorf("missing status row %q", k)
		}
	}
	if got["Session name"] != "niti" || got["Login method"] != "API key (anthropic, openai)" {
		t.Errorf("wrong values: %v", got)
	}
}

func TestFilterItems(t *testing.T) {
	m := Model{mode: "build"}
	items := m.configItems()
	if got := filterItems(items, "compact"); len(got) != 1 || got[0].Label != "Auto-compact" {
		t.Fatalf("got %v", got)
	}
	if len(filterItems(items, "")) != len(items) || len(filterItems(items, "zzz")) != 0 {
		t.Fatal("empty query keeps all, nonsense keeps none")
	}
}

func TestToggleFlipsSettings(t *testing.T) {
	a := &agentState{}
	m := &Model{mode: "build", agents: map[string]*agentState{"a": a}}
	m.toggle("Mode")
	m.toggle("Collapse tool calls")
	if m.mode != "plan" || !m.verbose || !a.verbose {
		t.Fatalf("mode=%s verbose=%v agent=%v", m.mode, m.verbose, a.verbose)
	}
	for _, it := range m.configItems() {
		if it.Label == "Collapse tool calls" && it.Value != "false" {
			t.Fatalf("collapse row should read false once verbose, got %s", it.Value)
		}
	}
	if !strings.Contains(loginMethod(nil), "none") {
		t.Fatal("no creds should say so")
	}
}

func key(m *Model, s string) {
	switch s {
	case "esc":
		m.settingsKey(tea.KeyMsg{Type: tea.KeyEsc})
	case "space":
		m.settingsKey(tea.KeyMsg{Type: tea.KeySpace})
	default:
		m.settingsKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(s)})
	}
}

func TestSettingsKeys(t *testing.T) {
	m := &Model{mode: "build", agents: map[string]*agentState{}, sett: settings{open: true}}
	key(m, "3") // number key jumps to Config
	if m.sett.tab != 2 {
		t.Fatalf("tab = %d", m.sett.tab)
	}
	key(m, "m")
	key(m, "o")
	key(m, "d") // typing filters instead of navigating or closing
	if m.sett.query != "mod" || !m.sett.open {
		t.Fatalf("query=%q open=%v", m.sett.query, m.sett.open)
	}
	key(m, "space") // toggles the one match: Mode
	if m.mode != "plan" {
		t.Fatalf("mode = %s", m.mode)
	}
	key(m, "esc") // first esc clears the search
	if m.sett.query != "" || !m.sett.open {
		t.Fatal("esc should clear the query and stay open")
	}
	key(m, "5")
	key(m, "q") // q closes off the Config tab
	if m.sett.open {
		t.Fatal("q should close")
	}
}

func TestOpenSettingsByCommandName(t *testing.T) {
	m := Model{}.OpenSettings("config")
	if !m.sett.open || m.sett.tab != 2 {
		t.Fatalf("%+v", m.sett)
	}
	if (Model{}).OpenSettings("bogus").sett.open {
		t.Fatal("unknown name must not open the overlay")
	}
}

func TestToggleSendsCoreSettings(t *testing.T) {
	got := map[string]bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/settings" && r.Method == "POST" {
			json.NewDecoder(r.Body).Decode(&got)
		}
		w.Write([]byte("{}"))
	}))
	defer srv.Close()
	m := &Model{autoCompact: true, thinkingMode: true, client: api.New(srv.URL, "")}
	for _, label := range []string{"Auto-compact", "Thinking mode"} {
		cmd := m.toggle(label)
		if res := cmd().(actionResultMsg); res.err != nil {
			t.Fatal(res.err)
		}
	}
	if m.autoCompact || m.thinkingMode || got["autoCompact"] != false || got["thinkingMode"] != false {
		t.Fatalf("model=%v/%v sent=%v", m.autoCompact, m.thinkingMode, got)
	}
	for _, it := range m.configItems() {
		if (it.Label == "Auto-compact" || it.Label == "Thinking mode") && it.Value != "false" {
			t.Fatalf("rows should read false: %v", m.configItems())
		}
	}
}

func TestLightModeToggleSwitchesPaletteAndPersists(t *testing.T) {
	got := map[string]bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/settings" && r.Method == "POST" {
			json.NewDecoder(r.Body).Decode(&got)
		}
		w.Write([]byte("{}"))
	}))
	defer srv.Close()
	defer theme.SetLight(false)
	m := &Model{client: api.New(srv.URL, "")}
	if res := m.toggle("Light mode")().(actionResultMsg); res.err != nil {
		t.Fatal(res.err)
	}
	if !m.prefs["lightMode"] || !theme.IsLight() || got["lightMode"] != true {
		t.Fatalf("model=%v theme=%v sent=%v", m.prefs["lightMode"], theme.IsLight(), got)
	}
}

// The Status rows once ran the value straight into the widest key ("Settings sources" filled its
// whole 16-cell column), so the red key and yellow value read as one word.
func TestKVLeavesAGapAfterTheLongestKey(t *testing.T) {
	plain := ansi.Strip(kv(80, "Settings sources", "global x"))
	if !strings.Contains(plain, "Settings sources    global x") {
		t.Fatalf("key and value collide: %q", plain)
	}
}

// Every preference row must round-trip: toggling flips the model, and the change is what gets sent.
func TestPrefRowsToggleAndPersist(t *testing.T) {
	got := map[string]bool{}
	autoSent := map[string]bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/settings":
			json.NewDecoder(r.Body).Decode(&got)
		case "/auto":
			json.NewDecoder(r.Body).Decode(&autoSent)
		}
		w.Write([]byte("{}"))
	}))
	defer srv.Close()
	defer theme.SetLight(false)
	a := &agentState{}
	m := &Model{client: api.New(srv.URL, ""), agents: map[string]*agentState{"a": a}}
	for _, p := range prefRows {
		got = map[string]bool{}
		if res := m.toggle(p.Label)().(actionResultMsg); res.err != nil {
			t.Fatal(p.Label, res.err)
		}
		if !m.prefs[p.Key] || got[p.Key] != true {
			t.Errorf("%s: model=%v sent=%v", p.Label, m.prefs[p.Key], got)
		}
	}
	if !a.showDur {
		t.Error("turning on Show turn duration must reach the live agents")
	}
	if res := m.toggle("Default permission mode")().(actionResultMsg); res.err != nil || !m.autoApprove || autoSent["auto"] != true {
		t.Errorf("permission mode: auto=%v sent=%v err=%v", m.autoApprove, autoSent, res.err)
	}
	for _, it := range m.configItems() {
		if it.Label == "Default permission mode" && it.Value != "Auto" {
			t.Errorf("row reads %q", it.Value)
		}
	}
}
