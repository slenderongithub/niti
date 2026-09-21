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
	switch {
	case g.n == 1 && g.target != "":
		return "✔ " + past + " " + g.target
	case !ok:
		return fmt.Sprintf("✔ %s ×%d", past, g.n)
	case g.n == 1:
		return "✔ " + past + " 1 " + n[0]
	}
	return fmt.Sprintf("✔ %s %d %s", past, g.n, n[1])
}

// toolStart records call as in flight ("Run npm test"), first finishing whatever was running.
func (s *agentState) toolStart(call string) {
	s.toolEnd(true)
	s.running = call
}

// toolEnd commits the in-flight call into the log. keepGroup is true only when the next event is
// another tool call, which may extend the same collapsed line; anything else ends the group.
func (s *agentState) toolEnd(keepGroup bool) {
	if s.running != "" {
		verb, target, _ := strings.Cut(s.running, " ")
		s.running = ""
		if verb == "Write" || verb == "Edit" || s.verbose { // edits stay individual (each has its own diff); verbose lists every call
			s.group = nil
			s.push("✔ " + pastVerb[verb] + " " + target)
		} else if g := s.group; g != nil && g.verb == verb && len(s.log) > 0 && s.log[len(s.log)-1] == collapsedLine(*g) {
			g.n++
			g.target = target
			s.log[len(s.log)-1] = collapsedLine(*g)
		} else {
			s.group = &toolGroup{verb: verb, n: 1, target: target}
			s.push(collapsedLine(*s.group))
		}
	}
	if !keepGroup {
		s.group = nil
	}
}

const spinFrames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

func spinner() string {
	r := []rune(spinFrames)
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
