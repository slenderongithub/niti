package ui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

// Text from outside niti — agent output, shell output, file contents — can hold things a width
// count cannot see: color codes, tabs, a carriage return, a broken UTF-8 byte, an emoji joined from
// several runes. The terminal still draws them, so a row measured as fitting comes out wider,
// wraps, and every panel below shifts by a line. Clean such text before it is laid out, and pass
// the finished frame through Frame.

// Clean returns s with only text a width count measures correctly: color codes stripped, tabs as
// four spaces, control characters and broken bytes removed, and the invisible runes that fuse
// emoji (ZWJ, variation selectors) dropped. Newlines are kept.
func Clean(s string) string {
	s = strings.ToValidUTF8(ansi.Strip(s), "")
	return strings.Map(func(r rune) rune {
		switch {
		case r == '\n':
			return r
		case r < 0x20, r == 0x7f, r >= 0x80 && r < 0xa0, // C0/C1 controls, \r among them
			r == 0x200b, r == 0x200d, r == 0xfe0e, r == 0xfe0f, // zero-width space, joiner, variation selectors
			r >= 0x202a && r <= 0x202e, r >= 0x2066 && r <= 0x2069: // bidi overrides reorder the row
			return -1
		}
		return r
	}, strings.ReplaceAll(s, "\t", "    "))
}

// Frame is the last step of a full-screen View: it repairs anything unclean that got through
// (broken bytes, stray control characters) and cuts the frame to exactly w×h cells at most, so one
// bad row can never wrap and push the layout down.
func Frame(s string, w, h int) string {
	s = strings.Map(func(r rune) rune {
		if r == '\t' || r == '\r' || r < 0x20 && r != '\n' && r != 0x1b {
			return ' '
		}
		return r
	}, strings.ToValidUTF8(s, "?"))
	return lipgloss.NewStyle().MaxWidth(w).MaxHeight(h).Render(s)
}
