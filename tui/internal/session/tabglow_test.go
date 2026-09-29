package session

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
)

func TestTabColorSeqIsITermsRGBSequence(t *testing.T) {
	got := tabColorSeq("#7aa2d6")
	want := "\x1b]6;1;bg;red;brightness;122\a\x1b]6;1;bg;green;brightness;162\a\x1b]6;1;bg;blue;brightness;214\a"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	for _, bad := range []string{"", "red", "#12", "#zzzzzz"} {
		if tabColorSeq(lipgloss.Color(bad)) != "" {
			t.Errorf("%q is not a colour the tab can take; expected no sequence", bad)
		}
	}
}

func TestTmuxWrapDoublesEscapes(t *testing.T) {
	t.Setenv("TMUX", "")
	if tmuxWrap("\x1b]6;x\a") != "\x1b]6;x\a" {
		t.Error("outside tmux the sequence must pass through untouched")
	}
	t.Setenv("TMUX", "/tmp/tmux-501/default,1,0")
	if got := tmuxWrap("\x1b]6;x\a"); got != "\x1bPtmux;\x1b\x1b]6;x\a\x1b\\" {
		t.Errorf("got %q", got)
	}
}

func TestTabFollowsTheWorkingAgentsAndOnlySpeaksOnChange(t *testing.T) {
	t.Setenv("TMUX", "")
	m := sized(3, 120, 30)
	m.glow = true
	m.prefs = map[string]bool{}

	if m.glowCmd(); m.tabTitle != "niti" || m.tabSeq != tabColorReset {
		t.Fatalf("idle: title %q seq %q", m.tabTitle, m.tabSeq)
	}

	a, b := m.agents[m.order[0]], m.agents[m.order[1]]
	a.status = "working"
	m.glowCmd()
	if m.tabTitle != "niti · 1 working" || m.tabSeq != tabColorSeq(a.color) {
		t.Errorf("one working: title %q seq %q", m.tabTitle, m.tabSeq)
	}
	if m.glowTicking {
		t.Error("a single agent is a solid colour: nothing to rotate")
	}

	b.status = "working"
	m.glowCmd()
	if m.tabTitle != "niti · 2 working" || !m.glowTicking {
		t.Errorf("two working: title %q ticking %v", m.tabTitle, m.glowTicking)
	}
	m.glowPhase = 1
	m.glowCmd()
	if m.tabSeq != tabColorSeq(b.color) {
		t.Errorf("phase 1 should show the second working agent's colour, got %q", m.tabSeq)
	}

	// reduce-motion: hold the first colour still, no rotation timer.
	m.glowTicking, m.prefs["reduceMotion"] = false, true
	m.glowCmd()
	if m.tabSeq != tabColorSeq(a.color) || m.glowTicking {
		t.Errorf("reduce motion should pin the first colour without a timer: seq %q ticking %v", m.tabSeq, m.glowTicking)
	}

	a.status, b.status = "idle", "idle"
	m.glowCmd()
	if m.tabSeq != tabColorReset || strings.Contains(m.tabTitle, "working") {
		t.Errorf("all idle: title %q seq %q", m.tabTitle, m.tabSeq)
	}
}

func TestTabColourIsOffWithoutITerm(t *testing.T) {
	t.Setenv("TERM_PROGRAM", "Apple_Terminal")
	t.Setenv("LC_TERMINAL", "")
	if TabGlowSupported() || TabGlowReset() != "" {
		t.Error("only iTerm2 gets the OSC 6 sequences")
	}
	t.Setenv("TERM_PROGRAM", "iTerm.app")
	if !TabGlowSupported() {
		t.Error("iTerm2 should be supported")
	}
	t.Setenv("NITI_NO_TABGLOW", "1")
	if TabGlowSupported() {
		t.Error("NITI_NO_TABGLOW must switch it off")
	}
}
