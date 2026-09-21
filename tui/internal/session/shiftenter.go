package session

import (
	"reflect"

	tea "github.com/charmbracelet/bubbletea"
)

// Shift+Enter arrives as a bare "\r" on a stock terminal — indistinguishable from Enter — so the
// only way to see it is to ask the terminal to report modified keys. EnableModifiedEnter does that
// with xterm's modifyOtherKeys level 1, chosen over the kitty protocol on purpose: level 1 changes
// only keys that have no legacy encoding (Shift+Enter is one), so ctrl+c, esc, arrows and every
// other key bubbletea v1 already parses keep arriving exactly as before. A terminal that doesn't
// know the sequence ignores it and Shift+Enter simply stays an Enter.
const (
	EnableModifiedEnter  = "\x1b[>4;1m"
	DisableModifiedEnter = "\x1b[>4;0m"
)

// IsShiftEnter reports whether msg is a modified-Enter report. bubbletea v1 has no key for it and
// hands over the raw CSI bytes as an unexported unknownCSISequenceMsg, so it is recognised by its
// bytes rather than its type: xterm's "ESC [ 27 ; 2 ; 13 ~" and kitty's "ESC [ 13 ; 2 u".
func IsShiftEnter(msg tea.Msg) bool {
	v := reflect.ValueOf(msg)
	if v.Kind() != reflect.Slice || v.Type().Elem().Kind() != reflect.Uint8 || v.Type().Name() != "unknownCSISequenceMsg" {
		return false
	}
	switch string(v.Bytes()) {
	case "\x1b[27;2;13~", "\x1b[13;2u":
		return true
	}
	return false
}
