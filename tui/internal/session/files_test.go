package session

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func withFiles(m Model, files ...string) Model {
	next, _ := m.Update(filesMsg{files: files})
	return next.(Model)
}

func TestFilesTreeShowsFoldersFirstAndMarksWhatAgentsTouched(t *testing.T) {
	m := withFiles(sized(1, 120, 40), "README.md", "src/cart.ts", "src/util/money.ts", "web/app.js")
	m.applyAgentEvent(ev(t, `{"agentId":"a","type":"tool_call","payload":"read_file {\"path\":\"./web/app.js\"}","callId":"r1","phase":"start","tool":"read_file"}`))
	m.applyAgentEvent(ev(t, `{"agentId":"a","type":"file_edit","payload":"edit","path":"src/cart.ts","callId":"e1","phase":"end","tool":"edit","ok":true,"added":1,"removed":1,"hunks":[{"lines":[{"k":"-","t":"a","o":3},{"k":"+","t":"b","n":3}]}]}`))
	m.applyAgentEvent(ev(t, `{"agentId":"a","type":"file_edit","payload":"write","path":"src/new.ts","callId":"e2","phase":"end","tool":"write_file","ok":true,"added":2,"removed":0,"hunks":[{"lines":[{"k":"+","t":"x","n":1},{"k":"+","t":"y","n":2}]}]}`))
	var names []string
	for _, r := range m.treeRows() {
		names = append(names, strings.Repeat(" ", r.depth)+r.name)
	}
	got := strings.Join(names, "|")
	if want := "src| util|  money.ts| cart.ts| new.ts|web| app.js|README.md"; got != want {
		t.Errorf("tree = %q, want %q", got, want)
	}
	if m.touched["src/cart.ts"] != 'M' || m.touched["src/new.ts"] != 'A' || m.touched["web/app.js"] != 'R' {
		t.Errorf("touched = %v", m.touched)
	}
	v := screen(m)
	if !strings.Contains(v, "Files") || !strings.Contains(v, "cart.ts") || !strings.Contains(v, "3 touched · c") {
		t.Errorf("files panel missing from:\n%s", v)
	}
	m.changedOnly = true
	for _, r := range m.treeRows() {
		if r.name == "README.md" {
			t.Error("changed-only should hide untouched files")
		}
	}
}

func TestOpeningAFileShowsItWithChangedLinesMarked(t *testing.T) {
	m := withFiles(sized(2, 120, 40), "src/cart.ts")
	m.applyAgentEvent(ev(t, `{"agentId":"a","type":"file_edit","payload":"edit","path":"src/cart.ts","callId":"e1","phase":"end","tool":"edit","ok":true,"added":1,"removed":1,"hunks":[{"lines":[{"k":"-","t":"old","o":2},{"k":"+","t":"const total = 20;","n":2}]}]}`))
	m.region = regionFiles
	for i, r := range m.treeRows() {
		if r.path == "src/cart.ts" {
			m.fileCursor = i
		}
	}
	next, _ := m.onKey(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(Model)
	if m.viewer == nil || m.viewer.path != "src/cart.ts" || m.context() != regionTranscript {
		t.Fatalf("enter on a file should open the viewer, viewer=%+v region=%q", m.viewer, m.context())
	}
	next, _ = m.Update(fileLoadedMsg{path: "src/cart.ts", content: "const a = 1;\nconst total = 20;\n"})
	m = next.(Model)
	v := screen(m)
	for _, want := range []string{"src/cart.ts", "2 lines · ▎1 changed this session", "▎2 const total = 20;", "▤ cart.ts"} {
		if !strings.Contains(v, want) {
			t.Errorf("missing %q in:\n%s", want, v)
		}
	}
	next, _ = m.onKey(tea.KeyMsg{Type: tea.KeyEsc})
	if next.(Model).viewer != nil {
		t.Error("esc should close the viewer")
	}
}

func TestAtMentionOffersFilesAndCompletesThePath(t *testing.T) {
	m := withFiles(sized(1, 120, 30), "src/cart.ts", "src/checkout.ts", "README.md")
	m = typing(m, "fix the bug in @cart")
	if !m.menuOpen || !m.menuFiles {
		t.Fatal("@ should open the file menu")
	}
	next, _ := m.onKey(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(Model)
	if got := m.input.Value(); got != "fix the bug in @src/cart.ts " {
		t.Errorf("got %q", got)
	}
	if m.menuOpen {
		t.Error("the menu closes once the path is in")
	}
}

func TestTabReachesTheFilesPanel(t *testing.T) {
	m := withFiles(sized(2, 120, 40), "a.go", "b.go")
	for _, want := range []string{regionTranscript, regionAgents, regionFiles, regionPrompt} {
		next, _ := m.onKey(tea.KeyMsg{Type: tea.KeyTab})
		m = next.(Model)
		if m.context() != want {
			t.Fatalf("tab: got %q, want %q", m.context(), want)
		}
	}
}
