package session

import (
	"reflect"
	"testing"
)

func TestDiffLines(t *testing.T) {
	got := diffLines("@@ src/a.ts:4-4\n b\n-d\n+D\n e")
	want := []string{"  ╭ src/a.ts:4-4", "  │ b", "  - d", "  + D", "  │ e"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q", got)
	}
	if diffLines("") != nil {
		t.Fatal("empty diff should render nothing")
	}
}

func TestDiffLinesAreColoredByMarker(t *testing.T) {
	red, green := lineStyle("  - x", "").GetForeground(), lineStyle("  + x", "").GetForeground()
	if red == green {
		t.Fatal("removals and additions must not share a color")
	}
}
