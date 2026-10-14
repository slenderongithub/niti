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
