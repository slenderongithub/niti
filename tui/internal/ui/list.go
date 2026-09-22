// Package ui holds the small widgets shared by the setup screens and the live session view — a
// filterable list, a centered box, and the overlay that floats one over the other. They live here
// rather than in either package because the same list drives three surfaces: the team picker, the
// ctrl+p model carousel, and the slash-command menu.
package ui

import (
	"strconv"
	"strings"

	"github.com/niti/tui/internal/theme"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

// Version is the niti release string. It lives here because both the setup screens and the live
// session view put it on screen, and `ui` is the one package both already import.
const Version = "0.3.3"

// Item is one selectable row. Value is what the caller acts on; Label/Desc are what it reads as.
type Item struct {
	Label string
	Desc  string
	Value string
	Tag   string // optional short marker rendered before the label (e.g. "✓" for "key stored")
	// Detail is long-form text for the highlighted row, shown by the caller in a bounded block
	// under the list (see Wrap). Never drawn in the row itself, so it can't widen or truncate it.
	Detail string
}

// List is a filtered, cursor-driven selection list. Zero value is usable: Set() then Render().
type List struct {
	items  []Item
	shown  []int // indices into items that match the current query
	cursor int   // index into shown
	query  string
	top    int // first visible row of shown, so a long list scrolls with the cursor
}

func (l *List) Set(items []Item) {
	l.items = items
	l.cursor, l.top = 0, 0
	l.refilter()
}

// SetQuery narrows the list. The cursor stays in range but is not otherwise preserved — after a
// keystroke the top match is the useful default.
func (l *List) SetQuery(q string) {
	if q == l.query {
		return
	}
	l.query = q
	l.cursor, l.top = 0, 0
	l.refilter()
}

func (l *List) Query() string { return l.query }

func (l *List) refilter() {
	l.shown = l.shown[:0]
	q := strings.ToLower(strings.TrimSpace(l.query))
	// Matched on the name, never the description: typing "m" for /model must not also drag in every
	// command whose description happens to contain an m. Names that *start* with the query are
	// listed before names that merely contain it, so "/m" highlights /model rather than /theme
	// while still letting "opus" find claude-opus-4-8.
	var loose []int
	for i, it := range l.items {
		name := strings.ToLower(it.Label)
		switch {
		case q == "" || strings.HasPrefix(name, q) || strings.HasPrefix(strings.ToLower(it.Value), q):
			l.shown = append(l.shown, i)
		case strings.Contains(name+" "+strings.ToLower(it.Value), q):
			loose = append(loose, i)
		}
	}
	l.shown = append(l.shown, loose...)
	if l.cursor >= len(l.shown) {
		l.cursor = max(len(l.shown)-1, 0)
	}
}

// Move wraps at both ends — a five-item list is faster to reach backwards than to scroll down.
func (l *List) Move(delta int) {
	if len(l.shown) == 0 {
		return
	}
	l.cursor = (l.cursor + delta + len(l.shown)) % len(l.shown)
}

func (l *List) Len() int    { return len(l.shown) }
func (l *List) Cursor() int { return l.cursor }

func (l *List) Selected() (Item, bool) {
	if l.cursor < 0 || l.cursor >= len(l.shown) {
		return Item{}, false
	}
	return l.items[l.shown[l.cursor]], true
}

// Rows is how many lines Render will draw for a `rows`-line budget — never more than there is
// content for. Callers size their frame off this so a three-item list doesn't sit in a ten-row hole.
func (l *List) Rows(rows int) int {
	if rows < 1 {
		return 0
	}
	if len(l.shown) == 0 {
		return 1 // the "no matches" line
	}
	return min(len(l.shown), rows)
}

// SelectedDetail is the highlighted row's Detail, or "" when nothing is highlighted.
func (l *List) SelectedDetail() string {
	it, ok := l.Selected()
	if !ok {
		return ""
	}
	return it.Detail
}

// DetailRows is how many lines the Detail block needs at width w for the *longest* Detail in the
// list, capped at maxLines. Callers reserve exactly this, so the frame stays one height while the
// cursor moves between a row with a long Detail and one with none.
func (l *List) DetailRows(w, maxLines int) int {
	n := 0
	for _, i := range l.shown {
		if d := l.items[i].Detail; d != "" {
			n = max(n, len(Wrap(d, w, maxLines)))
		}
	}
	return n
}

// Wrap word-wraps s to width w (breaking a word only if it alone is wider than w) and keeps at
// most maxLines lines; if text was cut, the last kept line ends in an ellipsis.
func Wrap(s string, w, maxLines int) []string {
	if s == "" || w < 1 || maxLines < 1 {
		return nil
	}
	lines := strings.Split(ansi.Wrap(s, w, ""), "\n")
	if len(lines) > maxLines {
		lines = lines[:maxLines]
		lines[maxLines-1] = Truncate(lines[maxLines-1]+"…", w)
	}
	return lines
}

// NaturalWidth is the width the widest row wants, so a frame can shrink to its content instead of
// always claiming the maximum.
func (l *List) NaturalWidth() int {
	w := 0
	for _, i := range l.shown {
		it := l.items[i]
		n := 2 + lipgloss.Width(it.Label)
		if it.Tag != "" {
			n += lipgloss.Width(it.Tag) + 1
		}
		if it.Desc != "" {
			n += 2 + lipgloss.Width(it.Desc)
		}
		w = max(w, n)
	}
	return w
}

// Render draws at most `rows` lines — exactly Rows(rows) of them. The visible window follows the
// cursor, and an off-screen remainder is reported on the last line so a filtered-down list never
// looks like the whole list. It deliberately does *not* pad out to `rows`: an empty tail is dead
// space the caller's frame would have to draw a border around.
func (l *List) Render(w, rows int, bg lipgloss.Color) string {
	if rows < 1 {
		return ""
	}
	if len(l.shown) == 0 {
		return pad(lipgloss.NewStyle().Foreground(theme.Line).Background(bg).Render("  no matches"), w, bg, 1)
	}

	body := rows
	more := len(l.shown) - body
	if more > 0 {
		body-- // last line is the "+N more" counter
	}
	if body < 1 {
		body = 1
	}
	// Scroll so the cursor is always inside [top, top+body).
	if l.cursor < l.top {
		l.top = l.cursor
	}
	if l.cursor >= l.top+body {
		l.top = l.cursor - body + 1
	}
	if l.top > max(len(l.shown)-body, 0) {
		l.top = max(len(l.shown)-body, 0)
	}

	var lines []string
	for i := l.top; i < len(l.shown) && i < l.top+body; i++ {
		lines = append(lines, l.row(l.items[l.shown[i]], i == l.cursor, w, bg))
	}
	if hidden := len(l.shown) - len(lines); more > 0 && hidden > 0 {
		lines = append(lines, lipgloss.NewStyle().Foreground(theme.Line).Background(bg).
			Render(Truncate("  +"+strconv.Itoa(hidden)+" more", w)))
	}
	return pad(strings.Join(lines, "\n"), w, bg, len(lines))
}

func (l *List) row(it Item, selected bool, w int, bg lipgloss.Color) string {
	marker, fg := "  ", theme.Fg
	rowBg := bg
	if selected {
		marker, fg, rowBg = "▸ ", theme.BgDeep, theme.Accent
	}
	label := it.Label
	if it.Tag != "" {
		label = it.Tag + " " + label
	}
	head := lipgloss.NewStyle().Foreground(fg).Background(rowBg).Bold(selected).Render(marker + label)
	line := head
	if it.Desc != "" {
		descFg := theme.Muted
		if selected {
			descFg = theme.BgPane
		}
		line += lipgloss.NewStyle().Foreground(descFg).Background(rowBg).Render("  " + it.Desc)
	}
	// The selected row is a filled bar across the pane, so it reads as a highlight rather than as
	// coloured text that happens to have a ▸ in front of it.
	line = Truncate(line, w)
	if fill := w - lipgloss.Width(line); fill > 0 {
		line += lipgloss.NewStyle().Background(rowBg).Render(strings.Repeat(" ", fill))
	}
	return line
}

// Box draws a titled, bordered panel on the pane background — the carousel's frame.
func Box(title, body, hint string, w int) string {
	bg := theme.BgPane
	inner := max(w-4, 1)
	head := lipgloss.NewStyle().Foreground(theme.Accent).Background(bg).Bold(true).Render(Truncate(title, inner))
	parts := []string{head, body}
	if hint != "" {
		// One blank row between the content and the hint — the box is content-sized now, and without
		// this the hint reads as another list row.
		parts = append(parts, "")
		for _, hl := range strings.Split(hint, "\n") {
			parts = append(parts, lipgloss.NewStyle().Foreground(theme.Muted).Background(bg).Render(Truncate(hl, inner)))
		}
	}
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).BorderForeground(theme.Accent).BorderBackground(theme.BgDeep).
		Background(bg).Padding(0, 1).Width(inner).
		Render(strings.Join(parts, "\n"))
}

// Overlay floats `box` over the middle of `base`. The part of the base line to the *left* of the
// box is kept — ansi.Truncate cuts on cell boundaries and carries the active SGR state, so the
// sidebar keeps its own background instead of being blanked into a dark stripe wherever a modal
// happens to sit. The right-hand gap is repainted in BgDeep, which is what the main pane is anyway.
func Overlay(base, box string, w, h int) string {
	baseLines := strings.Split(base, "\n")
	boxLines := strings.Split(box, "\n")
	if len(boxLines) > h {
		boxLines = boxLines[:h]
	}
	top := max((h-len(boxLines))/2, 0)
	gap := lipgloss.NewStyle().Background(theme.BgDeep)
	for i, bl := range boxLines {
		row := top + i
		if row >= len(baseLines) {
			break
		}
		bw := lipgloss.Width(bl)
		side := max((w-bw)/2, 0)
		left := ansi.Truncate(baseLines[row], side, "")
		if pad := side - lipgloss.Width(left); pad > 0 { // a base line shorter than the gap
			left += gap.Render(strings.Repeat(" ", pad))
		}
		baseLines[row] = left + "\x1b[0m" + bl + gap.Render(strings.Repeat(" ", max(w-side-bw, 0)))
	}
	out := strings.Join(baseLines, "\n")
	// View() clamps itself to the terminal, but the overlay is composited *after* that clamp — so a
	// popup wider than the terminal (any of them, below ~40 columns) pushed the frame sideways and
	// wrapped it into garbage. Clamp again here, where the final string is actually assembled.
	return lipgloss.NewStyle().MaxWidth(w).MaxHeight(h).Render(out)
}

// Truncate cuts to n display cells, counting runes (the UI is full of multibyte glyphs) and
// leaving styled text intact — lipgloss's MaxWidth is ANSI-aware, unlike a byte slice.
func Truncate(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if lipgloss.Width(s) <= n {
		return s
	}
	return lipgloss.NewStyle().MaxWidth(n).Render(s)
}

// Clamp restricts v to [lo, hi] — shared by every widget that sizes itself off the terminal.
func Clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// pad forces an exact line count so a widget's height is stable while its content changes.
func pad(s string, w int, bg lipgloss.Color, rows int) string {
	lines := strings.Split(s, "\n")
	if len(lines) > rows {
		lines = lines[:rows]
	}
	blank := lipgloss.NewStyle().Background(bg).Render(strings.Repeat(" ", max(w, 0)))
	for len(lines) < rows {
		lines = append(lines, blank)
	}
	return strings.Join(lines, "\n")
}
