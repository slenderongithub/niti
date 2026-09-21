package session

import (
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// A tool call is shown live (spinner + what it is doing) while it runs, then collapses into one
// "✔ Ran 2 shell commands" line. The core sends a call event and no result event for most tools,
// so "finished" means "the agent's next event arrived". Runs of the same verb merge into one line.

type toolGroup struct {
	verb   string
	n      int
	target string // the latest target, which is the whole story while n == 1
	dur    time.Duration
	show   bool // append dur to the rendered line (the showTurnDuration pref, as of the group's start)
}

// fmtDur is a tool call's elapsed time the way a person reads it: "0.4s", "12s", "1m05s".
func fmtDur(d time.Duration) string {
	switch {
	case d < 10*time.Second:
		return fmt.Sprintf("%.1fs", d.Seconds())
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	return fmt.Sprintf("%dm%02ds", int(d.Minutes()), int(d.Seconds())%60)
}

func durSuffix(show bool, d time.Duration) string {
	if !show {
		return ""
	}
	return " (" + fmtDur(d) + ")"
}

var pastVerb = map[string]string{
	"Run": "Ran", "Read": "Read", "Write": "Wrote", "Edit": "Edited", "List": "Listed",
	"Find": "Found", "Search": "Searched", "Check": "Checked", "Inspect": "Inspected",
}

var nouns = map[string][2]string{
	"Run": {"shell command", "shell commands"}, "Read": {"file", "files"}, "List": {"directory", "directories"},
	"Find": {"pattern", "patterns"}, "Search": {"query", "queries"}, "Check": {"time", "times"}, "Inspect": {"symbol", "symbols"},
}

// collapsedLine renders a finished group: its target when alone, its count otherwise.
func collapsedLine(g toolGroup) string {
	past, ok := pastVerb[g.verb]
	if !ok {
		past = g.verb
	}
	n, ok := nouns[g.verb]
	dur := durSuffix(g.show, g.dur)
	switch {
	case g.n == 1 && g.target != "":
		return "✔ " + past + " " + g.target + dur
	case !ok:
		return fmt.Sprintf("✔ %s ×%d%s", past, g.n, dur)
	case g.n == 1:
		return "✔ " + past + " 1 " + n[0] + dur
	}
	return fmt.Sprintf("✔ %s %d %s%s", past, g.n, n[1], dur)
}

// toolStart records call as in flight ("Run npm test"), first finishing whatever was running.
func (s *agentState) toolStart(call string) {
	s.toolEnd(true)
	s.running = call
	s.runStart = time.Now()
}

// toolEnd commits the in-flight call into the log. keepGroup is true only when the next event is
// another tool call, which may extend the same collapsed line; anything else ends the group.
func (s *agentState) toolEnd(keepGroup bool) {
	if s.running != "" {
		verb, target, _ := strings.Cut(s.running, " ")
		s.running = ""
		elapsed := time.Since(s.runStart)
		if verb == "Write" || verb == "Edit" || s.verbose { // edits stay individual (each has its own diff); verbose lists every call
			s.group = nil
			s.push("✔ " + pastVerb[verb] + " " + target + durSuffix(s.showDur, elapsed))
		} else if g := s.group; g != nil && g.verb == verb && len(s.log) > 0 && s.log[len(s.log)-1] == collapsedLine(*g) {
			g.n++
			g.target = target
			g.dur += elapsed
			s.log[len(s.log)-1] = collapsedLine(*g)
		} else {
			s.group = &toolGroup{verb: verb, n: 1, target: target, dur: elapsed, show: s.showDur}
			s.push(collapsedLine(*s.group))
		}
	}
	if !keepGroup {
		s.group = nil
	}
}

const spinFrames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

// spinner is the animated frame, or — with reduce motion — the first frame held still (still a
// spinFrames rune, so isSpinning styles it the same).
func spinner(still bool) string {
	r := []rune(spinFrames)
	if still {
		return string(r[0])
	}
	return string(r[int(time.Now().UnixMilli()/100)%len(r)])
}

type tickMsg struct{}

func tick() tea.Cmd {
	return tea.Tick(120*time.Millisecond, func(time.Time) tea.Msg { return tickMsg{} })
}

func (m Model) anyRunning() bool {
	for _, st := range m.agents {
		if st.running != "" {
			return true
		}
	}
	return false
}

func isSpinning(line string) bool {
	for _, r := range line {
		return strings.ContainsRune(spinFrames, r)
	}
	return false
}
