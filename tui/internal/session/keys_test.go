package session

import (
	"fmt"
	"strings"
	"testing"

	"github.com/niti/tui/internal/api"
	"github.com/niti/tui/internal/theme"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

func press(m Model, keys ...tea.KeyMsg) Model {
	for _, k := range keys {
		next, _ := m.onKey(k)
		m = next.(Model)
	}
	return m
}

func footerText(m Model) string { return ansi.Strip(m.footerLine(200)) }

// The footer can only advertise what the table can do: every binding it shows either runs through
// dispatch or is ctrl+c, which onKey handles ahead of everything else.
func TestEveryAdvertisedBindingIsDispatchable(t *testing.T) {
	contexts := map[string]Model{}
	contexts["prompt"] = sized(2, 120, 30)
	tr := sized(2, 120, 30)
	tr.region = regionTranscript
	contexts["transcript"] = tr
	ag := sized(2, 120, 30)
	ag.region = regionAgents
	contexts["agents"] = ag
	ap := sized(2, 120, 30)
	ap.approvals = []api.Approval{{AgentID: "a", Tool: "shell", Input: map[string]any{"command": "ls"}}}
	contexts["approval"] = ap
	mn := typing(sized(2, 120, 30), "/")
	contexts["menu"] = mn

	for name, m := range contexts {
		if got := m.context(); got != name && !(name == "prompt" && got == regionPrompt) {
			t.Fatalf("%s: context() = %q", name, got)
		}
		for _, b := range m.keymap() {
			if b.footer && b.run == nil && b.label != "^c" {
				t.Errorf("%s: footer advertises %q with nothing to run", name, b.label)
			}
		}
	}
}

func TestFooterFollowsFocus(t *testing.T) {
	m := sized(2, 120, 30)
	if f := footerText(m); !strings.Contains(f, "^p Commands") || !strings.Contains(f, "Plan mode") {
		t.Errorf("prompt footer = %q", f)
	}
	m = press(m, tea.KeyMsg{Type: tea.KeyTab})
	if m.region != regionTranscript || !strings.Contains(footerText(m), "Follow") {
		t.Errorf("tab should focus the transcript and the footer should say how to scroll it: region=%q footer=%q", m.region, footerText(m))
	}
	m = press(m, tea.KeyMsg{Type: tea.KeyTab})
	if m.region != regionAgents || !strings.Contains(footerText(m), "Open") {
		t.Errorf("second tab should focus the agents panel: region=%q footer=%q", m.region, footerText(m))
	}
	m = press(m, tea.KeyMsg{Type: tea.KeyTab})
	if m.context() != regionPrompt {
		t.Errorf("third tab should come back to the prompt, got %q", m.context())
	}

	m.approvals = []api.Approval{{AgentID: "coder", Tool: "shell", Input: map[string]any{"command": "ls"}}}
	if f := footerText(m); !strings.Contains(f, "y Allow once") || !strings.Contains(f, "a Allow for coder") || !strings.Contains(f, "n Deny") {
		t.Errorf("approval footer = %q", f)
	}
}

// Typing while the transcript has focus goes to the prompt instead of being swallowed.
func TestTypingFromAnotherRegionReturnsToThePrompt(t *testing.T) {
	m := sized(2, 120, 30)
	m.region = regionTranscript
	m = typing(m, "hi")
	if m.context() != regionPrompt || m.input.Value() != "hi" {
		t.Errorf("region=%q input=%q", m.context(), m.input.Value())
	}
}

func TestAgentsPanelOpensTheHighlightedAgent(t *testing.T) {
	m := sized(3, 120, 30)
	m.region = regionAgents
	m = press(m, tea.KeyMsg{Type: tea.KeyDown}, tea.KeyMsg{Type: tea.KeyEnter})
	if m.focus != m.order[1] {
		t.Errorf("enter on the second agent should show it, focus=%q", m.focus)
	}
}

func TestPaletteFindsFuzzilyAndPreviewsThemesLive(t *testing.T) {
	theme.Use("graphite")
	defer theme.Use("graphite")
	m := sized(2, 120, 30)
	m = press(m, tea.KeyMsg{Type: tea.KeyCtrlP})
	if !m.pal.open {
		t.Fatal("ctrl+p should open the command palette")
	}
	m = typing(m, "thtide")
	if it, ok := m.pal.list.Selected(); !ok || it.Label != "theme: tide" {
		t.Fatalf("fuzzy 'thtide' should select 'theme: tide', got %+v", it)
	}
	if theme.Current() != "tide" {
		t.Errorf("highlighting a theme should preview it, current=%q", theme.Current())
	}
	m = press(m, tea.KeyMsg{Type: tea.KeyEsc})
	if m.pal.open || theme.Current() != "graphite" {
		t.Errorf("esc should close and restore the theme, open=%v current=%q", m.pal.open, theme.Current())
	}

	m = press(m, tea.KeyMsg{Type: tea.KeyCtrlP})
	m = typing(m, "view usage")
	m = press(m, tea.KeyMsg{Type: tea.KeyEnter})
	if m.view != "usage" || m.pal.open {
		t.Errorf("'view: Usage' should switch the main panel, view=%q", m.view)
	}
}

// Scrolled back, the transcript holds still while output arrives and counts what's below; G follows.
func TestTranscriptHoldsItsPlaceWhileScrolledBack(t *testing.T) {
	m := sized(1, 120, 30)
	m.goal = "x"
	st := m.agents["a"]
	for i := 0; i < 80; i++ {
		st.push(fmt.Sprintf("line %d", i))
	}
	m.region = regionTranscript
	m = press(m, tea.KeyMsg{Type: tea.KeyPgUp})
	held := m.scrollBack
	if held == 0 {
		t.Fatal("pgup should scroll back")
	}
	before := ansi.Strip(m.View())
	ev := api.Event{Kind: "agent_event", Event: []byte(`{"agentId":"a","type":"text","payload":"new output\n","time":1}`)}
	next, _ := m.Update(eventsMsg{ev})
	m = next.(Model)
	if m.unseen == 0 || m.scrollBack <= held {
		t.Errorf("new output while scrolled back should be counted below the view, scrollBack=%d unseen=%d", m.scrollBack, m.unseen)
	}
	if !strings.Contains(ansi.Strip(m.View()), "new below") {
		t.Error("the transcript border should say there's new output below")
	}
	_ = before
	m = press(m, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("G")})
	if m.scrollBack != 0 || m.unseen != 0 {
		t.Errorf("G should follow again, scrollBack=%d unseen=%d", m.scrollBack, m.unseen)
	}
}

func TestF1ExplainsTheKeysAndGlyphs(t *testing.T) {
	m := press(sized(2, 120, 30), tea.KeyMsg{Type: tea.KeyF1})
	if !m.out.open || !strings.Contains(m.out.title, "Prompt") {
		t.Fatalf("f1 should open help for the focused region, open=%v title=%q", m.out.open, m.out.title)
	}
	doc := strings.Join(m.out.lines, "\n")
	for _, want := range []string{"PLAN", "⏺", "⎿", "★  lead agent", "^p"} {
		if !strings.Contains(doc, want) {
			t.Errorf("help is missing %q", want)
		}
	}
}

func TestApprovalSaysWhatWillRunInWords(t *testing.T) {
	got := approvalCall("shell", map[string]any{"command": "git", "args": []any{"commit", "-m", "fix bug"}})
	if got != `shell: git commit -m "fix bug"` {
		t.Errorf("got %q", got)
	}
	if got := approvalCall("write_file", map[string]any{"path": "src/a.ts", "content": "x"}); got != "write_file: src/a.ts" {
		t.Errorf("got %q", got)
	}
	m := sized(2, 120, 30)
	m.approvals = []api.Approval{{AgentID: "coder", Tool: "shell", Input: map[string]any{"command": "ls"}}}
	if v := ansi.Strip(m.View()); !strings.Contains(v, "Approval needed") || strings.Contains(v, "map[") {
		t.Error("the approval banner should name the call in words, never print a Go map")
	}
}

// Small terminals drop the frames (posting's compact spacing) and still fit exactly.
func TestCompactModeFitsSmallTerminals(t *testing.T) {
	m := sized(2, 60, 16)
	if !m.compact() {
		t.Fatal("a 60x16 terminal should be compact")
	}
	out := m.View()
	if strings.Contains(ansi.Strip(out), "╭") {
		t.Error("compact mode should draw no panel borders")
	}
	if n := strings.Count(out, "\n") + 1; n != 16 {
		t.Errorf("compact view is %d rows, want 16", n)
	}
}
