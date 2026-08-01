package session

import (
	"testing"
	"time"

	"github.com/amux/tui/internal/api"
)

// Rendering every tab must not panic — against an empty roster with no history, and against a
// populated stats payload at tiny and normal terminal sizes (zero-division in bars/charts, negative
// slice bounds, and the heatmap's week math are the crash-prone spots).
func TestSettingsRenderNoPanic(t *testing.T) {
	m := Model{agents: map[string]*agentState{}, mode: "build", status: "connected", root: "/tmp/x"}
	loaded := api.Stats{
		PerDay:   []api.StatsDay{{Date: "2026-07-28", Tokens: 5000, Msgs: 10}, {Date: "2026-07-31", Tokens: 200, Msgs: 2}},
		PerModel: []api.StatsModel{{Name: "google/gemini-2.5-pro", InTokens: 8000, OutTokens: 3000, Msgs: 12, Usd: 0.3, Priced: true}},
		Sessions: 4, InTokens: 8000, OutTokens: 3000, LongestSessionMs: 100_000_000, TotalUsd: 0.3, CostComplete: true,
	}
	for _, s := range []settings{{}, {statsLoaded: true, stats: loaded}, {statsLoaded: true, statsErr: "boom"}} {
		for tab := 0; tab < len(settingsTabs); tab++ {
			for st := 0; st < 2; st++ {
				m.sett = s
				m.sett.open, m.sett.tab, m.sett.statsTab = true, tab, st
				for _, wh := range [][2]int{{20, 8}, {100, 30}, {1, 1}} {
					if out := m.settingsView(wh[0], wh[1]); out == "" {
						t.Fatalf("tab %d rendered empty at %v", tab, wh)
					}
				}
			}
		}
	}
	if m.welcomeView(80, 10) == "" {
		t.Fatal("welcome rendered empty")
	}
}

func TestSettingsTabFor(t *testing.T) {
	for name, want := range map[string]int{"settings": 0, "status": 1, "config": 2, "usage": 3, "stats": 4} {
		if got, ok := settingsTabFor(name); !ok || got != want {
			t.Errorf("%s → (%d,%v), want %d", name, got, ok, want)
		}
	}
	if _, ok := settingsTabFor("model"); ok {
		t.Error("unrelated command must not be claimed by the settings overlay")
	}
}

// The streak math is the substantive logic: consecutive active days, and the current run allowed to
// end yesterday so a streak isn't declared broken until a full day is missed.
func TestStreaksAt(t *testing.T) {
	today := time.Date(2026, 8, 1, 12, 0, 0, 0, time.Local)
	set := map[string]bool{
		"2026-07-20": true, // isolated
		"2026-07-28": true, // ── a 4-day run: 28,29,30,31 ──
		"2026-07-29": true,
		"2026-07-30": true,
		"2026-07-31": true, // ends yesterday → current streak counts it
	}
	longest, current := streaksAt(set, today)
	if longest != 4 {
		t.Errorf("longest streak = %d, want 4", longest)
	}
	if current != 4 {
		t.Errorf("current streak = %d, want 4 (run ending yesterday still live)", current)
	}
	// A two-day gap breaks the current streak.
	set2 := map[string]bool{"2026-07-28": true, "2026-07-29": true}
	if _, cur := streaksAt(set2, today); cur != 0 {
		t.Errorf("current streak after a 2-day gap = %d, want 0", cur)
	}
}

func TestActiveSpanAndMostActive(t *testing.T) {
	today := time.Date(2026, 8, 1, 0, 0, 0, 0, time.Local)
	days := []api.StatsDay{{Date: "2026-07-28", Tokens: 100}, {Date: "2026-07-30", Tokens: 900}, {Date: "2026-07-31", Tokens: 0}}
	active, span := activeSpanAt(days, today)
	if active != 2 { // the 0-token day doesn't count as active
		t.Errorf("active = %d, want 2", active)
	}
	if span != 5 { // Jul 28 → Aug 1 inclusive
		t.Errorf("span = %d, want 5", span)
	}
	if d := mostActiveDay(days); d != "Jul 30" {
		t.Errorf("most active day = %q, want \"Jul 30\"", d)
	}
}

func TestFormatters(t *testing.T) {
	if got := dur(100_000_000); got != "1d 3h 46m" {
		t.Errorf("dur = %q, want \"1d 3h 46m\"", got)
	}
	if got := fmtTokLong(20_200_000); got != "20.2m" {
		t.Errorf("fmtTokLong = %q, want \"20.2m\"", got)
	}
	if got := shortModel("google/gemini-2.5-pro"); got != "gemini-2.5-pro" {
		t.Errorf("shortModel = %q", got)
	}
}
