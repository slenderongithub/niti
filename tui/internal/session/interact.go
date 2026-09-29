package session

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// Talking to a run while it works, the way Claude Code lets you: esc stops it, a message sent
// mid-run steers the agent that's working instead of throwing the plan away, a denied approval can
// say what to do instead, ↑ recalls earlier prompts, and !cmd runs a command right here.

func (m Model) running() bool { return m.active }

// steerTarget is who a mid-run message goes to: the agent on screen if it's working, else the first
// agent that is, else the lead.
func (m Model) steerTarget() string {
	if st := m.agents[m.focus]; st != nil && st.status == "working" {
		return m.focus
	}
	for _, id := range m.order {
		if m.agents[id].status == "working" {
			return id
		}
	}
	if st := m.shownAgent(); st != nil {
		return st.cfg.ID
	}
	return ""
}

type steerResultMsg struct {
	to  string
	err error
}

// steer sends text to an agent's inbox. The core puts it in that agent's transcript too.
func (m *Model) steer(to, text string) tea.Cmd {
	if to == "" || m.client == nil {
		m.status = "no agent to send that to"
		return nil
	}
	role := to
	if st := m.agents[to]; st != nil {
		role = st.cfg.Role
	}
	m.status = "→ " + role + ": " + truncate(text, 60)
	client := m.client
	return func() tea.Msg { return steerResultMsg{to: role, err: client.MessageAgent(to, text)} }
}

// interrupt stops the run: agents finish the step they're on and stop.
func (m *Model) interrupt() tea.Cmd {
	m.status = "interrupting — agents stop after their current step; type what to do instead"
	client := m.client
	if client == nil {
		return nil
	}
	return func() tea.Msg { return actionResultMsg{action: "interrupt", err: client.Cancel()} }
}

// denyAndTell refuses the approval on screen, then waits for the user to say what to do instead;
// the next thing they send goes to that agent.
func (m *Model) denyAndTell() tea.Cmd {
	if len(m.approvals) == 0 {
		return nil
	}
	who := m.approvals[0].AgentID
	cmd := answer(false, "")(m)
	m.steerTo = who
	role := who
	if st := m.agents[who]; st != nil {
		role = st.cfg.Role
	}
	m.status = "denied — tell " + role + " what to do instead, then enter"
	return cmd
}

// --- prompt history ---

const historyMax = 200

func historyPath(root string) string {
	if root == "" {
		return ""
	}
	return filepath.Join(root, ".niti", "history")
}

func loadHistory(root string) []string {
	f, err := os.Open(historyPath(root))
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if l := strings.TrimSpace(sc.Text()); l != "" {
			out = append(out, strings.ReplaceAll(l, "\\n", "\n"))
		}
	}
	if len(out) > historyMax {
		out = out[len(out)-historyMax:]
	}
	return out
}

// remember records a sent prompt, in memory and in .niti/history (best effort).
func (m *Model) remember(text string) {
	text = strings.TrimSpace(text)
	m.histPos = 0
	if text == "" || (len(m.history) > 0 && m.history[len(m.history)-1] == text) {
		return
	}
	m.history = append(m.history, text)
	if len(m.history) > historyMax {
		m.history = m.history[len(m.history)-historyMax:]
	}
	if p := historyPath(m.root); p != "" {
		if f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
			_, _ = f.WriteString(strings.ReplaceAll(text, "\n", "\\n") + "\n")
			f.Close()
		}
	}
}

// historyStep moves through earlier prompts: older (+1) or newer (-1). histPos counts back from
// the newest; 0 is "not browsing" — the empty prompt.
func (m *Model) historyStep(older int) tea.Cmd {
	if len(m.history) == 0 {
		return nil
	}
	m.histPos = clamp(m.histPos+older, 0, len(m.history))
	if m.histPos == 0 {
		m.input.SetValue("")
		return nil
	}
	m.input.SetValue(strings.ReplaceAll(m.history[len(m.history)-m.histPos], "\n", newlineMark))
	m.input.CursorEnd()
	return nil
}

// --- !command ---

type bangResultMsg struct {
	cmd string
	out string
}

// bang runs a command the user typed after "!" in the project, on their own authority — the same
// as typing it in another terminal, so it goes through no agent permission layer. Output opens in
// the pager.
func (m *Model) bang(line string) tea.Cmd {
	line = strings.TrimSpace(line)
	if line == "" {
		return nil
	}
	m.status = "running ! " + truncate(line, 50)
	root := m.root
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		name, flag := "sh", "-c"
		if runtime.GOOS == "windows" {
			name, flag = "cmd", "/C"
		}
		c := exec.CommandContext(ctx, name, flag, line)
		c.Dir = root
		out, err := c.CombinedOutput()
		text := strings.TrimRight(string(out), "\n")
		if len(text) > 200_000 {
			text = text[len(text)-200_000:]
		}
		if err != nil {
			text += "\n\n[" + err.Error() + "]"
		}
		if text == "" {
			text = "(no output)"
		}
		return bangResultMsg{cmd: line, out: text}
	}
}

// runningLine is the Transcript's bottom border while work is under way: who is doing what, for how
// long, and how to stop it — "⠋ Coder · Run bun test · 12s · esc to interrupt".
func (m Model) runningLine() string {
	if !m.running() {
		return ""
	}
	for _, id := range m.order {
		st := m.agents[id]
		if st.running == "" {
			continue
		}
		return spinner(m.prefs["reduceMotion"]) + " " + st.cfg.Role + " · " + truncate(st.running, 40) + " · " + fmtDur(time.Since(st.runStart)) + " · esc to interrupt"
	}
	return spinner(m.prefs["reduceMotion"]) + " working · esc to interrupt"
}
