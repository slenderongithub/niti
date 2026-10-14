package session

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/niti/tui/internal/api"
)

// /goal: the header chip follows the goal's events, and while it is live the composer sends notes
// to it instead of a prompt the core would refuse.
func TestGoalChipAndNotes(t *testing.T) {
	m := sized(2, 120, 30)
	client, calls := fakeCore(t)
	m.client = client
	if strings.Contains(m.header(120), "goal") {
		t.Fatal("chip shown with no goal")
	}
	m.apply(api.Event{Kind: "goal", Status: &api.GoalStatus{Objective: "ship it", State: "running", Round: 2, MaxRounds: 20}})
	if !strings.Contains(m.header(120), "goal 2/20") {
		t.Fatalf("no round chip: %q", m.header(120))
	}
	// Between rounds no run is active, yet text still belongs to the goal.
	m.apply(api.Event{Kind: "session", State: "ended"})
	m = typing(m, "use sqlite")
	next, cmd := m.onKey(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(Model)
	run(cmd)
	if len(*calls) != 1 || !strings.HasPrefix((*calls)[0], "/commands/goal") || !strings.Contains((*calls)[0], "note use sqlite") {
		t.Fatalf("text during a goal should be a /goal note, calls=%v", *calls)
	}
	m.prefs = map[string]bool{"notifyOnDone": true}
	m.apply(api.Event{Kind: "goal", Status: &api.GoalStatus{Objective: "ship it", State: "done", Reason: "tests pass", Round: 3, MaxRounds: 20}})
	if !strings.Contains(m.header(120), "goal done") || !strings.Contains(m.notify, "goal done") {
		t.Fatalf("goal end not shown: header %q notify %q", m.header(120), m.notify)
	}
	if m.goalState.Live() {
		t.Fatal("a finished goal must not capture the composer")
	}
}

// x in the Agents panel interrupts that agent alone; what is typed next is what it does instead.
func TestInterruptOneAgentFromTheAgentsPanel(t *testing.T) {
	m := sized(2, 120, 30)
	client, calls := fakeCore(t)
	m.client = client
	m.apply(api.Event{Kind: "session", State: "started", Goal: "build it"})
	m.agents["b"].status = "working"
	m.region = regionAgents
	m.agentCursor = 1
	next, _ := m.onKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("x")})
	m = next.(Model)
	if m.interruptTo != "b" || m.region != regionPrompt {
		t.Fatalf("x should arm an interrupt of b and return to the prompt: to=%q region=%q", m.interruptTo, m.region)
	}
	m = typing(m, "use approach B")
	next, cmd := m.onKey(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(Model)
	run(cmd)
	if len(*calls) != 1 || !strings.HasPrefix((*calls)[0], "/agents/b/interrupt") || !strings.Contains((*calls)[0], "approach B") {
		t.Fatalf("enter should interrupt b with the text, calls=%v", *calls)
	}
	if m.interruptTo != "" {
		t.Fatal("the interrupt is one-shot")
	}
}

// A phone asking to control this Mac gets its own banner with the code to compare, only yes or no
// (never "always allow"), and the header shows remote control once the Mac is signed in.
func TestPhoneRequestAndRemoteChip(t *testing.T) {
	m := sized(1, 120, 30)
	client, calls := fakeCore(t)
	m.client = client
	id := 7
	m.apply(api.Event{Kind: "approval_request", Requests: []api.Approval{{ID: &id, AgentID: "remote", Tool: "allow_device", Input: map[string]any{"phone": "Ada's iPhone", "code": "482913"}}}})
	b := m.approvalBanner(100, 6, false)
	if !strings.Contains(b, "Ada's iPhone") || !strings.Contains(b, "482 913") {
		t.Fatalf("banner should name the phone and the code: %q", b)
	}
	for _, k := range m.keymap() {
		if k.desc == "Allow for remote" || k.desc == "Deny & tell" {
			t.Fatalf("a device request must not offer %q", k.desc)
		}
	}
	next, cmd := m.onKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y")})
	m = next.(Model)
	run(cmd)
	if len(*calls) != 1 || !strings.Contains((*calls)[0], `"id":7`) || !strings.Contains((*calls)[0], `"ok":true`) {
		t.Fatalf("y should allow that request, calls=%v", *calls)
	}
	if strings.Contains(m.header(120), "remote") {
		t.Fatal("no chip while signed out")
	}
	r := &api.RemoteState{SignedIn: true, Enabled: true, Link: "up"}
	r.Phones = append(r.Phones, struct {
		Name   string `json:"name"`
		Online bool   `json:"online"`
	}{"Ada's iPhone", true})
	m.apply(api.Event{Kind: "remote", Remote: r})
	if !strings.Contains(m.header(120), "remote · 1 watching") {
		t.Fatalf("no remote chip: %q", m.header(120))
	}
}
