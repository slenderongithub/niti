package session

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// The terminal tab shows what niti is doing. While agents work, the tab takes their colours — one
// agent, one solid colour; several, taking turns — and goes back to normal when they stop, so a
// tab in the background says "still busy" (and who) without switching to it. iTerm2 exposes a
// single tab colour (OSC 6), so "three agents, three colours" means the colour rotates through the
// working agents rather than showing all at once. Every terminal also gets the window title
// ("niti · 3 working"), which needs no support beyond OSC 2.
//
// Emitted only on a change of state, honours the reduce-motion preference, and is undone on exit
// (TabGlowReset) so a colour never outlives the session.

const tabColorReset = "\x1b]6;1;bg;*;default\a"

// TabGlowSupported reports whether this terminal understands iTerm2's tab colour. NITI_NO_TABGLOW=1
// turns it off.
func TabGlowSupported() bool {
	if os.Getenv("NITI_NO_TABGLOW") != "" {
		return false
	}
	return os.Getenv("TERM_PROGRAM") == "iTerm.app" || os.Getenv("LC_TERMINAL") == "iTerm2"
}

// TabGlowReset is what main writes on the way out: the sequence that clears the tab colour, or
// nothing where the feature is off.
func TabGlowReset() string {
	if !TabGlowSupported() {
		return ""
	}
	return tmuxWrap(tabColorReset)
}

// WithTabGlow turns the tab colour on when the terminal supports it.
func (m Model) WithTabGlow() Model {
	m.glow = TabGlowSupported()
	return m
}

// tabColorSeq is the OSC 6 sequence that paints the tab with `c` ("#rrggbb"); "" for anything else.
func tabColorSeq(c lipgloss.Color) string {
	s := string(c)
	if len(s) != 7 || s[0] != '#' {
		return ""
	}
	var b strings.Builder
	for i, ch := range []string{"red", "green", "blue"} {
		v, err := strconv.ParseUint(s[1+2*i:3+2*i], 16, 8)
		if err != nil {
			return ""
		}
		fmt.Fprintf(&b, "\x1b]6;1;bg;%s;brightness;%d\a", ch, v)
	}
	return b.String()
}

// tmuxWrap passes a sequence through tmux to the terminal outside it (needs allow-passthrough,
// harmless without). Outside tmux it is the identity.
func tmuxWrap(seq string) string {
	if seq == "" || os.Getenv("TMUX") == "" {
		return seq
	}
	return "\x1bPtmux;" + strings.ReplaceAll(seq, "\x1b", "\x1b\x1b") + "\x1b\\"
}

// workingColors is the colour of every agent that is working right now, in roster order.
func (m Model) workingColors() []lipgloss.Color {
	var cs []lipgloss.Color
	for _, id := range m.order {
		if st := m.agents[id]; st != nil && st.status == "working" {
			cs = append(cs, st.color)
		}
	}
	return cs
}

type glowTickMsg struct{}

func glowTick() tea.Cmd {
	return tea.Tick(450*time.Millisecond, func(time.Time) tea.Msg { return glowTickMsg{} })
}

func writeTerminal(seq string) tea.Cmd {
	return func() tea.Msg {
		fmt.Fprint(os.Stdout, seq)
		return nil
	}
}

// glowCmd brings the terminal's title and tab colour in line with the model. It only emits what
// changed, and starts the rotation timer when more than one agent is working.
func (m *Model) glowCmd() tea.Cmd {
	colors := m.workingColors()
	n := len(colors)
	var cmds []tea.Cmd

	title := "niti"
	if n > 0 {
		title = fmt.Sprintf("niti · %d working", n)
	}
	if title != m.tabTitle {
		m.tabTitle = title
		cmds = append(cmds, tea.SetWindowTitle(title))
	}

	if m.glow {
		still := m.prefs["reduceMotion"]
		seq := tabColorReset
		if n > 0 {
			i := 0
			if !still {
				i = m.glowPhase % n
			}
			seq = tabColorSeq(colors[i])
		}
		seq = tmuxWrap(seq)
		if seq != "" && seq != m.tabSeq {
			m.tabSeq = seq
			cmds = append(cmds, writeTerminal(seq))
		}
		if n > 1 && !still && !m.glowTicking {
			m.glowTicking = true
			cmds = append(cmds, glowTick())
		}
	}
	return tea.Batch(cmds...)
}
