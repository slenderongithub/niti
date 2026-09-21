package ui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
)


func TestWrapBoundsLinesAndMarksTheCut(t *testing.T) {
	got := Wrap("alpha beta gamma delta epsilon zeta eta theta", 12, 2)
	if len(got) != 2 || !strings.HasSuffix(got[1], "…") {
		t.Fatalf("want 2 lines ending in an ellipsis, got %q", got)
	}
	for _, l := range got {
		if lipgloss.Width(l) > 12 {
			t.Errorf("line %q is wider than 12", l)
		}
	}
	if got := Wrap("short text", 40, 3); len(got) != 1 || got[0] != "short text" {
		t.Fatalf("text that fits must be untouched, got %q", got)
	}
	if Wrap("", 10, 3) != nil {
		t.Fatal("empty text wraps to nothing")
	}
}
