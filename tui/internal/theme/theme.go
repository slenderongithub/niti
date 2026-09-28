// Package theme is the TUI's palette. One theme is active at a time; Use() swaps it and every
// package-level color below repoints, so call sites read `theme.Accent` and never learn a theme
// exists. Mutable globals are safe here: Bubbletea drives Update/View on a single goroutine.
package theme

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// Theme is one palette. Dark themes tint their near-black background toward the theme's hue and
// build depth from three small value steps (bg → surface → panel) rather than from borders; accents
// are desaturated pastels that clear WCAG AA on bg (see theme_test.go), so no single element
// shouts. niti paints its own background rather than inheriting the terminal's, so the frame reads
// as one surface instead of floating boxes over whatever the terminal happens to be.
type Theme struct {
	Name    string
	Aliases []string // former names, so a saved `theme:` from before a rename still loads
	Light   bool
	BgDeep  lipgloss.Color // app canvas, behind everything
	Surface lipgloss.Color // inputs, chips — one step up from the canvas
	BgPane  lipgloss.Color // sidebar / raised panels — two steps up
	Fg      lipgloss.Color // primary text
	Muted   lipgloss.Color // labels, secondary text
	Line    lipgloss.Color // borders, rules
	Accent  lipgloss.Color // primary: brand, BUILD mode, focus
	Alt     lipgloss.Color // secondary: PLAN mode
	Green   lipgloss.Color // success
	Red     lipgloss.Color // error
	Amber   lipgloss.Color // warning
	Blue    lipgloss.Color // info
	Pink    lipgloss.Color
	Agents  []lipgloss.Color // per-agent identity colors, cycled by roster index; never red
}

// palettes.json is the single source of truth for theme colors — the web dashboard serves this
// same file (GET /palettes.json, resolved from this path) so the TUI and the web control center
// offer identical palettes instead of two hand-maintained color tables drifting apart. It lives
// here rather than at the repo root because Go's //go:embed cannot reach outside this module.
// The niti IDE reads it too, so keys are only ever added, never renamed or removed.
//
//go:embed palettes.json
var palettesJSON []byte

// paletteFile is the on-disk shape of one palettes.json entry (and of a user theme file).
type paletteFile struct {
	Name    string   `json:"name"`
	Aliases []string `json:"aliases"`
	Light   bool     `json:"light"`
	Bg      string   `json:"bg"`
	Surface string   `json:"surface"`
	Panel   string   `json:"panel"`
	Fg      string   `json:"fg"`
	Muted   string   `json:"muted"`
	Line    string   `json:"line"`
	Accent  string   `json:"accent"`
	Alt     string   `json:"alt"`
	Green   string   `json:"green"`
	Red     string   `json:"red"`
	Amber   string   `json:"amber"`
	Blue    string   `json:"blue"`
	Pink    string   `json:"pink"`
	Agents  []string `json:"agents"`
}

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// toTheme validates a palette — every color a #rrggbb, the name non-empty — so a hand-written
// user theme with a typo is skipped instead of painting the UI with lipgloss's no-color fallback.
func (p paletteFile) toTheme() (Theme, bool) {
	if p.Surface == "" {
		p.Surface = p.Panel
	}
	required := []string{p.Bg, p.Surface, p.Panel, p.Fg, p.Muted, p.Line, p.Accent, p.Alt, p.Green, p.Red, p.Amber, p.Blue, p.Pink}
	for _, c := range required {
		if !hexColor.MatchString(c) {
			return Theme{}, false
		}
	}
	if strings.TrimSpace(p.Name) == "" {
		return Theme{}, false
	}
	agents := p.Agents
	if len(agents) == 0 {
		agents = []string{p.Accent, p.Alt, p.Green, p.Amber, p.Blue, p.Pink}
	}
	t := Theme{
		Name: p.Name, Aliases: p.Aliases, Light: p.Light,
		BgDeep: lipgloss.Color(p.Bg), Surface: lipgloss.Color(p.Surface), BgPane: lipgloss.Color(p.Panel),
		Fg: lipgloss.Color(p.Fg), Muted: lipgloss.Color(p.Muted), Line: lipgloss.Color(p.Line),
		Accent: lipgloss.Color(p.Accent), Alt: lipgloss.Color(p.Alt),
		Green: lipgloss.Color(p.Green), Red: lipgloss.Color(p.Red), Amber: lipgloss.Color(p.Amber),
		Blue: lipgloss.Color(p.Blue), Pink: lipgloss.Color(p.Pink),
	}
	for _, a := range agents {
		if !hexColor.MatchString(a) {
			return Theme{}, false
		}
		t.Agents = append(t.Agents, lipgloss.Color(a))
	}
	return t, true
}

var Themes, aliases = loadThemes(palettesJSON, userThemesDir())

// userThemesDir is where hand-written themes live: one JSON file per theme, same shape as a
// palettes.json entry. NITI_THEMES_DIR overrides it (tests, portable setups).
func userThemesDir() string {
	if d := os.Getenv("NITI_THEMES_DIR"); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "niti", "themes")
}

func loadThemes(builtin []byte, userDir string) (map[string]Theme, map[string]string) {
	var raw []paletteFile
	if err := json.Unmarshal(builtin, &raw); err != nil {
		panic("theme: palettes.json is invalid: " + err.Error())
	}
	// User themes load after the built-ins, so one can deliberately replace a built-in by name.
	if userDir != "" {
		files, _ := filepath.Glob(filepath.Join(userDir, "*.json"))
		for _, f := range files {
			var p paletteFile
			if b, err := os.ReadFile(f); err == nil && json.Unmarshal(b, &p) == nil {
				raw = append(raw, p)
			}
		}
	}
	themes := make(map[string]Theme, len(raw))
	alias := map[string]string{}
	for _, p := range raw {
		t, ok := p.toTheme()
		if !ok {
			continue // a malformed user theme is skipped, never fatal
		}
		themes[t.Name] = t
		for _, a := range t.Aliases {
			alias[a] = t.Name
		}
	}
	return themes, alias
}

// The active theme's colors, read directly by every render site.
var (
	BgDeep  lipgloss.Color
	Surface lipgloss.Color
	BgPane  lipgloss.Color
	Fg      lipgloss.Color
	Muted   lipgloss.Color
	Line    lipgloss.Color
	Accent  lipgloss.Color
	Alt     lipgloss.Color
	Green   lipgloss.Color
	Red     lipgloss.Color
	Amber   lipgloss.Color
	Blue    lipgloss.Color
	Pink    lipgloss.Color

	current   = "graphite"
	lightFrom string // the dark theme SetLight(true) switched away from, to return to
	palette   []lipgloss.Color
)

func init() { Use(current) }

// Resolve maps a former theme name to its current one; any other name passes through unchanged.
func Resolve(name string) string {
	if to, ok := aliases[name]; ok {
		return to
	}
	return name
}

// Use activates a theme by name (or former name). Reports false for an unknown name, leaving the
// current theme in place — a typo'd /theme shouldn't blank the UI.
func Use(name string) bool {
	name = Resolve(name)
	t, ok := Themes[name]
	if !ok {
		return false
	}
	current = name
	BgDeep, Surface, BgPane, Fg, Muted, Line = t.BgDeep, t.Surface, t.BgPane, t.Fg, t.Muted, t.Line
	Accent, Alt = t.Accent, t.Alt
	Green, Red, Amber, Blue, Pink = t.Green, t.Red, t.Amber, t.Blue, t.Pink
	palette = t.Agents
	return true
}

func Current() string { return current }

// SetLight is the Settings "light mode" switch. Every dark theme has an authored light sibling
// named "<theme> light" — same hue identity, its own values, not an inversion — and the switch
// moves between the two. A theme with no sibling (a user theme) falls back to the first light
// theme, and switching off returns to whatever dark theme that replaced.
func SetLight(on bool) {
	if on == IsLight() {
		return
	}
	if on {
		if Use(current + " light") {
			return
		}
		for _, n := range Names() {
			if Themes[n].Light {
				lightFrom = current
				Use(n)
				return
			}
		}
		return
	}
	switch {
	case lightFrom != "":
		Use(lightFrom)
	case Use(strings.TrimSuffix(current, " light")):
	default:
		Use("graphite")
	}
	lightFrom = ""
}

func IsLight() bool { return Themes[current].Light }

// Names lists themes in a stable order, so "the next theme" means the same thing every launch.
func Names() []string {
	names := make([]string, 0, len(Themes))
	for n := range Themes {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// Next activates the theme after the current one, wrapping — what ctrl+t is bound to.
func Next() string {
	names := Names()
	for i, n := range names {
		if n == current {
			Use(names[(i+1)%len(names)])
			return current
		}
	}
	Use(names[0])
	return current
}

// No ★: the sidebar marks the lead agent with ★, so the fifth agent's avatar read as a second lead.
var avatars = []string{"◆", "▲", "●", "■", "✦", "◈", "❖", "⬢", "⬟", "✱", "✚", "◇"}

// AgentColor is an agent's identity color by roster position — stable within a session, distinct
// across many agents, and re-themed along with everything else.
func AgentColor(index int) lipgloss.Color { return palette[index%len(palette)] }

func Avatar(index int) string { return avatars[index%len(avatars)] }

// MessageColor maps an AgentMessage kind to its edge/log color (matches the web dashboard).
func MessageColor(kind string) lipgloss.Color {
	switch kind {
	case "question":
		return Amber
	case "answer":
		return Green
	case "handoff", "artifact":
		return Blue
	case "review":
		return Pink
	case "note":
		return Alt
	default:
		return Accent
	}
}

// StatusColor maps a task/agent status to a color.
func StatusColor(status string) lipgloss.Color {
	switch status {
	case "done":
		return Green
	case "failed":
		return Red
	case "in_progress", "working":
		return Blue
	default:
		return Muted
	}
}

// Tint is c laid 30% over the canvas — the fill for chips, banners and the selected row, so a
// saturated color marks a small area without shouting across a large one (Textual's `$x-muted`).
func Tint(c lipgloss.Color) lipgloss.Color { return blend(c, BgDeep, 0.3) }

// blend mixes a over b at weight w (1 = all a). Non-hex input is returned unchanged.
func blend(a, b lipgloss.Color, w float64) lipgloss.Color {
	var ar, ag, ab, br, bg, bb int
	if _, err := fmt.Sscanf(string(a), "#%02x%02x%02x", &ar, &ag, &ab); err != nil {
		return a
	}
	if _, err := fmt.Sscanf(string(b), "#%02x%02x%02x", &br, &bg, &bb); err != nil {
		return a
	}
	mix := func(x, y int) int { return int(float64(x)*w + float64(y)*(1-w) + 0.5) }
	return lipgloss.Color(fmt.Sprintf("#%02x%02x%02x", mix(ar, br), mix(ag, bg), mix(ab, bb)))
}
