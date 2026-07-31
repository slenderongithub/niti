// Package theme is the TUI's palette. One theme is active at a time; Use() swaps it and every
// package-level color below repoints, so call sites read `theme.Accent` and never learn a theme
// exists. Mutable globals are safe here: Bubbletea drives Update/View on a single goroutine.
package theme

import (
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

var Themes = map[string]Theme{
	"amux": {
		Name: "amux", BgDeep: "#0b0d14", BgPane: "#11141f", Fg: "#dfe3f0", Muted: "#7c8299",
		Line: "#262b3d", Accent: "#7aa2ff", Alt: "#f5c542",
		Green: "#4ade80", Red: "#f87171", Amber: "#fbbf24", Blue: "#60a5fa", Pink: "#f472b6",
		Agents: []lipgloss.Color{"#a78bfa", "#60a5fa", "#4ade80", "#fbbf24", "#f472b6", "#22d3ee", "#fb923c", "#a3e635", "#e879f9", "#2dd4bf", "#f87171", "#818cf8"},
	},
	"midnight": {
		Name: "midnight", BgDeep: "#08090a", BgPane: "#0f1113", Fg: "#e6e6e6", Muted: "#6b7280",
		Line: "#1f2225", Accent: "#22d3ee", Alt: "#e0af68",
		Green: "#9ece6a", Red: "#f7768e", Amber: "#e0af68", Blue: "#7dcfff", Pink: "#bb9af7",
		Agents: []lipgloss.Color{"#7dcfff", "#9ece6a", "#e0af68", "#bb9af7", "#f7768e", "#2ac3de", "#ff9e64", "#73daca", "#c0caf5", "#b4f9f8", "#ff007c", "#41a6b5"},
	},
	"nord": {
		Name: "nord", BgDeep: "#242933", BgPane: "#2e3440", Fg: "#eceff4", Muted: "#7b88a1",
		Line: "#3b4252", Accent: "#88c0d0", Alt: "#ebcb8b",
		Green: "#a3be8c", Red: "#bf616a", Amber: "#ebcb8b", Blue: "#81a1c1", Pink: "#b48ead",
		Agents: []lipgloss.Color{"#88c0d0", "#a3be8c", "#ebcb8b", "#b48ead", "#bf616a", "#81a1c1", "#8fbcbb", "#d08770", "#5e81ac", "#a3be8c", "#b48ead", "#88c0d0"},
	},
	"gruvbox": {
		Name: "gruvbox", BgDeep: "#1d2021", BgPane: "#282828", Fg: "#ebdbb2", Muted: "#928374",
		Line: "#3c3836", Accent: "#83a598", Alt: "#fabd2f",
		Green: "#b8bb26", Red: "#fb4934", Amber: "#fabd2f", Blue: "#83a598", Pink: "#d3869b",
		Agents: []lipgloss.Color{"#fabd2f", "#83a598", "#b8bb26", "#d3869b", "#fe8019", "#8ec07c", "#fb4934", "#d5c4a1", "#458588", "#689d6a", "#d79921", "#cc241d"},
	},
	"rosepine": {
		Name: "rosepine", BgDeep: "#191724", BgPane: "#1f1d2e", Fg: "#e0def4", Muted: "#6e6a86",
		Line: "#26233a", Accent: "#c4a7e7", Alt: "#f6c177",
		Green: "#9ccfd8", Red: "#eb6f92", Amber: "#f6c177", Blue: "#31748f", Pink: "#ebbcba",
		Agents: []lipgloss.Color{"#c4a7e7", "#ebbcba", "#9ccfd8", "#f6c177", "#eb6f92", "#31748f", "#e0def4", "#c4a7e7", "#9ccfd8", "#f6c177", "#ebbcba", "#eb6f92"},
	},
	"matrix": {
		Name: "matrix", BgDeep: "#000000", BgPane: "#050a05", Fg: "#c8facc", Muted: "#3f7a4a",
		Line: "#123a1c", Accent: "#39ff14", Alt: "#a6ff00",
		Green: "#39ff14", Red: "#ff5555", Amber: "#a6ff00", Blue: "#00e5c0", Pink: "#7dff9a",
		Agents: []lipgloss.Color{"#39ff14", "#7dff9a", "#00e5c0", "#a6ff00", "#c8facc", "#2ecc40", "#00ff9c", "#5cff5c", "#9dffb0", "#00c853", "#76ff03", "#69f0ae"},
	},
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

	current = "amux"
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
