package session

import (
	"fmt"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// The approval at the head of the queue counts down to the moment the core refuses it on its own,
// so an unattended session isn't parked forever. The core owns the deadline; this only redraws it.

type countdownTickMsg struct{}

// countdownCmd schedules the next one-second redraw while the head approval has a deadline.
func (m *Model) countdownCmd() tea.Cmd {
	if m.countdownTicking || len(m.approvals) == 0 || m.approvals[0].ExpiresAt == 0 {
		return nil
	}
	m.countdownTicking = true
	return tea.Tick(time.Second, func(time.Time) tea.Msg { return countdownTickMsg{} })
}

// approvalCountdown is the banner's line about the deadline, "" when there is none.
func approvalCountdown(expiresAt int64, now time.Time) string {
	if expiresAt == 0 {
		return ""
	}
	left := time.UnixMilli(expiresAt).Sub(now)
	if left < 0 {
		left = 0
	}
	secs := int(left.Round(time.Second) / time.Second)
	return fmt.Sprintf("niti will automatically deny this request in %d:%02d, to avoid blocking progress on an unattended session", secs/60, secs%60)
}
