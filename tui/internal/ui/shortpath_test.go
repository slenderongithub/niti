package ui

import (
	"os"
	"path/filepath"
	"testing"
)

func TestShortPathKeepsTheFolderName(t *testing.T) {
	long := "/private/var/folders/7g/wnjrrxhs123_r6p4vqklcq5w0000gn/T/tmpabc123/redditreplica"
	got := ShortPath(long, 30)
	if len([]rune(got)) != 30 || got[len(got)-len("redditreplica"):] != "redditreplica" {
		t.Errorf("ShortPath = %q", got)
	}
	home, _ := os.UserHomeDir()
	if got := ShortPath(filepath.Join(home, "code"), 80); got != "~/code" {
		t.Errorf("home not collapsed: %q", got)
	}
	if got := ShortPath(home+"2/code", 80); got != home+"2/code" { // a sibling that merely shares a prefix
		t.Errorf("prefix-only match collapsed: %q", got)
	}
}
