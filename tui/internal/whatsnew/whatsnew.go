// Package whatsnew tells the user what changed when they launch a newer niti than last time:
// "Updated to 0.4.10. Got 3 features, 5 bug fixes, and 1 other change." followed by the list.
//
// The changes ship inside the binary (changelog.json, drafted by `bun run bump` from the commits
// since the last release and edited before it's committed), so it works offline and says exactly
// what this build carries. The last version shown is kept in ~/.config/niti/version.json
// (NITI_VERSION_FILE overrides it, as every test harness does).
package whatsnew

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

//go:embed changelog.json
var changelogJSON []byte

type Release struct {
	Version  string   `json:"version"`
	Features []string `json:"features"`
	Fixes    []string `json:"fixes"`
	Other    []string `json:"other"`
}

func statePath() string {
	if p := os.Getenv("NITI_VERSION_FILE"); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "niti", "version.json")
}

type state struct {
	LastSeen string `json:"lastSeen"`
}

// Check records current as seen and returns what to say about the update, "" when there's nothing
// to say: a first install (nothing to compare against), the same version, or a downgrade.
func Check(current string) string {
	path := statePath()
	if path == "" {
		return ""
	}
	var s state
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &s)
	}
	if s.LastSeen != current {
		if b, err := json.Marshal(state{LastSeen: current}); err == nil {
			_ = os.MkdirAll(filepath.Dir(path), 0o700)
			_ = os.WriteFile(path, b, 0o600)
		}
	}
	if s.LastSeen == "" || compare(current, s.LastSeen) <= 0 {
		return ""
	}
	var all []Release
	if err := json.Unmarshal(changelogJSON, &all); err != nil {
		return ""
	}
	return Summary(current, Between(all, s.LastSeen, current))
}

// Between is every release after from, up to and including to — an update that skipped versions
// reports all of them.
func Between(all []Release, from, to string) []Release {
	var out []Release
	for _, r := range all {
		if compare(r.Version, from) > 0 && compare(r.Version, to) <= 0 {
			out = append(out, r)
		}
	}
	return out
}

// Summary is the headline and then each change, newest release first.
func Summary(version string, rs []Release) string {
	var features, fixes, other []string
	for _, r := range rs {
		features = append(features, r.Features...)
		fixes = append(fixes, r.Fixes...)
		other = append(other, r.Other...)
	}
	head := "Updated to " + version + "."
	if len(features)+len(fixes)+len(other) == 0 {
		return head
	}
	var parts []string
	if n := len(features); n > 0 {
		parts = append(parts, plural(n, "feature", "features"))
	}
	if n := len(fixes); n > 0 {
		parts = append(parts, plural(n, "bug fix", "bug fixes"))
	}
	if n := len(other); n > 0 {
		parts = append(parts, plural(n, "other change", "other changes"))
	}
	lines := []string{head + " Got " + join(parts) + "."}
	for _, sec := range []struct {
		title string
		items []string
	}{{"Features", features}, {"Bug fixes", fixes}, {"Other changes", other}} {
		if len(sec.items) == 0 {
			continue
		}
		lines = append(lines, "", sec.title)
		for _, it := range sec.items {
			lines = append(lines, "  • "+it)
		}
	}
	return strings.Join(lines, "\n")
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

// join lists the parts the way the sentence reads: "a", "a and b", "a, b, and c".
func join(p []string) string {
	switch len(p) {
	case 1:
		return p[0]
	case 2:
		return p[0] + " and " + p[1]
	}
	return strings.Join(p[:len(p)-1], ", ") + ", and " + p[len(p)-1]
}

// compare orders x.y.z versions numerically; a pre-release suffix is ignored.
func compare(a, b string) int {
	pa, pb := parts(a), parts(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

func parts(v string) [3]int {
	var out [3]int
	v, _, _ = strings.Cut(strings.TrimPrefix(v, "v"), "-")
	for i, s := range strings.SplitN(v, ".", 3) {
		out[i], _ = strconv.Atoi(s)
	}
	return out
}
