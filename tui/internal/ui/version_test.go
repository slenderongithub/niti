package ui

import (
	"encoding/json"
	"os"
	"testing"
)

// The TUI's displayed version is a Go constant, and package.json is what npm publishes — two copies
// of one fact. They drifted: the TUI kept saying 0.2.0 through the 0.3.0 and 0.3.1 releases. This
// fails the build the moment they disagree, so bumping one without the other can't ship.
func TestVersionMatchesPackageJSON(t *testing.T) {
	raw, err := os.ReadFile("../../../package.json")
	if err != nil {
		t.Skipf("package.json not reachable from here: %v", err)
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		t.Fatal(err)
	}
	if Version != pkg.Version {
		t.Errorf("tui/internal/ui.Version = %q but package.json says %q — bump both", Version, pkg.Version)
	}
}
