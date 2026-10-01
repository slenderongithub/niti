package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// The project is the folder niti is launched in; it climbs to a git repo only from inside that
// repo's tracked files. Regression: a stray ~/Developer/.git swallowed every new folder under it.
func TestProjectRoot(t *testing.T) {
	top, _ := filepath.EvalSymlinks(t.TempDir())
	t.Setenv("HOME", filepath.Join(top, "elsewhere")) // not an ancestor of the repo
	for _, d := range []string{"src", "fresh", "own/.niti"} {
		if err := os.MkdirAll(filepath.Join(top, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(top, "src", "a.go"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", "-q"}, {"add", "src/a.go"}} {
		if out, err := exec.Command("git", append([]string{"-C", top}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	cases := []struct{ cwd, want string }{
		{"src", ""},        // tracked files → the repo root
		{"fresh", "fresh"}, // new folder under a repo → itself
		{"own", "own"},     // its own .niti → itself
		{"", ""},           // the repo root → itself
	}
	for _, c := range cases {
		if err := os.Chdir(filepath.Join(top, c.cwd)); err != nil {
			t.Fatal(err)
		}
		got, _ := filepath.EvalSymlinks(projectRoot())
		if want := filepath.Join(top, c.want); got != want {
			t.Errorf("from %q: projectRoot() = %q, want %q", c.cwd, got, want)
		}
	}
	// $HOME is never climbed to, even when it tracks the folder (a dotfiles repo)
	t.Setenv("HOME", top)
	if err := os.Chdir(filepath.Join(top, "src")); err != nil {
		t.Fatal(err)
	}
	if got, _ := filepath.EvalSymlinks(projectRoot()); got != filepath.Join(top, "src") {
		t.Errorf("under $HOME: projectRoot() = %q, want the launch folder", got)
	}
}
