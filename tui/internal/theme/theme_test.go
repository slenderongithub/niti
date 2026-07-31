package theme

import "testing"

func TestUseRejectsUnknownWithoutChangingAnything(t *testing.T) {
	Use("amux")
	before := Accent
	if Use("no-such-theme") {
		t.Fatal("an unknown theme must not be accepted")
	}
	if Current() != "amux" || Accent != before {
		t.Errorf("a rejected theme must leave the palette alone, got %q/%v", Current(), Accent)
	}
	if !Use("nord") || Current() != "nord" {
		t.Fatalf("Use should switch to a known theme, got %q", Current())
	}
	if Accent == before {
		t.Error("switching themes must repoint the palette")
	}
	Use("amux")
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
	Use("amux")
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
	Use("amux")
}
