package session

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func altDigit(r rune) tea.KeyMsg {
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}, Alt: true}
}

// alt+N is the fast path to a per-agent focused window (VS-Code-tabs style): jump straight to the
// Nth teammate, and pressing the same digit again returns to the stacked overview.
func TestAltDigitTogglesFocus(t *testing.T) {
	m := model(3) // ids "a", "b", "c" in roster order

	next, _ := m.onKey(altDigit('2'))
	m = next.(Model)
	if m.focus != "b" {
		t.Fatalf("alt+2 should focus the 2nd agent (b), got focus=%q", m.focus)
	}

	next, _ = m.onKey(altDigit('2'))
	m = next.(Model)
	if m.focus != "" {
		t.Fatalf("alt+2 again should return to the overview, got focus=%q", m.focus)
	}
}

// An out-of-range digit (more slots than agents) must not panic or change focus — the same
// tolerance workView already has for a roster shorter than its rendering budget.
func TestAltDigitBeyondRosterIsNoop(t *testing.T) {
	m := model(2)
	next, _ := m.onKey(altDigit('9'))
	m = next.(Model)
	if m.focus != "" {
		t.Fatalf("alt+9 with only 2 agents should be a no-op, got focus=%q", m.focus)
	}
}

// esc is the way back to the overview from a focused window, and a no-op when already there.
func TestEscClearsFocus(t *testing.T) {
	m := model(2)
	m.focus = "a"

	next, _ := m.onKey(tea.KeyMsg{Type: tea.KeyEsc})
	m = next.(Model)
	if m.focus != "" {
		t.Fatalf("esc should clear focus, got %q", m.focus)
	}

	next, _ = m.onKey(tea.KeyMsg{Type: tea.KeyEsc})
	m = next.(Model)
	if m.focus != "" {
		t.Fatalf("esc at the overview should stay a no-op, got %q", m.focus)
	}
}

// ctrl+g opens the quick-picker; selecting a teammate focuses it, and esc cancels without
// changing focus — the same shape as the ctrl+p model carousel.
func TestAgentPickerOpensAndSelects(t *testing.T) {
	m := model(3)

	opened, _ := m.onKey(tea.KeyMsg{Type: tea.KeyCtrlG})
	m = opened.(Model)
	if !m.ap.open {
		t.Fatal("ctrl+g should open the agent picker")
	}

	// First row is "≡ overview", then the roster in order — move down twice to land on "b".
	next, _ := m.onKey(tea.KeyMsg{Type: tea.KeyDown})
	m = next.(Model)
	next, _ = m.onKey(tea.KeyMsg{Type: tea.KeyDown})
	m = next.(Model)
	confirmed, _ := m.onKey(tea.KeyMsg{Type: tea.KeyEnter})
	m = confirmed.(Model)

	if m.ap.open {
		t.Fatal("enter should close the picker")
	}
	if m.focus != "b" {
		t.Fatalf("expected focus=%q after selecting the 2nd roster row, got %q", "b", m.focus)
	}
}

func TestAgentPickerEscCancelsWithoutChangingFocus(t *testing.T) {
	m := model(2)
	m.focus = "a"

	opened, _ := m.onKey(tea.KeyMsg{Type: tea.KeyCtrlG})
	m = opened.(Model)
	closed, _ := m.onKey(tea.KeyMsg{Type: tea.KeyEsc})
	m = closed.(Model)

	if m.ap.open {
		t.Fatal("esc should close the picker")
	}
	if m.focus != "a" {
		t.Fatalf("esc-cancel must not change focus, got %q", m.focus)
	}
}
