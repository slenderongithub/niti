package theme

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/charmbracelet/lipgloss"
)

func TestUseRejectsUnknownWithoutChangingAnything(t *testing.T) {
	Use("graphite")
	before := Accent
	if Use("no-such-theme") {
		t.Fatal("an unknown theme must not be accepted")
	}
	if Current() != "graphite" || Accent != before {
		t.Errorf("a rejected theme must leave the palette alone, got %q/%v", Current(), Accent)
	}
	if !Use("ember") || Current() != "ember" {
		t.Fatalf("Use should switch to a known theme, got %q", Current())
	}
	if Accent == before {
		t.Error("switching themes must repoint the palette")
	}
	Use("graphite")
}

// Next walks every theme exactly once and returns to where it started — the ctrl+t contract.
func TestNextCyclesThroughEveryThemeAndWraps(t *testing.T) {
	names := Choices() // the dark set; light siblings only cycle while light mode is on
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
	Use("graphite")
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
	Use("graphite")
}

// palettes.json is shared with the web dashboard and the niti IDE, so every entry must parse and
// validate — a skipped built-in would silently vanish from all three surfaces.
func TestEveryBuiltInPaletteLoads(t *testing.T) {
	var raw []paletteFile
	if err := json.Unmarshal(palettesJSON, &raw); err != nil {
		t.Fatal(err)
	}
	for _, p := range raw {
		if _, ok := p.toTheme(); !ok {
			t.Errorf("built-in palette %q fails validation", p.Name)
		}
	}
	if len(Themes) < len(raw) {
		t.Errorf("loaded %d themes from %d palettes", len(Themes), len(raw))
	}
}

// The "not neon" rule, enforced: body text reads comfortably, muted text still clears AA, and every
// accent and agent color is legible against the canvas it's drawn on (4.5:1 on light themes, where
// accents are used as text; 3:1 on dark ones, where they mark rather than carry text).
func TestPalettesMeetContrastFloors(t *testing.T) {
	for name, th := range Themes {
		check := func(what string, fg, bg lipgloss.Color, min float64) {
			if r := contrast(fg, bg); r < min {
				t.Errorf("%s: %s contrast %.2f < %.1f", name, what, r, min)
			}
		}
		check("fg/bg", th.Fg, th.BgDeep, 7)
		check("fg/panel", th.Fg, th.BgPane, 7)
		check("muted/bg", th.Muted, th.BgDeep, 4.5)
		accentMin := 3.0
		if th.Light {
			accentMin = 4.5
		}
		for i, c := range append([]lipgloss.Color{th.Accent, th.Alt, th.Green, th.Red, th.Amber, th.Blue, th.Pink}, th.Agents...) {
			check(fmt.Sprintf("color %d", i), c, th.BgDeep, accentMin)
		}
	}
}

func contrast(a, b lipgloss.Color) float64 {
	lum := func(c lipgloss.Color) float64 {
		var r, g, bl int
		fmt.Sscanf(string(c), "#%02x%02x%02x", &r, &g, &bl)
		ch := func(v int) float64 {
			f := float64(v) / 255
			if f <= 0.03928 {
				return f / 12.92
			}
			return math.Pow((f+0.055)/1.055, 2.4)
		}
		return 0.2126*ch(r) + 0.7152*ch(g) + 0.0722*ch(bl)
	}
	la, lb := lum(a), lum(b)
	if la < lb {
		la, lb = lb, la
	}
	return (la + 0.05) / (lb + 0.05)
}

// A theme saved under its old name (agents.yaml `theme: neon graveyard`) keeps loading.
func TestFormerNamesResolve(t *testing.T) {
	if !Use("neon graveyard") || Current() != "graphite" {
		t.Fatalf("old name should load as graphite, got %q", Current())
	}
}

// A hand-written theme in the user dir is offered; a malformed one is skipped, not fatal.
func TestUserThemesLoadAndBadOnesAreSkipped(t *testing.T) {
	dir := t.TempDir()
	good := `{"name":"mine","bg":"#101010","panel":"#202020","fg":"#eeeeee","muted":"#999999","line":"#333333",
	  "accent":"#88aaff","alt":"#cc99cc","green":"#88cc88","red":"#dd7777","amber":"#ddbb66","blue":"#66bbcc","pink":"#dd99bb"}`
	os.WriteFile(filepath.Join(dir, "mine.json"), []byte(good), 0o644)
	os.WriteFile(filepath.Join(dir, "broken.json"), []byte(`{"name":"broken","bg":"red"}`), 0o644)
	themes, _ := loadThemes(palettesJSON, dir)
	if _, ok := themes["mine"]; !ok {
		t.Error("user theme not loaded")
	}
	if _, ok := themes["broken"]; ok {
		t.Error("malformed user theme should be skipped")
	}
	if themes["mine"].Surface != "#202020" {
		t.Error("surface should default to panel when a user theme omits it")
	}
}

// Every dark theme has an authored light sibling, and light mode moves between the pair.
func TestEveryDarkThemeHasALightSiblingAndLightModeMovesBetweenThem(t *testing.T) {
	var raw []paletteFile
	json.Unmarshal(palettesJSON, &raw)
	for _, p := range raw {
		if p.Light {
			continue
		}
		if sib, ok := Themes[p.Name+" light"]; !ok || !sib.Light {
			t.Errorf("%q has no light sibling", p.Name)
		}
	}
	Use("tide")
	SetLight(true)
	if Current() != "tide light" || !IsLight() {
		t.Fatalf("light mode on tide should give tide light, got %q", Current())
	}
	SetLight(false)
	if Current() != "tide" {
		t.Fatalf("light mode off should return to tide, got %q", Current())
	}
	if !Use("paper") || Current() != "graphite light" {
		t.Errorf("the former light theme name should load graphite light, got %q", Current())
	}
	Use("graphite")
}

// The picker lists dark themes only, or only light siblings while light mode is on — never both.
func TestChoicesFollowLightMode(t *testing.T) {
	Use("graphite")
	for _, n := range Choices() {
		if Themes[n].Light {
			t.Errorf("light theme %q offered with light mode off", n)
		}
	}
	SetLight(true)
	defer SetLight(false)
	for _, n := range Choices() {
		if !Themes[n].Light {
			t.Errorf("dark theme %q offered with light mode on", n)
		}
	}
	if !Pick("ember") || Current() != "ember light" {
		t.Errorf("/theme ember in light mode should apply ember light, got %q", Current())
	}
}
