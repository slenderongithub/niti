package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Regression: ~/.niti (created by running niti from $HOME) or a stray ~/.git captured every folder
// under home, so an empty project showed the whole home directory. Mirrors findProjectRoot's test.
func TestProjectRootNeverClimbsIntoHome(t *testing.T) {
	home, _ := filepath.EvalSymlinks(t.TempDir())
	t.Setenv("HOME", home)
	for _, d := range []string{".niti", ".git", "empty", "proj/.git", "proj/src"} {
		if err := os.MkdirAll(filepath.Join(home, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	cases := []struct{ cwd, want string }{
		{"empty", "empty"},   // under home, no marker of its own → itself, not ~
		{"", ""},             // launched from home → home
		{"proj/src", "proj"}, // a real repo under home still wins
	}
	for _, c := range cases {
		cwd := filepath.Join(home, c.cwd)
		want := filepath.Join(home, c.want)
		if err := os.Chdir(cwd); err != nil {
			t.Fatal(err)
		}
		got, _ := filepath.EvalSymlinks(projectRoot())
		if got != want {
			t.Errorf("projectRoot() from %q = %q, want %q", c.cwd, got, want)
		}
	}
}
