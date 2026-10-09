package theme

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// The agent avatars (the same six drawings as the desktop app and the web dashboard) as terminal
// art: each cell is an upper-half block "▀" whose foreground is the pixel above and background the
// pixel below, so an 18×18 grid draws in 18×9 cells. Transparent pixels show the given background.
// The art is drawn by hand (make-avatars.py): one silhouette for all six, each with its own colours
// and face, at two sizes.

// Blink timing, shared with the app and the web views: a 160ms blink every 5.2s, offset per slot.
const (
	BlinkPeriodMs = 5200
	BlinkLengthMs = 160
)

func blinkOffset(slot int) int64 { return int64((slot%6)*1700) % BlinkPeriodMs }

// Blinking reports whether slot's avatar has its eyes shut at nowMs.
func Blinking(slot int, nowMs int64) bool {
	return (nowMs+blinkOffset(slot))%BlinkPeriodMs < BlinkLengthMs
}

// NextBlinkChangeMs is how long until any of the first n slots starts or ends a blink — when the
// art needs redrawing next.
func NextBlinkChangeMs(n int, nowMs int64) int64 {
	best := int64(BlinkPeriodMs)
	for s := 0; s < n && s < 6; s++ {
		phase := (nowMs + blinkOffset(s)) % BlinkPeriodMs
		d := BlinkPeriodMs - phase
		if phase < BlinkLengthMs {
			d = BlinkLengthMs - phase
		}
		if d < best {
			best = d
		}
	}
	return max(best, 1)
}

func render(rows [][]string, bg lipgloss.Color) []string {
	var lines []string
	for y := 0; y+1 < len(rows); y += 2 {
		var b strings.Builder
		for x := range rows[y] {
			top, bot := rows[y][x], rows[y+1][x]
			switch {
			case top == "" && bot == "":
				b.WriteString(lipgloss.NewStyle().Background(bg).Render(" "))
			case top == "":
				b.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(bot)).Background(bg).Render("▄"))
			default:
				back := bg
				if bot != "" {
					back = lipgloss.Color(bot)
				}
				b.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(top)).Background(back).Render("▀"))
			}
		}
		lines = append(lines, b.String())
	}
	return lines
}

// AvatarLines draws slot's avatar: big is 18 cells × 9 lines, otherwise 12 × 6.
func AvatarLines(slot int, blink, big bool, bg lipgloss.Color) []string {
	frame := 0
	if blink {
		frame = 1
	}
	var rows [][]string
	if big {
		g := AvatarArtBig[slot%6][frame]
		for y := range g {
			rows = append(rows, g[y][:])
		}
	} else {
		g := AvatarArtSmall[slot%6][frame]
		for y := range g {
			rows = append(rows, g[y][:])
		}
	}
	return render(rows, bg)
}
