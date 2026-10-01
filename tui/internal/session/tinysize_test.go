package session

import (
	"fmt"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// A terminal can be any size, including absurdly small ones mid-resize. Rendering must never panic.
func TestViewSurvivesAnyTerminalSize(t *testing.T) {
	for _, agents := range []int{0, 1, 3} {
		for w := 0; w <= 60; w++ {
			for _, h := range []int{0, 1, 2, 3, 5, 8, 12, 24} {
				t.Run(fmt.Sprintf("a%d_%dx%d", agents, w, h), func(t *testing.T) {
					defer func() {
						if r := recover(); r != nil {
							t.Fatalf("panic: %v", r)
						}
					}()
					m := model(agents)
					next, _ := m.Update(tea.WindowSizeMsg{Width: w, Height: h})
					_ = next.(Model).View()
				})
			}
		}
	}
}
