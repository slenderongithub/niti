package theme

import "github.com/charmbracelet/lipgloss"

// Brand + status palette. Truecolor; lipgloss downgrades to 256/16/no-color per terminal.
var (
	Violet = lipgloss.Color("#a78bfa")
	Muted  = lipgloss.Color("#8b90a6")
	Green  = lipgloss.Color("#4ade80")
	Red    = lipgloss.Color("#f87171")
	Amber  = lipgloss.Color("#fbbf24")
	Blue   = lipgloss.Color("#60a5fa")
	Pink   = lipgloss.Color("#f472b6")
	Line   = lipgloss.Color("#262b3d")
)

// A wide palette so arbitrary agent counts get distinct colors (no 6-color cap).
var agentPalette = []lipgloss.Color{
	"#a78bfa", "#60a5fa", "#4ade80", "#fbbf24", "#f472b6", "#22d3ee",
	"#fb923c", "#a3e635", "#e879f9", "#2dd4bf", "#f87171", "#818cf8",
}

var avatars = []string{"◆", "▲", "●", "■", "★", "✦", "◈", "❖", "⬢", "⬟", "✱", "✚"}

// Color for an agent by its position in the roster — stable within a session, distinct across many.
func AgentColor(index int) lipgloss.Color {
	return agentPalette[index%len(agentPalette)]
}

func Avatar(index int) string {
	return avatars[index%len(avatars)]
}

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
		return Violet
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
