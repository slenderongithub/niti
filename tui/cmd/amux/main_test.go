package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The resolution order in coreCmd is the whole difference between an amux that runs anywhere and
// one that only runs inside the git checkout, so pin it. os.Executable() here is the test binary
// in go's build cache, which has no amux-core sibling — the sibling branch is covered by the
// install smoke test, these two cover the fallbacks and the failure message.
func TestCoreCmdFindsAmuxCoreOnPath(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "amux-core")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	chdir(t, dir)

	cmd, _ := coreCmd()
	if cmd == nil {
		t.Fatal("no command resolved")
	}
	if got := strings.Join(cmd.Args, " "); got != bin+" serve" {
		t.Fatalf("got %q, want %q", got, bin+" serve")
	}
}

func TestCoreCmdReportsEveryCandidateWhenNothingIsFound(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", dir) // empty: no amux-core anywhere
	chdir(t, dir)         // and no src/server/main.ts either

	cmd, tried := coreCmd()
	if cmd != nil {
		t.Fatalf("resolved %v with no core installed", cmd.Args)
	}
	if len(tried) < 2 || !strings.Contains(strings.Join(tried, "\n"), devEntry) {
		t.Fatalf("error should name every path tried, got %v", tried)
	}
}

// t.Chdir is go1.24; this module targets 1.22.
func chdir(t *testing.T, dir string) {
	t.Helper()
	prev, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(prev) })
}
