package ui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
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

func TestCutLeftKeepsTheStylingAtTheCut(t *testing.T) {
	cases := []struct{ in string; n int; wantPlain string }{
		{"hello world", 6, "world"},
		{"hello", 0, "hello"},
		{"hello", 9, ""},
		{"日本語です", 3, " 語です"}, // cut inside a wide character: its visible half becomes a space
	}
	for _, c := range cases {
		if got := ansi.Strip(cutLeft(c.in, c.n)); got != c.wantPlain {
			t.Errorf("cutLeft(%q, %d) = %q, want %q", c.in, c.n, got, c.wantPlain)
		}
	}
	// A colour switched on before the cut is still on after it.
	got := cutLeft("\x1b[31mred text\x1b[0m plain", 4)
	if !strings.HasPrefix(got, "\x1b[31m") || ansi.Strip(got) != "text plain" {
		t.Errorf("styling lost at the cut: %q", got)
	}
}

// A popup leaves the rest of every row it covers alone — the main panel's right border must
// survive to the right of the box.
func TestOverlayKeepsWhatIsToTheRightOfTheBox(t *testing.T) {
	base := strings.Repeat("|"+strings.Repeat(".", 38)+"|\n", 5) + "|" + strings.Repeat(".", 38) + "|"
	out := Overlay(base, "[box]\n[box]", 40, 6)
	for i, line := range strings.Split(ansi.Strip(out), "\n") {
		if !strings.HasSuffix(line, "|") || !strings.HasPrefix(line, "|") {
			t.Errorf("row %d lost the frame on one side: %q", i, line)
		}
	}
}
