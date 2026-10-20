package whatsnew

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSummaryCountsEveryReleaseSinceLastSeen(t *testing.T) {
	all := []Release{
		{Version: "0.5.0", Features: []string{"a", "b"}, Fixes: []string{"c"}},
		{Version: "0.4.10", Fixes: []string{"d"}, Other: []string{"e"}},
		{Version: "0.4.9", Features: []string{"old"}},
	}
	got := Summary("0.5.0", Between(all, "0.4.9", "0.5.0"))
	if first := strings.Split(got, "\n")[0]; first != "Updated to 0.5.0. Got 2 features, 2 bug fixes, and 1 other change." {
		t.Fatalf("headline: %q", first)
	}
	if strings.Contains(got, "old") {
		t.Fatal("a release the user already had was counted")
	}
}

func TestCheckRemembersAndStaysQuiet(t *testing.T) {
	path := filepath.Join(t.TempDir(), "version.json")
	t.Setenv("NITI_VERSION_FILE", path)
	if got := Check("0.4.9"); got != "" {
		t.Fatalf("first install should say nothing, got %q", got)
	}
	if got := Check("0.4.9"); got != "" {
		t.Fatalf("same version should say nothing, got %q", got)
	}
	_ = os.WriteFile(path, []byte(`{"lastSeen":"0.4.7"}`), 0o600)
	if got := Check("0.4.9"); !strings.HasPrefix(got, "Updated to 0.4.9. Got ") {
		t.Fatalf("update should be announced, got %q", got)
	}
	var s state
	b, _ := os.ReadFile(path)
	_ = json.Unmarshal(b, &s)
	if s.LastSeen != "0.4.9" {
		t.Fatalf("lastSeen = %q", s.LastSeen)
	}
}

func TestCompareIsNumeric(t *testing.T) {
	if compare("0.4.10", "0.4.9") <= 0 || compare("1.0.0", "0.9.9") <= 0 || compare("0.4.9", "0.4.9") != 0 {
		t.Fatal("versions compared as strings")
	}
}

func TestShippedChangelogParses(t *testing.T) {
	var all []Release
	if err := json.Unmarshal(changelogJSON, &all); err != nil || len(all) == 0 {
		t.Fatalf("changelog.json: %v", err)
	}
}
