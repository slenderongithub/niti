package session

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/niti/tui/internal/api"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

func ev(t *testing.T, raw string) api.AgentEvent {
	t.Helper()
	var ae api.AgentEvent
	if err := json.Unmarshal([]byte(raw), &ae); err != nil {
		t.Fatal(err)
	}
	return ae
}

func screen(m Model) string { return ansi.Strip(m.View()) }

func TestFinishedCommandLeavesAResultLineAndFoldsItsOutput(t *testing.T) {
	m := sized(1, 120, 40)
	m.goal = "x"
	m.applyAgentEvent(ev(t, `{"agentId":"a","type":"tool_call","payload":"shell {\"command\":\"npm\",\"args\":[\"test\"]}","callId":"c1","phase":"start","tool":"shell"}`))
	m.applyAgentEvent(ev(t, `{"agentId":"a","type":"tool_output","payload":"✓ cart total\n✓ cart empty","callId":"c1","tool":"shell"}`))
	if v := screen(m); !strings.Contains(v, "Run npm test") || !strings.Contains(v, "✓ cart empty") {
		t.Fatalf("a running command should show with its live output:\n%s", v)
	}
	body := make([]string, 10)
	for i := range body {
		body[i] = fmt.Sprintf("line %d", i)
	}
	b, _ := json.Marshal(body)
	m.applyAgentEvent(ev(t, `{"agentId":"a","type":"tool_call","payload":"shell → exit 0","callId":"c1","phase":"end","tool":"shell","ok":true,"durationMs":2100,"exitCode":0,"outcome":"48 passed","lines":10,"body":`+string(b)+`}`))
	v := screen(m)
	for _, want := range []string{"✔ Ran npm test · 2.1s", "⎿ 48 passed", "line 0", "line 2", "+7 lines (ctrl+o to expand)"} {
		if !strings.Contains(v, want) {
			t.Errorf("missing %q in:\n%s", want, v)
		}
	}
	if strings.Contains(v, "line 5") {
		t.Error("output past the fold should stay hidden until ctrl+o")
	}
	next, _ := m.onKey(tea.KeyMsg{Type: tea.KeyCtrlO})
	m = next.(Model)
	if v := screen(m); !strings.Contains(v, "line 9") || strings.Contains(v, "ctrl+o to expand") {
		t.Errorf("ctrl+o should show everything and drop the fold marker:\n%s", v)
	}
}

func TestFailedCommandIsMarkedFailed(t *testing.T) {
	m := sized(1, 120, 30)
	m.goal = "x"
	m.applyAgentEvent(ev(t, `{"agentId":"a","type":"tool_call","payload":"shell {\"command\":\"make\"}","callId":"c1","phase":"start","tool":"shell"}`))
	m.applyAgentEvent(ev(t, `{"agentId":"a","type":"tool_call","payload":"shell → exit 2","callId":"c1","phase":"end","tool":"shell","ok":false,"durationMs":300,"exitCode":2,"outcome":"exit 2 · no rule to make target","lines":1,"body":["no rule to make target"]}`))
	if v := screen(m); !strings.Contains(v, "✖ Ran make") || !strings.Contains(v, "exit 2 · no rule") {
		t.Errorf("a failed command should read as failed:\n%s", v)
	}
}

func TestFileChangeShowsNumberedRowsAndTheChangedWords(t *testing.T) {
	m := sized(1, 120, 40)
	m.goal = "x"
	m.applyAgentEvent(ev(t, `{"agentId":"a","type":"file_edit","payload":"edit → edited a.ts","path":"src/a.ts","callId":"c2","phase":"end","tool":"edit","ok":true,"added":1,"removed":1,
		"hunks":[{"lines":[{"k":" ","t":"const a = 1;","o":1,"n":1},{"k":"-","t":"const total = 10;","o":2},{"k":"+","t":"const total = 20;","n":2}]}]}`))
	v := screen(m)
	for _, want := range []string{"✔ Updated src/a.ts (+1 −1)", "   2 - const total = 10;", "   2 + const total = 20;", "   1   const a = 1;"} {
		if !strings.Contains(v, want) {
			t.Errorf("missing %q in:\n%s", want, v)
		}
	}
	st := m.agents["a"]
	var added string
	for _, l := range st.log {
		if firstRune(l) == mkAdd {
			added = l
		}
	}
	if !strings.Contains(added, string(mkHi)+"2"+string(mkHiEnd)) {
		t.Errorf("only the changed digit should be highlighted, got %q", added)
	}
}

func TestChecklistIsPinnedUntilDoneThenCollapses(t *testing.T) {
	m := sized(1, 120, 30)
	m.goal = "x"
	m.applyAgentEvent(ev(t, `{"agentId":"a","type":"todo","payload":"","todos":[{"text":"write cart","status":"done"},{"text":"add tests","status":"doing"},{"text":"run tests","status":"pending"}]}`))
	if v := screen(m); !strings.Contains(v, "☑ write cart") || !strings.Contains(v, "◼ add tests") || !strings.Contains(v, "☐ run tests") {
		t.Fatalf("checklist should be pinned:\n%s", v)
	}
	m.applyAgentEvent(ev(t, `{"agentId":"a","type":"todo","payload":"","todos":[{"text":"write cart","status":"done"},{"text":"add tests","status":"done"},{"text":"run tests","status":"done"}]}`))
	if v := screen(m); strings.Contains(v, "☐") || !strings.Contains(v, "Plan complete · 3/3 steps") {
		t.Errorf("a finished checklist should collapse to one line:\n%s", v)
	}
}

func TestPlainLineStripsTheMarkersForThePager(t *testing.T) {
	if got := plainLine(string(mkAdd) + "   2 + x = " + string(mkHi) + "2" + string(mkHiEnd)); got != "   2 + x = 2" {
		t.Errorf("got %q", got)
	}
}
