// Package theme is the TUI's palette. One theme is active at a time; Use() swaps it and every
// package-level color below repoints, so call sites read `theme.Accent` and never learn a theme
// exists. Mutable globals are safe here: Bubbletea drives Update/View on a single goroutine.
package theme

import (
	_ "embed"
	"encoding/json"
	"sort"

	"github.com/charmbracelet/lipgloss"
)

// Theme is a full dark palette. Every theme is dark by design — amux paints its own background
// rather than inheriting the terminal's, so the frame reads as one surface instead of floating
// boxes over whatever the user's terminal happens to be.
type Theme struct {
	Name   string
	BgDeep lipgloss.Color // app canvas, behind everything
	BgPane lipgloss.Color // sidebar / raised panels
	Fg     lipgloss.Color // primary text
	Muted  lipgloss.Color // labels, secondary text
	Line   lipgloss.Color // borders, rules
	Accent lipgloss.Color // brand + BUILD mode
	Alt    lipgloss.Color // PLAN mode — deliberately the complement of Accent
	Green  lipgloss.Color
	Red    lipgloss.Color
	Amber  lipgloss.Color
	Blue   lipgloss.Color
	Pink   lipgloss.Color
	Agents []lipgloss.Color // per-agent identity colors, cycled by roster index
}

// palettes.json is the single source of truth for theme colors — the web dashboard serves this
// same file (GET /palettes.json, resolved from this path) so the TUI and the web control center
// offer identical palettes instead of two hand-maintained color tables drifting apart. It lives
// here rather than at the repo root because Go's //go:embed cannot reach outside this module.
//
//go:embed palettes.json
var palettesJSON []byte

// paletteFile is the on-disk shape of one palettes.json entry.
type paletteFile struct {
	Name   string `json:"name"`
	Bg     string `json:"bg"`
	Panel  string `json:"panel"`
	Fg     string `json:"fg"`
	Muted  string `json:"muted"`
	Line   string `json:"line"`
	Accent string `json:"accent"`
	Alt    string `json:"alt"`
	Green  string `json:"green"`
	Red    string `json:"red"`
	Amber  string `json:"amber"`
	Blue   string `json:"blue"`
	Pink   string `json:"pink"`
}

var Themes = loadThemes()

func loadThemes() map[string]Theme {
	var raw []paletteFile
	if err := json.Unmarshal(palettesJSON, &raw); err != nil {
		panic("theme: palettes.json is invalid: " + err.Error())
	}
	out := make(map[string]Theme, len(raw))
	for _, p := range raw {
		// Per-agent identity colors are derived, not hand-authored: AgentColor()'s existing
		// index%len(palette) wrap means handing it just these 7 already cycles correctly — no
		// need to materialize a longer repeated slice.
		semantic := []lipgloss.Color{
			lipgloss.Color(p.Accent), lipgloss.Color(p.Alt), lipgloss.Color(p.Green),
			lipgloss.Color(p.Red), lipgloss.Color(p.Amber), lipgloss.Color(p.Blue), lipgloss.Color(p.Pink),
		}
		out[p.Name] = Theme{
			Name: p.Name, BgDeep: lipgloss.Color(p.Bg), BgPane: lipgloss.Color(p.Panel),
			Fg: lipgloss.Color(p.Fg), Muted: lipgloss.Color(p.Muted), Line: lipgloss.Color(p.Line),
			Accent: lipgloss.Color(p.Accent), Alt: lipgloss.Color(p.Alt),
			Green: lipgloss.Color(p.Green), Red: lipgloss.Color(p.Red), Amber: lipgloss.Color(p.Amber),
			Blue: lipgloss.Color(p.Blue), Pink: lipgloss.Color(p.Pink),
			Agents: semantic,
		}
	}
	return out
}

// The active theme's colors, read directly by every render site.
var (
	BgDeep lipgloss.Color
	BgPane lipgloss.Color
	Fg     lipgloss.Color
	Muted  lipgloss.Color
	Line   lipgloss.Color
	Accent lipgloss.Color
	Alt    lipgloss.Color
	Green  lipgloss.Color
	Red    lipgloss.Color
	Amber  lipgloss.Color
	Blue   lipgloss.Color
	Pink   lipgloss.Color

	current = "neon graveyard"
	palette []lipgloss.Color
)

func init() { Use(current) }

// Use activates a theme by name. Reports false for an unknown name, leaving the current theme in
// place — a typo'd /theme shouldn't blank the UI.
func Use(name string) bool {
	t, ok := Themes[name]
	if !ok {
		return false
	}
	current = name
	BgDeep, BgPane, Fg, Muted, Line = t.BgDeep, t.BgPane, t.Fg, t.Muted, t.Line
	Accent, Alt = t.Accent, t.Alt
	Green, Red, Amber, Blue, Pink = t.Green, t.Red, t.Amber, t.Blue, t.Pink
	palette = t.Agents
	return true
}

func Current() string { return current }

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

var avatars = []string{"◆", "▲", "●", "■", "★", "✦", "◈", "❖", "⬢", "⬟", "✱", "✚"}

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
