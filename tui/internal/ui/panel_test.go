package ui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

func TestPanelIsExactlyItsSizeWithTitleTopRightAndSubtitleBottomLeft(t *testing.T) {
	for _, w := range []int{4, 10, 40} {
		out := Panel{Title: "Request", Subtitle: "201 Created"}.Render("a\nb\nc\nd\ne", w, 5)
		if got := lipgloss.Height(out); got != 5 {
			t.Errorf("w=%d: %d rows, want 5", w, got)
		}
		for i, line := range strings.Split(out, "\n") {
			if got := lipgloss.Width(line); got != w {
				t.Errorf("w=%d row %d: width %d", w, i, got)
			}
		}
	}
	lines := strings.Split(ansi.Strip(Panel{Title: "Request", Subtitle: "201 Created"}.Render("x", 40, 4)), "\n")
	if !strings.HasSuffix(lines[0], " Request ─╮") {
		t.Errorf("title should sit at the right of the top border: %q", lines[0])
	}
	if !strings.HasPrefix(lines[3], "╰─ 201 Created ") {
		t.Errorf("subtitle should sit at the left of the bottom border: %q", lines[3])
	}
}

func TestFuzzyMatchesComeAfterPrefixAndSubstring(t *testing.T) {
	var l List
	l.Set([]Item{{Label: "theme: tide", Value: "1"}, {Label: "tide pool", Value: "2"}, {Label: "the tide", Value: "3"}})
	l.SetQuery("tide")
	if it, _ := l.Selected(); it.Label != "tide pool" {
		t.Errorf("prefix match should rank first, got %q", it.Label)
	}
	l.SetQuery("thtd")
	if l.Len() != 2 {
		t.Errorf("subsequence 'thtd' should match both 'theme: tide' and 'the tide', got %d", l.Len())
	}
	l.SetQuery("zz")
	if l.Len() != 0 {
		t.Error("no subsequence, no match")
	}
}
