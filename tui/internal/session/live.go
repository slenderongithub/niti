package session

import (
	"fmt"
	"strings"
	"time"

	"github.com/niti/tui/internal/api"
	"github.com/niti/tui/internal/theme"
	"github.com/charmbracelet/lipgloss"
)

// The live view: what the agents are doing, shown the way Claude Code shows it. A finished command
// leaves a one-line result and a few lines of output; a file change shows its numbered diff on
// tinted rows; big output stays folded until ctrl+o. The log stays a []string — scrolling,
// trimming and /transcript all keep working — and rich lines carry a leading marker rune from the
// Unicode private-use area that renderLine turns into style (and plainLine strips for the pager).

const (
	mkAdd    = '' // diff: added row      (gutter + text)
	mkDel    = '' // diff: removed row
	mkCtx    = '' // diff: context row
	mkOut    = '' // command output line
	mkOutErr = '' // a failed command's result line
	mkMore   = '' // "… +N lines (ctrl+o)" — shown only while collapsed
	mkExp    = '' // prefix: this line exists only while expanded (then its own kind marker)

	// Inline spans inside a line.
	mkBold, mkBoldEnd = '', ''
	mkCode, mkCodeEnd = '', ''
	mkHi, mkHiEnd     = '', '' // the changed words inside a changed diff row
)

// How much of a finished command / change shows before ctrl+o.
const (
	foldOutput = 3
	foldDiff   = 12
)

// visible reports whether a log line shows in the current expand state.
func visible(line string, expanded bool) bool {
	r := firstRune(line)
	switch r {
	case mkMore:
		return !expanded
	case mkExp:
		return expanded
	}
	return true
}

func firstRune(s string) rune {
	for _, r := range s {
		return r
	}
	return 0
}

// plainLine is a log line as text: markers stripped. The pager and anything that copies text use it.
func plainLine(line string) string {
	return strings.Map(func(r rune) rune {
		if r >= '' && r <= '' {
			return -1
		}
		return r
	}, line)
}

// --- events → log lines ---

// onToolEnd handles a finished call that carries live-view detail. It reports false for anything
// it leaves to the older path (reads and searches still fold into "✔ Read 3 files").
func (s *agentState) onToolEnd(ae api.AgentEvent) bool {
	switch {
	case ae.Type == "file_edit" && ae.Path != "" && (ae.Added > 0 || ae.Removed > 0 || len(ae.Hunks) > 0):
		s.running, s.runOut = "", nil
		s.group = nil
		s.pushDiff(ae)
		return true
	case ae.Tool == "shell":
		label := strings.TrimPrefix(s.running, "Run ")
		if label == "" {
			label = "command"
		}
		s.running, s.runOut = "", nil
		s.group = nil
		ok := ae.Ok == nil || *ae.Ok
		glyph := "✔"
		if !ok {
			glyph = "✖"
		}
		s.push(fmt.Sprintf("%s Ran %s · %s", glyph, label, fmtDur(time.Duration(ae.DurationMs)*time.Millisecond)))
		if ae.Outcome != "" {
			if ok {
				s.push("  ⎿ " + ae.Outcome)
			} else {
				s.push(string(mkOutErr) + "  ⎿ " + ae.Outcome)
			}
		}
		s.pushFolded(ae.Body, ae.Lines)
		return true
	}
	return false
}

// pushFolded adds a command's output: the first few lines always, the rest only when expanded.
func (s *agentState) pushFolded(body []string, total int) {
	for i, l := range body {
		line := string(mkOut) + "    " + l
		if i >= foldOutput {
			line = string(mkExp) + line
		}
		s.log = append(s.log, line) // not push(): repeated output lines are real output, not a retry loop
	}
	if hidden := total - min(len(body), foldOutput); hidden > 0 && len(body) > foldOutput {
		s.log = append(s.log, fmt.Sprintf("%c    … +%d lines (ctrl+o to expand)", mkMore, hidden))
	}
	s.trim()
}

// pushDiff adds a file change: "✔ Updated src/a.ts (+2 −1)" and its numbered rows, with the
// changed words of each changed row marked for a stronger tint.
func (s *agentState) pushDiff(ae api.AgentEvent) {
	verb := "Updated"
	if ae.Removed == 0 && len(ae.Hunks) > 0 && ae.Hunks[0].Lines[0].O == 0 && ae.Hunks[0].Lines[0].K == "+" {
		verb = "Created"
	}
	counts := fmt.Sprintf("+%d", ae.Added)
	if ae.Removed > 0 {
		counts += fmt.Sprintf(" −%d", ae.Removed)
	}
	s.push(fmt.Sprintf("✔ %s %s (%s)", verb, ae.Path, counts))

	var rows []string
	for hi, h := range ae.Hunks {
		if hi > 0 {
			rows = append(rows, string(mkCtx)+"      ⋮")
		}
		lines := h.Lines
		for i := 0; i < len(lines); i++ {
			// A run of removals followed by the same number of additions is a set of changed rows:
			// pair them up and mark what actually changed inside each.
			if lines[i].K == "-" {
				j := i
				for j < len(lines) && lines[j].K == "-" {
					j++
				}
				k := j
				for k < len(lines) && lines[k].K == "+" {
					k++
				}
				dels, adds := lines[i:j], lines[j:k]
				paired := len(dels) == len(adds)
				for d := range dels {
					text := dels[d].T
					if paired {
						text, _ = markChange(dels[d].T, adds[d].T)
					}
					rows = append(rows, fmt.Sprintf("%c%4d - %s", mkDel, dels[d].O, highlight(text, ae.Path)))
				}
				for a := range adds {
					text := adds[a].T
					if paired {
						_, text = markChange(dels[a].T, adds[a].T)
					}
					rows = append(rows, fmt.Sprintf("%c%4d + %s", mkAdd, adds[a].N, highlight(text, ae.Path)))
				}
				i = k - 1
				continue
			}
			switch lines[i].K {
			case "+":
				rows = append(rows, fmt.Sprintf("%c%4d + %s", mkAdd, lines[i].N, highlight(lines[i].T, ae.Path)))
			default:
				rows = append(rows, fmt.Sprintf("%c%4d   %s", mkCtx, lines[i].N, highlight(lines[i].T, ae.Path)))
			}
		}
	}
	for i, r := range rows {
		if i >= foldDiff {
			r = string(mkExp) + r
		}
		s.log = append(s.log, r)
	}
	hidden := max(len(rows)-foldDiff, 0) + ae.More
	if hidden > 0 {
		s.log = append(s.log, fmt.Sprintf("%c      … +%d lines (ctrl+o to expand)", mkMore, hidden))
	}
	s.trim()
}

// markChange wraps the part of a and b that differs (after their common prefix and suffix) in the
// highlight markers — word-level emphasis inside a changed row, like Claude Code's darker tint.
func markChange(a, b string) (string, string) {
	ra, rb := []rune(a), []rune(b)
	p := 0
	for p < len(ra) && p < len(rb) && ra[p] == rb[p] {
		p++
	}
	s := 0
	for s < len(ra)-p && s < len(rb)-p && ra[len(ra)-1-s] == rb[len(rb)-1-s] {
		s++
	}
	wrap := func(r []rune) string {
		mid := r[p : len(r)-s]
		if len(mid) == 0 || len(mid) == len(r) {
			return string(r) // nothing or everything changed: a highlight would add no information
		}
		return string(r[:p]) + string(mkHi) + string(mid) + string(mkHiEnd) + string(r[len(r)-s:])
	}
	return wrap(ra), wrap(rb)
}

// trim keeps the log bounded after bulk appends (push() does the same for single lines).
func (s *agentState) trim() {
	if len(s.log) > agentLogMax {
		s.log = s.log[len(s.log)-agentLogMax:]
	}
}

// onTodo keeps the agent's checklist pinned under its header while work remains; when the last
// step is done it collapses into one line in the log.
func (s *agentState) onTodo(todos []api.Todo) {
	if len(todos) == 0 {
		s.todos = nil
		return
	}
	done := 0
	for _, t := range todos {
		if t.Status == "done" {
			done++
		}
	}
	if done == len(todos) {
		s.todos = nil
		s.push(fmt.Sprintf("✔ Plan complete · %d/%d steps", done, len(todos)))
		return
	}
	s.todos = todos
}

// --- rendering ---

// renderLine styles one visible log line at width w.
func renderLine(line string, w int, bg lipgloss.Color) string {
	r := firstRune(line)
	if r == mkExp {
		line = line[len(string(mkExp)):]
		r = firstRune(line)
	}
	body := func() string { return line[len(string(r)):] }
	switch r {
	case mkAdd, mkDel:
		rowBg, sign := theme.Tint(theme.Green), theme.Green
		if r == mkDel {
			rowBg, sign = theme.Tint(theme.Red), theme.Red
		}
		text := body()
		gutter, rest := splitGutter(text)
		strong := blendTint(sign)
		out := lipgloss.NewStyle().Foreground(theme.Muted).Background(rowBg).Render(gutter) +
			inline(rest, lipgloss.NewStyle().Foreground(theme.Fg).Background(rowBg), strong)
		return fill(truncate(out, w), w, rowBg)
	case mkCtx:
		gutter, rest := splitGutter(body())
		return truncate(txt(theme.Line, bg).Render(gutter)+inline(rest, txt(theme.Muted, bg), txt(theme.Muted, bg)), w)
	case mkOut:
		return truncate(txt(theme.Muted, bg).Render(body()), w)
	case mkOutErr:
		return truncate(txt(theme.Red, bg).Render(body()), w)
	case mkMore:
		return truncate(txt(theme.Line, bg).Render(body()), w)
	}
	return truncate(inline(line, lineStyle(line, bg), lipgloss.NewStyle().Background(bg)), w)
}

// splitGutter separates "  12 + " (number and sign) from the row's text.
func splitGutter(s string) (string, string) {
	if len(s) >= 7 {
		return s[:7], s[7:]
	}
	return s, ""
}

// blendTint is the stronger tint for the changed words inside a changed row.
func blendTint(c lipgloss.Color) lipgloss.Style {
	return lipgloss.NewStyle().Foreground(theme.Fg).Background(theme.Blend(c, theme.BgDeep, 0.55)).Bold(true)
}

// inline renders a line's inline spans: **bold**, `code`, the diff's changed-words tint, and syntax
// color. They are independent states — a keyword can sit inside a changed-words span — so each run
// of text is styled from all of them at once.
func inline(s string, base lipgloss.Style, hi lipgloss.Style) string {
	if !strings.ContainsFunc(s, func(r rune) bool { return r >= '\uE010' && r <= '\uE0FF' }) {
		return base.Render(s)
	}
	var b, cur strings.Builder
	bold, code, high := false, false, false
	var syn rune
	style := func() lipgloss.Style {
		st := base
		if high {
			st = hi
		}
		switch {
		case code:
			st = st.Foreground(theme.Accent)
		case syn == mkSynKw:
			st = st.Foreground(theme.Alt)
		case syn == mkSynStr:
			st = st.Foreground(theme.Amber)
		case syn == mkSynNum:
			st = st.Foreground(theme.Blue)
		case syn == mkSynCom:
			st = st.Foreground(theme.Muted).Italic(true)
		}
		return st.Bold(bold || high)
	}
	flush := func() {
		if cur.Len() > 0 {
			b.WriteString(style().Render(cur.String()))
			cur.Reset()
		}
	}
	for _, r := range s {
		switch r {
		case mkBold, mkBoldEnd:
			flush()
			bold = r == mkBold
		case mkCode, mkCodeEnd:
			flush()
			code = r == mkCode
		case mkHi, mkHiEnd:
			flush()
			high = r == mkHi
		case mkSynKw, mkSynStr, mkSynNum, mkSynCom:
			flush()
			syn = r
		case mkSynEnd:
			flush()
			syn = 0
		default:
			cur.WriteRune(r)
		}
	}
	flush()
	return b.String()
}

// fill pads a styled line to w cells with bg, so a diff row's tint runs the full width.
func fill(s string, w int, bg lipgloss.Color) string {
	if pad := w - lipgloss.Width(s); pad > 0 {
		s += lipgloss.NewStyle().Background(bg).Render(strings.Repeat(" ", pad))
	}
	return s
}

// todoLines is the pinned checklist: done steps struck through, the current one highlighted.
func todoLines(todos []api.Todo, w int, bg lipgloss.Color) []string {
	var out []string
	for _, t := range todos {
		switch t.Status {
		case "done":
			out = append(out, txt(theme.Green, bg).Render("  ☑ ")+txt(theme.Muted, bg).Strikethrough(true).Render(truncate(t.Text, max(w-4, 0))))
		case "doing":
			out = append(out, txt(theme.Accent, bg).Bold(true).Render("  ◼ "+truncate(t.Text, max(w-4, 0))))
		default:
			out = append(out, txt(theme.Muted, bg).Render("  ☐ "+truncate(t.Text, max(w-4, 0))))
		}
	}
	return out
}
