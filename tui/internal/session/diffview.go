package session

import (
	"fmt"
	"strings"

	"github.com/amux/tui/internal/api"
	"github.com/amux/tui/internal/theme"
	"github.com/charmbracelet/bubbles/textarea"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// The full-screen diff/patch viewer replaces the one-line approval bar whenever the head of the
// approval queue carries a diff (write_file and edit both attach one server-side — see
// src/tools/tools.ts). Modeled on settings.go's full-screen takeover, not ui.Overlay's centered
// popup: a real diff (and, in edit mode, a textarea) needs the whole screen. Falls back to the
// old one-line bar for calls with no diff (shell).

type diffview struct {
	editing  bool
	textarea textarea.Model
	edited   map[string]any // set once the user confirms an edit (ctrl+s); nil = approve as proposed
	top      int            // scroll offset over the diff lines, view mode
	idx      int            // which pending approval is being PREVIEWED; only idx 0 is answerable
}

// approvalDiff reports the diff string attached to a request, if any — Input is a generic
// map[string]any off the wire, and only edit/write_file calls ever set "diff".
func approvalDiff(r api.Approval) (string, bool) {
	d, ok := r.Input["diff"].(string)
	return d, ok && d != ""
}

// editedField is which input key an in-place edit overwrites, by tool.
func editedField(tool string) string {
	if tool == "write_file" {
		return "content"
	}
	return "newString" // edit
}

// editSeed is the text the textarea opens with: the model's originally proposed replacement.
func editSeed(r api.Approval) string {
	return stringField(r.Input, editedField(r.Tool))
}

func stringField(m map[string]any, key string) string {
	if s, ok := m[key].(string); ok {
		return s
	}
	return ""
}

// crudeDiff mirrors src/tools/tools.ts's editDiff/writeFileDiff format (whole-block +/-, no LCS).
// Used here to preview an in-place edit without a server round trip: before is always the model's
// original proposal, after is what the user is currently typing — not the true prior file content
// (write_file approvals never send that to the client), so this answers "what did I change from
// what the agent proposed", which is the question editing actually needs answered.
func crudeDiff(before, after string) string {
	lines := []string{"@@ your edit @@"}
	for _, l := range strings.Split(before, "\n") {
		lines = append(lines, "-"+l)
	}
	for _, l := range strings.Split(after, "\n") {
		lines = append(lines, "+"+l)
	}
	return strings.Join(lines, "\n")
}

func (m *Model) openDiffEdit() {
	ta := textarea.New()
	ta.SetValue(editSeed(m.approvals[m.diffv.idx]))
	ta.Focus()
	m.diffv.textarea = ta
	m.diffv.editing = true
}

func (m *Model) diffViewKey(k tea.KeyMsg) tea.Cmd {
	if len(m.approvals) == 0 {
		m.diffv = diffview{}
		return nil
	}
	m.diffv.idx = clamp(m.diffv.idx, 0, len(m.approvals)-1)

	if m.diffv.editing {
		switch k.String() {
		case "esc":
			m.diffv.editing = false
			return nil
		case "ctrl+s":
			r := m.approvals[m.diffv.idx]
			m.diffv.edited = map[string]any{editedField(r.Tool): m.diffv.textarea.Value()}
			m.diffv.editing = false
			return nil
		}
		var cmd tea.Cmd
		m.diffv.textarea, cmd = m.diffv.textarea.Update(k)
		return cmd
	}

	page := max(m.height-12, 3)
	switch k.String() {
	case "up", "k":
		m.diffv.top = max(m.diffv.top-1, 0)
		return nil
	case "down", "j":
		m.diffv.top++
		return nil
	case "pgup":
		m.diffv.top = max(m.diffv.top-page, 0)
		return nil
	case "pgdown", " ":
		m.diffv.top += page
		return nil
	case "home", "g":
		m.diffv.top = 0
		return nil
	case "end", "G":
		m.diffv.top = 1 << 30 // clamped against the real line count at render time
		return nil
	case "tab":
		if len(m.approvals) > 1 {
			m.diffv.idx = (m.diffv.idx + 1) % len(m.approvals)
			m.diffv.top = 0
		}
		return nil
	case "shift+tab":
		if len(m.approvals) > 1 {
			m.diffv.idx = (m.diffv.idx - 1 + len(m.approvals)) % len(m.approvals)
			m.diffv.top = 0
		}
		return nil
	case "e":
		if m.diffv.idx == 0 {
			m.openDiffEdit()
		}
		return nil
	}

	// Only the actual head of the FIFO queue can be answered — everything else is a read-only
	// preview of what's coming, since the server only ever resolves pending[0].
	if m.diffv.idx != 0 {
		return nil
	}
	var ok bool
	var scope string
	switch k.String() {
	case "y", "Y":
		ok, scope = true, ""
	case "a", "A":
		ok, scope = true, "agent"
	case "n", "N", "esc":
		ok, scope = false, ""
	default:
		return nil
	}
	edited := m.diffv.edited
	m.approvals = m.approvals[1:]
	m.diffv = diffview{}
	client := m.client
	return func() tea.Msg { return actionResultMsg{action: "approval", err: client.Approve(ok, scope, edited)} }
}

func diffLineColor(l string) lipgloss.Color {
	switch {
	case strings.HasPrefix(l, "@@"):
		return theme.Muted
	case strings.HasPrefix(l, "+"):
		return theme.Green
	case strings.HasPrefix(l, "-"):
		return theme.Red
	default:
		return theme.Fg
	}
}

func (m Model) diffView(w, h int) string {
	bg := theme.BgDeep
	if len(m.approvals) == 0 {
		return lipgloss.NewStyle().Width(w).Height(h).Background(bg).Render("")
	}
	idx := clamp(m.diffv.idx, 0, len(m.approvals)-1)
	r := m.approvals[idx]
	iw := max(w-4, 10)
	inner := max(h-2, 1)

	head := fmt.Sprintf(" %s wants to run %s on %s", r.AgentID, r.Tool, stringField(r.Input, "path"))
	switch {
	case idx != 0:
		head = fmt.Sprintf(" (preview %d/%d, read-only) ", idx+1, len(m.approvals)) + head
	case len(m.approvals) > 1:
		head = fmt.Sprintf(" (%d/%d) ", idx+1, len(m.approvals)) + head
	}

	if m.diffv.editing {
		m.diffv.textarea.SetWidth(iw)
		m.diffv.textarea.SetHeight(max(inner-4, 3))
		lines := []string{
			txt(theme.Accent, bg).Bold(true).Render(truncate(head, iw)),
			"",
			m.diffv.textarea.View(),
		}
		lines = padTo(lines, inner-1)
		lines = append(lines, txt(theme.Muted, bg).Render("ctrl+s save edit · esc cancel edit"))
		return lipgloss.NewStyle().Width(w).Height(h).MaxHeight(h).Padding(1, 2).Background(bg).Render(exactly(lines, inner))
	}

	var diffText string
	switch {
	case m.diffv.edited != nil:
		diffText = crudeDiff(editSeed(r), stringField(m.diffv.edited, editedField(r.Tool)))
	default:
		diffText, _ = approvalDiff(r)
	}

	var diffLines []string
	if diffText != "" {
		diffLines = strings.Split(diffText, "\n")
	}
	rows := max(inner-2, 3)
	top := clamp(m.diffv.top, 0, max(len(diffLines)-rows, 0))
	var body []string
	for i := top; i < len(diffLines) && i < top+rows; i++ {
		body = append(body, txt(diffLineColor(diffLines[i]), bg).Render(truncate(diffLines[i], iw)))
	}
	if len(diffLines) == 0 {
		body = append(body, txt(theme.Muted, bg).Render("(no diff available for this call)"))
	}

	keys := "[y]es · [a]lways · [n]o · [e]dit"
	if idx != 0 {
		keys = "read-only preview"
	}
	if len(m.approvals) > 1 {
		keys += " · tab/shift+tab: other pending"
	}
	if m.diffv.edited != nil {
		keys = "(edited)  " + keys
	}

	lines := append([]string{txt(theme.Accent, bg).Bold(true).Render(truncate(head, iw))}, body...)
	lines = padTo(lines, inner-1)
	lines = append(lines, txt(theme.Muted, bg).Render(truncate("↑↓ scroll · "+keys, iw)))
	return lipgloss.NewStyle().Width(w).Height(h).MaxHeight(h).Padding(1, 2).Background(bg).Render(exactly(lines, inner))
}
