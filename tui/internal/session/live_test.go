package session

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/niti/tui/internal/api"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/muesli/termenv"
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
	_, afterHi, _ := strings.Cut(added, string(mkHi))
	inHi, _, _ := strings.Cut(afterHi, string(mkHiEnd))
	if plainLine(inHi) != "2" { // syntax markers may sit inside the span; the text must be just the digit
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

func TestRunEndsWithACardAndASuggestionTabTakes(t *testing.T) {
	m := sized(1, 120, 40)
	m.goal = "fix the cart"
	m.apply(api.Event{Kind: "turn_summary", Ok: true, Summary: "• Fixed total() in src/cart.ts\n• Tests pass", Next: []string{"add a test for empty carts"},
		Files: []api.FileChange{{Path: "src/cart.ts", Added: 2, Removed: 1}}, DurationMs: 134_000, Tokens: 12_400, Cost: 0.04})
	v := screen(m)
	for _, want := range []string{"Done · 2m14s · 12.4k tok · $0.04", "Fixed total() in src/cart.ts", "src/cart.ts  +2 −1", "next: add a test for empty carts", "add a test for empty carts   (tab to use)", "tab Use suggestion"} {
		if !strings.Contains(v, want) {
			t.Errorf("missing %q in:\n%s", want, v)
		}
	}
	next, _ := m.onKey(tea.KeyMsg{Type: tea.KeyTab})
	m = next.(Model)
	if m.input.Value() != "add a test for empty carts" {
		t.Fatalf("tab should take the suggestion, got %q", m.input.Value())
	}
	m.clearTurn()
	if m.card != nil || m.input.Placeholder != defaultPlaceholder {
		t.Error("a new turn clears the card and the ghost text")
	}
}

func TestFailedRunCardSaysSo(t *testing.T) {
	m := sized(1, 120, 40)
	m.goal = "x"
	m.apply(api.Event{Kind: "turn_summary", Ok: false, Summary: "• t2 failed", DurationMs: 5000})
	if v := screen(m); !strings.Contains(v, "Finished with failures · 5.0s") {
		t.Errorf("card title should say the run had failures:\n%s", v)
	}
}

func TestSyntaxHighlightMarksTokensAndKeepsTheText(t *testing.T) {
	got := highlight(`const total = 20; // "done"`, "src/cart.ts")
	if plainLine(got) != `const total = 20; // "done"` {
		t.Fatalf("highlighting must not change the text, got %q", plainLine(got))
	}
	for _, want := range []string{string(mkSynKw) + "const" + string(mkSynEnd), string(mkSynNum) + "20" + string(mkSynEnd), string(mkSynCom) + `// "done"` + string(mkSynEnd)} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %q", want, got)
		}
	}
	if highlight("const x", "notes.md") != "const x" {
		t.Error("unknown extensions stay plain")
	}
	// The changed-words markers pass through a string token intact.
	in := `x = "a` + string(mkHi) + `b` + string(mkHiEnd) + `c"`
	if plainLine(highlight(in, "a.py")) != `x = "abc"` || !strings.ContainsRune(highlight(in, "a.py"), mkHi) {
		t.Error("changed-words highlight lost inside a string")
	}
}

// A second hunk's "⋮" separator used to be cut mid-rune, and agent text can carry tabs, \r, color
// codes, broken bytes and joined emoji. Any of them made a row wider than it measured: it wrapped,
// the frame grew a line and every panel below shifted. The frame must stay exactly the terminal.
func TestHostileTextNeverOverflowsTheFrame(t *testing.T) {
	const w, h = 100, 30
	// With colors off the two halves of a cut rune sit side by side and rejoin; a real terminal gets
	// a color code between them, which is what broke the row.
	lipgloss.SetColorProfile(termenv.TrueColor)
	defer lipgloss.SetColorProfile(termenv.Ascii)
	m := sized(1, w, h)
	m.goal = "x"
	m.applyAgentEvent(ev(t, `{"agentId":"a","type":"file_edit","payload":"edit","path":"src/ui.js","callId":"c1","phase":"end","tool":"edit","ok":true,"added":1,"removed":1,
		"hunks":[{"lines":[{"k":" ","t":"a\tb\r","o":1,"n":1}]},{"lines":[{"k":"-","t":"x = \"\u001b[31mred\u001b[0m\"","o":16},{"k":"+","t":"x = \"👩‍💻 ⏱️\"","n":16}]}]}`))
	m.applyAgentEvent(ev(t, `{"agentId":"a","type":"tool_output","payload":"out\r\n\u001b[32mok\u001b[0m\tdone","callId":"c2","tool":"shell"}`))
	m.agents["a"].push("bad \xff\xfe bytes")
	v := m.View()
	lines := strings.Split(v, "\n")
	if len(lines) != h {
		t.Fatalf("frame is %d rows, want %d", len(lines), h)
	}
	for i, l := range lines {
		if ansi.StringWidth(l) > w || !utf8.ValidString(l) || strings.ContainsAny(ansi.Strip(l), "\r\t�") {
			t.Errorf("row %d is %d wide or holds a raw control/broken byte: %q", i, ansi.StringWidth(l), ansi.Strip(l))
		}
	}
	if !strings.Contains(ansi.Strip(v), "⋮") {
		t.Error("the hunk separator should survive intact")
	}
}

// A long command was cut at the banner's edge — the tail, often the part that matters, was never
// shown before the user pressed y. It now wraps, and the frame still fits the terminal.
func TestApprovalShowsTheWholeLongCommand(t *testing.T) {
	const w, h = 80, 30
	m := sized(1, w, h)
	m.approvals = []api.Approval{{AgentID: "builder", Tool: "shell", Input: map[string]any{
		"command": "node", "args": []any{"-e", "['a.js','b.js'].forEach(f => { const lines = require('fs').readFileSync(f,'utf8').split('\\n').length; if (lines > 60) process.exit(1) }) && rm -rf ./tmp-end"}}}}
	v := m.View()
	if n := len(strings.Split(v, "\n")); n != h {
		t.Fatalf("frame is %d rows, want %d", n, h)
	}
	if plain := strings.ReplaceAll(ansi.Strip(v), "\n", ""); !strings.Contains(plain, "tmp-end") {
		t.Errorf("the end of the command should be visible:\n%s", ansi.Strip(v))
	}
}

func TestSessionResetWipesTheScreenButKeepsTheRoster(t *testing.T) {
	m := sized(2, 120, 40)
	m.apply(api.Event{Kind: "session", State: "started", Goal: "fix the cart"})
	m.applyAgentEvent(ev(t, `{"agentId":"a","type":"message","payload":"hello there"}`))
	m.apply(api.Event{Kind: "turn_summary", Ok: true, Summary: "• done", Files: []api.FileChange{{Path: "src/cart.ts", Added: 1}}})
	m.tasks = []api.Task{{ID: "t1", Description: "x", Status: "done"}}
	m.markTouched("src/cart.ts", 'M')
	m.totals = api.Totals{InputTokens: 900}
	m.cost = 1.5
	if len(m.agents["a"].log) == 0 {
		t.Fatal("setup: expected the agent to have a transcript")
	}

	m.apply(api.Event{Kind: "session_reset"})

	if len(m.agents) != 2 || len(m.order) != 2 {
		t.Errorf("roster must survive a reset, got %d agents", len(m.agents))
	}
	if len(m.agents["a"].log) != 0 || len(m.tasks) != 0 || m.card != nil || len(m.touched) != 0 || m.totals.InputTokens != 0 || m.cost != 0 || m.goal != "" || m.active {
		t.Errorf("reset left state behind: log=%d tasks=%d card=%v touched=%v totals=%v cost=%v goal=%q active=%v",
			len(m.agents["a"].log), len(m.tasks), m.card != nil, m.touched, m.totals, m.cost, m.goal, m.active)
	}
}
