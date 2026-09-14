package trust

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func pressAndGetChoice(t *testing.T, digit string) Choice {
	t.Helper()
	m := New("/some/project", false)
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(digit)})
	if cmd == nil {
		t.Fatalf("pressing %q should quit the program", digit)
	}
	return next.(Model).Choice
}

func TestChoiceKeys(t *testing.T) {
	if got := pressAndGetChoice(t, "1"); got != Once {
		t.Errorf("'1' should choose Once, got %v", got)
	}
	if got := pressAndGetChoice(t, "2"); got != Remember {
		t.Errorf("'2' should choose Remember, got %v", got)
	}
	if got := pressAndGetChoice(t, "3"); got != No {
		t.Errorf("'3' should choose No, got %v", got)
	}
}

func TestEnterSameAsProceedOnce(t *testing.T) {
	m := New("/some/project", false)
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("enter should quit the program")
	}
	if got := next.(Model).Choice; got != Once {
		t.Errorf("enter should default to Once, got %v", got)
	}
}

func TestEscAndCtrlCAreNo(t *testing.T) {
	for _, k := range []tea.KeyMsg{{Type: tea.KeyEsc}, {Type: tea.KeyCtrlC}} {
		m := New("/some/project", false)
		next, cmd := m.Update(k)
		if cmd == nil {
			t.Fatalf("%v should quit the program", k)
		}
		if got := next.(Model).Choice; got != No {
			t.Errorf("%v should choose No, got %v", k, got)
		}
	}
}

func TestViewMentionsChangedConfigWhenApplicable(t *testing.T) {
	fresh := New("/p", false).View()
	changed := New("/p", true).View()
	if fresh == changed {
		t.Fatal("the 'changed config' case should render differently from a brand-new directory")
	}
}
