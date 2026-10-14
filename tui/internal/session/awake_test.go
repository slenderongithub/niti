package session

import (
	"strings"
	"testing"

	"github.com/niti/tui/internal/api"
)

// /awake: the header chip follows the core's awake events, and /clear doesn't drop it.
func TestAwakeChip(t *testing.T) {
	m := model(1)
	if strings.Contains(m.header(100), "awake") {
		t.Fatal("chip shown while off")
	}
	m.apply(api.Event{Kind: "awake", State: "open"})
	if !strings.Contains(m.header(100), "awake · lid open") {
		t.Fatalf("no lid-open chip: %q", m.header(100))
	}
	m.apply(api.Event{Kind: "session_reset"})
	m.apply(api.Event{Kind: "awake", State: "lid"})
	if h := m.header(100); !strings.Contains(h, "awake") || strings.Contains(h, "lid open") {
		t.Fatalf("wrong chip: %q", h)
	}
	m.apply(api.Event{Kind: "awake", State: "off"})
	if strings.Contains(m.header(100), "awake") {
		t.Fatal("chip left behind after off")
	}
}
