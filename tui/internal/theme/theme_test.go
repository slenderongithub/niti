package theme

import "testing"

func TestUseRejectsUnknownWithoutChangingAnything(t *testing.T) {
	Use("neon graveyard")
	before := Accent
	if Use("no-such-theme") {
		t.Fatal("an unknown theme must not be accepted")
	}
	if Current() != "neon graveyard" || Accent != before {
		t.Errorf("a rejected theme must leave the palette alone, got %q/%v", Current(), Accent)
	}
	if !Use("desert static") || Current() != "desert static" {
		t.Fatalf("Use should switch to a known theme, got %q", Current())
	}
	if Accent == before {
		t.Error("switching themes must repoint the palette")
	}
	Use("neon graveyard")
}

// Next walks every theme exactly once and returns to where it started — the ctrl+t contract.
func TestNextCyclesThroughEveryThemeAndWraps(t *testing.T) {
	names := Names()
	Use(names[0])
	seen := map[string]bool{names[0]: true}
	for i := 1; i < len(names); i++ {
		n := Next()
		if seen[n] {
			t.Fatalf("Next repeated %q after %d steps — it must visit each theme once", n, i)
		}
		seen[n] = true
	}
	if got := Next(); got != names[0] {
		t.Errorf("Next should wrap back to %q, got %q", names[0], got)
	}
	Use("neon graveyard")
}

// Every theme must carry a usable agent palette — AgentColor indexes into it with no bounds check
// beyond the modulo, so an empty slice would panic the whole TUI on the first render.
func TestEveryThemeHasAgentColors(t *testing.T) {
	for name, th := range Themes {
		if len(th.Agents) == 0 {
			t.Errorf("theme %q has no agent colors", name)
			continue
		}
		Use(name)
		if AgentColor(0) == "" || AgentColor(97) == "" {
			t.Errorf("theme %q produced an empty agent color", name)
		}
	}
	Use("neon graveyard")
}

// The 5 palettes are the single source of truth shared with the web dashboard (server.ts serves
// the same palettes.json) — this pins the exact set and the semantic-color derivation so a typo in
// the JSON, or a name collision, fails a test instead of quietly reaching the TUI/web mismatched.
func TestPalettesJSONIsTheExpectedFiveDistinctThemes(t *testing.T) {
	want := []string{"deep sea signal", "desert static", "hazard tape", "neon graveyard", "terminal candy"}
	got := Names()
	if len(got) != len(want) {
		t.Fatalf("expected %d palettes, got %d: %v", len(want), len(got), got)
	}
	for i, n := range want {
		if got[i] != n {
			t.Errorf("palette %d: expected %q, got %q", i, n, got[i])
		}
	}
	for _, th := range Themes {
		if len(th.Agents) != 7 {
			t.Errorf("theme %q: expected 7 derived agent colors (the semantic set), got %d", th.Name, len(th.Agents))
		}
	}
}

// Light mode keeps the theme but puts every surface on a light background and darkens the accents,
// and turning it off restores the dark palette exactly.
func TestLightModeSwapsSurfacesAndRestores(t *testing.T) {
	Use("neon graveyard")
	dark, darkGreen := BgDeep, Green
	SetLight(true)
	defer SetLight(false)
	if Current() != "neon graveyard" || !IsLight() {
		t.Fatalf("light mode must keep the theme, got %q light=%v", Current(), IsLight())
	}
	if BgDeep == dark || Fg != lightFg || Green == darkGreen {
		t.Errorf("light palette not applied: bg=%v fg=%v green=%v", BgDeep, Fg, Green)
	}
	SetLight(false)
	if BgDeep != dark || Green != darkGreen {
		t.Errorf("dark palette not restored: bg=%v green=%v", BgDeep, Green)
	}
}
