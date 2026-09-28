package session

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/niti/tui/internal/api"
	tea "github.com/charmbracelet/bubbletea"
)

// A fake core that records what the TUI asked of it.
func fakeCore(t *testing.T) (*api.Client, *[]string) {
	var calls []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		calls = append(calls, r.URL.Path+" "+strings.TrimSpace(func() string { b, _ := json.Marshal(body); return string(b) }()))
		w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)
	return api.New(srv.URL, "tok"), &calls
}

func run(cmd tea.Cmd) {
	if cmd != nil {
		if b, ok := cmd().(tea.BatchMsg); ok {
			for _, c := range b {
				run(c)
			}
		}
	}
}

func TestMidRunMessageSteersTheWorkingAgentInsteadOfStartingOver(t *testing.T) {
	m := sized(2, 120, 30)
	client, calls := fakeCore(t)
	m.client = client
	m.apply(api.Event{Kind: "session", State: "started", Goal: "build it"})
	m.agents["b"].status = "working"
	m.status = "something else entirely" // status text must not decide whether a run is going
	m = typing(m, "use sqlite not postgres")
	next, cmd := m.onKey(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(Model)
	run(cmd)
	if len(*calls) != 1 || !strings.HasPrefix((*calls)[0], "/agents/b/message") || !strings.Contains((*calls)[0], "sqlite") {
		t.Fatalf("mid-run text should go to the working agent's inbox, calls=%v", *calls)
	}
	if m.input.Value() != "" {
		t.Error("the prompt clears after steering")
	}
}

func TestEscInterruptsARunningRun(t *testing.T) {
	m := sized(1, 120, 30)
	client, calls := fakeCore(t)
	m.client = client
	m.apply(api.Event{Kind: "session", State: "started", Goal: "x"})
	if !strings.Contains(footerText(m), "esc Interrupt") {
		t.Errorf("footer should offer interrupt while running: %q", footerText(m))
	}
	_, cmd := m.onKey(tea.KeyMsg{Type: tea.KeyEsc})
	run(cmd)
	if len(*calls) != 1 || !strings.HasPrefix((*calls)[0], "/cancel") {
		t.Fatalf("esc should cancel the run, calls=%v", *calls)
	}
}

func TestDenyAndTellSendsTheNextMessageToThatAgent(t *testing.T) {
	m := sized(2, 120, 30)
	client, calls := fakeCore(t)
	m.client = client
	m.approvals = []api.Approval{{AgentID: "b", Tool: "shell", Input: map[string]any{"command": "rm"}}}
	next, cmd := m.onKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("t")})
	m = next.(Model)
	run(cmd)
	m = typing(m, "just move it to trash/")
	next, cmd = m.onKey(tea.KeyMsg{Type: tea.KeyEnter})
	run(cmd)
	if len(*calls) != 2 || !strings.Contains((*calls)[0], `"ok":false`) || !strings.HasPrefix((*calls)[1], "/agents/b/message") {
		t.Fatalf("t should deny, then route the next message to b, calls=%v", *calls)
	}
}

func TestHistoryRecallsEarlierPromptsAndPersists(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, ".niti"), 0o755)
	m := sized(1, 120, 30)
	m.root = root
	m.remember("first goal")
	m.remember("second goal")
	up := tea.KeyMsg{Type: tea.KeyUp}
	next, _ := m.onKey(up)
	m = next.(Model)
	if m.input.Value() != "second goal" {
		t.Fatalf("↑ should recall the newest prompt, got %q", m.input.Value())
	}
	next, _ = m.onKey(up)
	m = next.(Model)
	if m.input.Value() != "first goal" {
		t.Fatalf("↑ again should go older, got %q", m.input.Value())
	}
	if got := loadHistory(root); len(got) != 2 || got[1] != "second goal" {
		t.Errorf("history should persist to .niti/history, got %v", got)
	}
}

func TestBangRunsACommandHereAndShowsItsOutput(t *testing.T) {
	m := sized(1, 120, 30)
	m.root = t.TempDir()
	m = typing(m, "!echo hello-from-bang")
	_, cmd := m.onKey(tea.KeyMsg{Type: tea.KeyEnter})
	msg := cmd()
	res, ok := msg.(bangResultMsg)
	if !ok || !strings.Contains(res.out, "hello-from-bang") {
		t.Fatalf("got %#v", msg)
	}
	next, _ := m.Update(res)
	if mm := next.(Model); !mm.out.open || !strings.Contains(strings.Join(mm.out.lines, "\n"), "hello-from-bang") {
		t.Error("output should open in the pager")
	}
}
