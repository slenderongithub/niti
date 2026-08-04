package session

import (
	"strings"
	"testing"

	"github.com/amux/tui/internal/api"
	tea "github.com/charmbracelet/bubbletea"
)

func diffApproval(diff string) api.Approval {
	return api.Approval{AgentID: "a", Tool: "edit", Input: map[string]any{
		"path": "s.txt", "oldString": "old", "newString": "new", "diff": diff,
	}}
}

// A diff on the head of the queue gets the full-screen viewer; a plain tool call (no diff, e.g.
// shell) keeps the old one-line bar.
func TestDiffApprovalOpensFullScreenView(t *testing.T) {
	m := sized(1, 120, 40)
	m.approvals = []api.Approval{diffApproval("@@ line 1 @@\n-old\n+new")}
	if !strings.Contains(m.View(), "wants to run edit") {
		t.Error("a diff-carrying approval must render the full-screen diff view")
	}

	m.approvals = []api.Approval{{AgentID: "a", Tool: "shell", Input: map[string]any{"command": "ls"}}}
	if strings.Contains(m.View(), "↑↓ scroll") {
		t.Error("a diff-less approval must keep the one-line bar, not the full-screen view")
	}
}

// y/n only answer the actual head of the queue; previewing another pending item (tab) must not
// let a keystroke answer the wrong request.
func TestDiffViewBatchPreviewIsReadOnly(t *testing.T) {
	m := sized(1, 120, 40)
	m.approvals = []api.Approval{diffApproval("@@ line 1 @@\n-a\n+b"), diffApproval("@@ line 1 @@\n-c\n+d")}

	next, _ := m.onKey(tea.KeyMsg{Type: tea.KeyTab})
	m = next.(Model)
	if m.diffv.idx != 1 {
		t.Fatalf("tab must move the preview to the next pending item, got idx=%d", m.diffv.idx)
	}

	answered, cmd := m.onKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'y'}})
	m = answered.(Model)
	if cmd != nil || len(m.approvals) != 2 {
		t.Fatal("'y' while previewing a non-head item must not answer anything")
	}

	back, _ := m.onKey(tea.KeyMsg{Type: tea.KeyShiftTab})
	m = back.(Model)
	if m.diffv.idx != 0 {
		t.Fatalf("shift+tab must move back to the head, got idx=%d", m.diffv.idx)
	}
	answered, cmd = m.onKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'y'}})
	m = answered.(Model)
	if cmd == nil || len(m.approvals) != 1 {
		t.Fatal("'y' on the actual head must answer it and pop the queue")
	}
}

// 'e' opens an editor seeded with the model's proposal; ctrl+s stores the edit, and approving
// afterward must carry it through to Client.Approve rather than the original proposal.
func TestDiffViewEditRoundTrip(t *testing.T) {
	m := sized(1, 120, 40)
	m.approvals = []api.Approval{diffApproval("@@ line 1 @@\n-old\n+new")}

	editing, _ := m.onKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'e'}})
	m = editing.(Model)
	if !m.diffv.editing {
		t.Fatal("'e' must enter edit mode")
	}
	if got := m.diffv.textarea.Value(); got != "new" {
		t.Fatalf("edit mode must seed the textarea with the proposed replacement, got %q", got)
	}

	m.diffv.textarea.SetValue("edited by user")
	saved, _ := m.onKey(tea.KeyMsg{Type: tea.KeyCtrlS})
	m = saved.(Model)
	if m.diffv.editing {
		t.Fatal("ctrl+s must leave edit mode")
	}
	if got := m.diffv.edited["newString"]; got != "edited by user" {
		t.Fatalf("ctrl+s must store the edited text under the tool's edited field, got %v", m.diffv.edited)
	}
	if !strings.Contains(m.diffView(120, 40), "edited by user") {
		t.Error("the view must preview the edited text, not the original proposal")
	}

	answered, cmd := m.onKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'y'}})
	m = answered.(Model)
	if cmd == nil {
		t.Fatal("approving after an edit must still dispatch")
	}
	if len(m.approvals) != 0 {
		t.Error("approving must pop the answered request")
	}
}

// `G` used to park the offset at 1<<30 (clamped only when rendering), so the next `up` decremented
// from a billion and the view appeared frozen at the bottom forever.
func TestDiffScrollEndThenUpMovesImmediately(t *testing.T) {
	m := Model{height: 24}
	m.approvals = []api.Approval{{
		AgentID: "a", Tool: "edit",
		Input: map[string]any{"path": "x.ts", "diff": strings.Repeat("line\n", 200)},
	}}

	m.diffViewKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'G'}})
	bottom := m.diffv.top
	if bottom == 0 || bottom > 200 {
		t.Fatalf("G should land on a real bottom offset, got %d", bottom)
	}
	m.diffViewKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'k'}})
	if m.diffv.top != bottom-1 {
		t.Fatalf("up after G must move one line, got %d (was %d)", m.diffv.top, bottom)
	}
}
