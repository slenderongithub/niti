package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The resolution order in coreCmd is the whole difference between an niti that runs anywhere and
// one that only runs inside the git checkout, so pin it. os.Executable() here is the test binary
// in go's build cache, which has no niti-core sibling — the sibling branch is covered by the
// install smoke test, these two cover the fallbacks and the failure message.
func TestCoreCmdFindsNitiCoreOnPath(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "niti-core")
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
	t.Setenv("PATH", dir) // empty: no niti-core anywhere
	chdir(t, dir)         // and no src/server/main.ts either

	cmd, tried := coreCmd()
	if cmd != nil {
		t.Fatalf("resolved %v with no core installed", cmd.Args)
	}
	if len(tried) < 2 || !strings.Contains(strings.Join(tried, "\n"), devEntry) {
		t.Fatalf("error should name every path tried, got %v", tried)
	}
}

func TestCoreCLIForFindsNitiCoreOnPath(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "niti-core")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	chdir(t, dir)

	cmd, _ := coreCLIFor("trust", "check")
	if cmd == nil {
		t.Fatal("no command resolved")
	}
	if got := strings.Join(cmd.Args, " "); got != bin+" trust check" {
		t.Fatalf("got %q, want %q", got, bin+" trust check")
	}
}

func TestCoreCLIForFallsBackToCliEntryNotDevEntry(t *testing.T) {
	// Neither niti-core nor devEntry (server/main.ts) exist here, but cliEntry does — coreCLIFor
	// must target cli.ts for a subcommand call, since server/main.ts has no subcommand dispatch.
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	if err := os.MkdirAll(filepath.Join(dir, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, cliEntry), []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}
	chdir(t, dir)

	cmd, _ := coreCLIFor("trust", "grant")
	if cmd == nil {
		t.Fatal("no command resolved")
	}
	got := strings.Join(cmd.Args, " ")
	if !strings.HasSuffix(got, "run "+cliEntry+" trust grant") {
		t.Fatalf("got %q, want it to end with 'run %s trust grant'", got, cliEntry)
	}
}

func TestCoreCLIForReportsEveryCandidateWhenNothingIsFound(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", dir) // empty: no niti-core anywhere, and no src/cli.ts either
	chdir(t, dir)

	cmd, tried := coreCLIFor("trust", "check")
	if cmd != nil {
		t.Fatalf("resolved %v with no core installed", cmd.Args)
	}
	if len(tried) < 2 || !strings.Contains(strings.Join(tried, "\n"), cliEntry) {
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

func TestParseArgs(t *testing.T) {
	v, rest := parseArgs([]string{"status", "-v"})
	if !v || len(rest) != 1 || rest[0] != "status" {
		t.Fatalf("got %v %v", v, rest)
	}
	if v, rest = parseArgs(nil); v || len(rest) != 0 {
		t.Fatal("no args, no verbose")
	}
}
