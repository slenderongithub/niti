package session

import (
	"strings"
	"testing"

	"github.com/amux/tui/internal/theme"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

// esc must leave the palette exactly as it was before the picker opened, even after previewing
// several other themes — the whole point of a live preview is that looking isn't committing.
func TestThemePickerEscRevertsLivePreview(t *testing.T) {
	theme.Use("neon graveyard")
	m := sized(1, 120, 40)
	m.openThemePicker()
	if !m.tp.open || theme.Current() != "neon graveyard" {
		t.Fatalf("opening the picker must not change the theme yet, got %q", theme.Current())
	}

	next, _ := m.onKey(tea.KeyMsg{Type: tea.KeyDown})
	m = next.(Model)
	if theme.Current() == "neon graveyard" {
		t.Fatal("moving the cursor must live-preview a different theme")
	}

	back, _ := m.onKey(tea.KeyMsg{Type: tea.KeyEsc})
	m = back.(Model)
	if m.tp.open {
		t.Error("esc must close the picker")
	}
	if theme.Current() != "neon graveyard" {
		t.Errorf("esc must revert to the theme active before the picker opened, got %q", theme.Current())
	}
}

// enter commits whatever is currently previewed and closes the picker.
func TestThemePickerEnterCommits(t *testing.T) {
	theme.Use("neon graveyard")
	m := sized(1, 120, 40)
	m.openThemePicker()

	next, _ := m.onKey(tea.KeyMsg{Type: tea.KeyDown})
	m = next.(Model)
	previewed := theme.Current()

	done, _ := m.onKey(tea.KeyMsg{Type: tea.KeyEnter})
	m = done.(Model)
	if m.tp.open {
		t.Error("enter must close the picker")
	}
	if theme.Current() != previewed {
		t.Errorf("enter must keep the previewed theme, got %q want %q", theme.Current(), previewed)
	}
	theme.Use("neon graveyard")
}

// The cursor opens on whatever theme is currently active, not always index 0.
func TestThemePickerOpensOnTheCurrentTheme(t *testing.T) {
	names := theme.Names()
	theme.Use(names[2])
	m := sized(1, 120, 40)
	m.openThemePicker()
	if m.tp.names[m.tp.cursor] != names[2] {
		t.Errorf("picker should open on the active theme %q, cursor is on %q", names[2], m.tp.names[m.tp.cursor])
	}
	theme.Use("neon graveyard")
}

// left/right are carousel-equivalent to up/down — either direction should preview the same way.
func TestThemePickerLeftRightNavigate(t *testing.T) {
	theme.Use("neon graveyard")
	m := sized(1, 120, 40)
	m.openThemePicker()
	start := m.tp.cursor

	next, _ := m.onKey(tea.KeyMsg{Type: tea.KeyRight})
	m = next.(Model)
	if m.tp.cursor == start {
		t.Fatal("right must move the cursor forward")
	}
	if theme.Current() != m.tp.names[m.tp.cursor] {
		t.Errorf("right must live-preview the newly selected theme, got %q want %q", theme.Current(), m.tp.names[m.tp.cursor])
	}

	back, _ := m.onKey(tea.KeyMsg{Type: tea.KeyLeft})
	m = back.(Model)
	if m.tp.cursor != start {
		t.Errorf("left should undo the right move, cursor is %d want %d", m.tp.cursor, start)
	}
	theme.Use("neon graveyard")
}

// The carousel shows more than just the current theme's name — its neighbors are visible too, so
// there's something to scroll toward.
func TestThemePickerViewShowsNeighbors(t *testing.T) {
	theme.Use("neon graveyard")
	m := sized(1, 120, 40)
	m.openThemePicker()

	view := ansi.Strip(m.themePickerView(120, 40))
	n := len(m.tp.names)
	prev, next := m.tp.names[(m.tp.cursor-1+n)%n], m.tp.names[(m.tp.cursor+1)%n]
	if !strings.Contains(view, prev) {
		t.Errorf("carousel should show the previous theme %q", prev)
	}
	if !strings.Contains(view, next) {
		t.Errorf("carousel should show the next theme %q", next)
	}
	theme.Use("neon graveyard")
}
