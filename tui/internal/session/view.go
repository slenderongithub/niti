package session

import (
	"fmt"
	"os"
	"strings"

	"github.com/amux/tui/internal/theme"
	"github.com/amux/tui/internal/ui"
	"github.com/charmbracelet/lipgloss"
)

// Layout — the whole terminal is one painted surface, not boxes floating on the user's wallpaper:
//
//	┌──────────────────────────────────────────────────────────┐
//	│ ● amux  BUILD PLAN      ~/code/amux           ███░░  45%  │  header bar
//	│━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━│  mode stripe
//	│ CONTEXT      │ ◆ Architect  google/…      ● working       │
//	│  ███░ 25%    │ │ ⚒ read_file README.md                    │  sidebar │ work
//	│  13.2k / 1M  │ │ · planning the layout                    │
//	│  $0.42 spent │                                            │
//	│ AGENTS       │ ▲ Backend  zhipuai/glm-5   ○ idle          │
//	│ LSP  MCP …   │ │ —                                        │
//	├──────────────┴────────────────────────────────────────────│
//	│ t1 ● t2 ◐ t3 ○                                            │  tasks
//	│ architect ─handoff→ backend  api shape                    │  agent-to-agent feed
//	│ ▸ describe the project…                                   │  input
//	│ tab: panes · ctrl+p: plan · ctrl+t: theme · ready          │  footer
//	└──────────────────────────────────────────────────────────┘
//
// Every row is sized from m.width/m.height, which Update() refreshes on each tea.WindowSizeMsg, so
// a resize reflows rather than clipping — and the body is what flexes, so the input line can never
// be pushed off the bottom.
const (
	headerRows  = 2  // the bar plus the mode stripe under it
	sidebarMin  = 22 // narrower than this and the sidebar is unreadable, so it's dropped instead
	sidebarMax  = 32
	sidebarHide = 76 // total width below which there's no room for a sidebar at all
	minAgentRow = 3  // an agent block worth drawing: header + 2 transcript lines
)

func (m Model) View() string {
	if m.quitting {
		return "bye.\n"
	}
	w, h := m.width, m.height
	if w == 0 {
		w = 100 // before the first WindowSizeMsg arrives
	}
	if h == 0 {
		h = 30
	}

	// Fixed chrome is budgeted first; the body absorbs whatever is left. The optional strips (tasks,
	// agent-to-agent feed) are the first thing given up on a short terminal.
	tasksRows, feedRows := 0, 0
	if len(m.tasks) > 0 && h >= 14 {
		tasksRows = 1
	}
	if len(m.feed) > 0 {
		switch {
		case h >= 26:
			feedRows = 2
		case h >= 16:
			feedRows = 1
		}
	}
	// The slash-command suggestions sit directly on top of the prompt, so they come out of the same
	// budget as everything else — the body gives up the rows while the menu is open.
	menuRows := 0
	if m.menuOpen && m.menu.Len() > 0 {
		menuRows = clamp(m.menu.Len(), 1, 6)
	}

	bodyH := h - headerRows - tasksRows - feedRows - menuRows - 2 // -2: the input row and the footer
	if bodyH < 1 {
		tasksRows, feedRows = 0, 0
		bodyH = max(h-headerRows-menuRows-2, 1)
	}
	if bodyH < 1 { // a terminal too short for both: the menu is transient, the transcript isn't
		menuRows, bodyH = 0, max(h-headerRows-2, 1)
	}

	sw := 0
	if w >= sidebarHide {
		sw = clamp(w/5, sidebarMin, sidebarMax)
	}

	body := m.mainPane(w-sw, bodyH)
	if sw > 0 {
		body = lipgloss.JoinHorizontal(lipgloss.Top, m.sidebar(sw, bodyH), body)
	}

	rows := []string{m.header(w), body}
	if tasksRows > 0 {
		rows = append(rows, m.tasksStrip(w))
	}
	if feedRows > 0 {
		rows = append(rows, m.commFeed(w, feedRows))
	}
	if menuRows > 0 {
		rows = append(rows, m.menuView(w, menuRows))
	}
	if len(m.approvals) > 0 {
		rows = append(rows, m.approvalBar(w))
	} else {
		rows = append(rows, m.inputBar(w))
	}
	rows = append(rows, m.footer(w))
	// One ANSI-aware guarantee that nothing overflows the terminal, however long a streamed line or
	// a registry command list turns out to be.
	out := lipgloss.NewStyle().MaxWidth(w).MaxHeight(h).Render(strings.Join(rows, "\n"))
	if m.car.open {
		out = ui.Overlay(out, m.carouselView(w, h), w, h)
	}
	return out
}

// --- small helpers ---

// txt is the only way styled text is produced here: every style carries an explicit background,
// because an inner style that sets just a foreground resets the background too and punches a hole
// in the painted surface.
func txt(fg, bg lipgloss.Color) lipgloss.Style {
	return lipgloss.NewStyle().Foreground(fg).Background(bg)
}

func clamp(v, lo, hi int) int { return ui.Clamp(v, lo, hi) }

// Exactly n lines: extra dropped, short padded. Keeps a pane's height predictable no matter how
// much (or little) content it has.
func exactly(lines []string, n int) string {
	if len(lines) > n {
		lines = lines[:n]
	}
	for len(lines) < n {
		lines = append(lines, "")
	}
	return strings.Join(lines, "\n")
}

// 13_200 → "13.2k". Token counts are read at a glance, not audited.
func fmtTok(n int) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1e6)
	case n >= 1_000:
		return fmt.Sprintf("%.1fk", float64(n)/1e3)
	default:
		return fmt.Sprintf("%d", n)
	}
}

// $HOME collapsed to ~, then trimmed from the left (the tail of a path is the informative half).
func shortPath(p string, w int) string {
	if p == "" {
		return ""
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" && strings.HasPrefix(p, home) {
		p = "~" + p[len(home):]
	}
	if r := []rune(p); len(r) > w && w > 1 {
		return "…" + string(r[len(r)-w+1:])
	}
	return p
}

func bar(pct, width int, fill, empty, bg lipgloss.Color) string {
	if width < 1 {
		return ""
	}
	done := clamp(pct*width/100, 0, width)
	return txt(fill, bg).Render(strings.Repeat("█", done)) + txt(empty, bg).Render(strings.Repeat("░", width-done))
}

// --- header ---

func (m Model) header(w int) string {
	bg := theme.BgPane
	brand := txt(theme.Accent, bg).Bold(true).Render(" ● amux")
	left := brand + " " + m.pill("BUILD", "build") + m.pill("PLAN", "plan")

	pb := bar(m.progress, clamp(w/8, 5, 18), theme.Accent, theme.Line, bg)
	right := pb + txt(theme.Muted, bg).Render(fmt.Sprintf(" %3d%% ", m.progress))

	used := lipgloss.Width(left) + lipgloss.Width(right)
	path := txt(theme.Muted, bg).Render(shortPath(m.root, max(w-used-4, 0)))
	free := max(w-used-lipgloss.Width(path), 0)
	pad := func(n int) string { return txt(theme.Muted, bg).Render(strings.Repeat(" ", n)) }

	stripe := theme.Accent
	if m.mode == "plan" {
		stripe = theme.Alt
	}
	return left + pad(free/2) + path + pad(free-free/2) + right + "\n" +
		txt(stripe, theme.BgDeep).Render(strings.Repeat("━", max(w, 0)))
}

// The active mode is a filled pill; the other is a hint that it exists (and ctrl+p reaches it).
func (m Model) pill(label, mode string) string {
	c := theme.Accent
	if mode == "plan" {
		c = theme.Alt
	}
	if m.mode == mode {
		return lipgloss.NewStyle().Foreground(theme.BgDeep).Background(c).Bold(true).Render(" " + label + " ")
	}
	return txt(theme.Muted, theme.BgPane).Render(" " + label + " ")
}

// --- sidebar: what this session is attached to, and what it has cost ---

func (m Model) sidebar(sw, h int) string {
	bg := theme.BgPane
	iw := sw - 2 // lipgloss Width() is the total including padding, so the text gets what's left
	var lines []string
	label := func(s string) {
		lines = append(lines, txt(theme.Accent, bg).Bold(true).Render(truncate(s, iw)))
	}
	item := func(c lipgloss.Color, s string) {
		lines = append(lines, txt(c, bg).Render(truncate(s, iw)))
	}

	used, limit, pct := m.contextDepth()
	label("CONTEXT")
	lines = append(lines, bar(pct, max(iw-5, 1), theme.Accent, theme.Line, bg)+txt(theme.Muted, bg).Render(fmt.Sprintf(" %d%%", pct)))
	item(theme.Muted, fmt.Sprintf("%s / %s ctx", fmtTok(used), fmtTok(limit)))
	item(theme.Muted, fmt.Sprintf("%s tok · %d calls", fmtTok(m.totals.InputTokens+m.totals.OutputTokens), m.totals.Calls))
	item(theme.Green, m.spend())
	lines = append(lines, "")

	// The LSP/MCP panels are the whole reason for a sidebar, so the roster — which the main pane
	// already shows in full — is what gives up rows when the sidebar can't hold everything: first
	// its per-agent status sub-lines, then the tail of the list itself.
	tail := 2 + max(len(m.lsp), 1) + 2 + max(len(m.mcp), 1) // the LSP and MCP blocks below
	free := max(h-len(lines)-1-tail, 1)                     // -1 for the AGENTS label
	roster, detailed := m.order, true
	if len(roster)*2 > free {
		detailed = false
		if len(roster) > free-1 {
			roster = roster[:max(free-1, 0)]
		}
	}

	label("AGENTS")
	for _, id := range roster {
		st := m.agents[id]
		lead := ""
		if st.cfg.Lead {
			lead = " ★"
		}
		if !detailed {
			// One line each: name, then the status/token detail folded onto it.
			item(st.color, st.avatar+" "+st.cfg.Role+lead+" · "+fmtTok(st.tokens))
			continue
		}
		item(st.color, st.avatar+" "+st.cfg.Role+lead)
		item(theme.StatusColor(st.status), "  "+st.status+" · "+fmtTok(st.tokens))
	}
	if n := len(m.order) - len(roster); n > 0 {
		item(theme.Muted, fmt.Sprintf("  +%d more", n))
	}
	lines = append(lines, "")

	label("LSP")
	if len(m.lsp) == 0 {
		item(theme.Line, "  none configured")
	}
	for _, l := range m.lsp {
		// Configured-but-idle vs. running is the difference between a typo in agents.yaml and a
		// language server that simply hasn't been needed yet.
		dot, c := "○", theme.Muted
		if l.Running {
			dot, c = "●", theme.Green
		}
		item(c, dot+" "+l.Name)
	}
	lines = append(lines, "")

	label("MCP")
	if len(m.mcp) == 0 {
		item(theme.Line, "  none connected")
	}
	for _, s := range m.mcp {
		item(theme.Blue, fmt.Sprintf("● %s (%d)", s.Name, s.Tools))
	}

	// The step from BgPane to the main pane's BgDeep is the divider. A drawn border would need its
	// own background to avoid punching an unpainted column between the two panes — and on a
	// non-truecolor terminal that border cell degrades to a stray escape sequence.
	return lipgloss.NewStyle().Width(sw).Height(h).MaxHeight(h).Padding(0, 1).
		Background(bg).Render(exactly(lines, h))
}

// The deepest agent context in the team — the one that will hit its window first, which is the
// number worth watching. Returns its last input size, its model's window, and the percentage.
func (m Model) contextDepth() (used, limit, pct int) {
	const fallback = 128_000 // matches DEFAULT_CONTEXT in providers/catalog.ts
	best := -1.0
	for _, id := range m.order {
		st := m.agents[id]
		lim := st.ctxLimit
		if lim <= 0 {
			lim = fallback
		}
		if r := float64(st.ctxUsed) / float64(lim); r > best {
			best, used, limit = r, st.ctxUsed, lim
		}
	}
	if limit <= 0 {
		return 0, fallback, 0
	}
	return used, limit, clamp(used*100/limit, 0, 100)
}

func (m Model) spend() string {
	if m.cost == 0 && !m.costKnown {
		return "cost n/a"
	}
	if !m.costKnown {
		return fmt.Sprintf("$%.2f+ spent", m.cost) // some model has no published price
	}
	return fmt.Sprintf("$%.2f spent", m.cost)
}

// --- main pane ---

func (m Model) mainPane(mw, h int) string {
	iw := max(mw-2, 1) // the two columns of padding Width() below accounts for
	var content string
	switch m.view {
	case "graph":
		content = m.graphView(iw, h)
	case "usage":
		content = m.usageView(iw, h)
	default:
		content = m.workView(iw, h)
	}
	return lipgloss.NewStyle().Width(mw).Height(h).MaxHeight(h).Padding(0, 1).
		Background(theme.BgDeep).Render(content)
}

// One block per agent, stacked: who it is, then its live transcript. Stacked rather than tiled
// because streamed text needs width to be readable — tiling is how the old layout ended up as
// "two small boxes".
func (m Model) workView(w, h int) string {
	bg := theme.BgDeep
	if len(m.order) == 0 {
		return txt(theme.Muted, bg).Render(truncate("no agents configured — restart amux to pick a team", w))
	}

	shown, note := m.order, ""
	per := h / len(shown)
	if per < minAgentRow {
		// More agents than rows: show as many as read properly and say what's hidden, rather than
		// slicing every one of them down to a single unreadable line.
		per = minAgentRow
		if fits := max(h/per-1, 1); fits < len(shown) {
			note = fmt.Sprintf("… %d more agent(s) — tab for /usage", len(shown)-fits)
			shown = shown[:fits]
		}
	}

	// Blocks pack from the top and take only the rows they actually need, up to their share. A quiet
	// agent leaves its slack to the bottom of the pane instead of stranding it as a hole mid-screen.
	var blocks []string
	for _, id := range shown {
		blocks = append(blocks, m.agentBlock(m.agents[id], w, per))
	}
	if note != "" {
		blocks = append(blocks, txt(theme.Muted, bg).Render(truncate(note, w)))
	}
	return strings.Join(blocks, "\n")
}

func (m Model) agentBlock(st *agentState, w, per int) string {
	bg := theme.BgDeep
	lines := []string{agentHeader(st, w, bg)}

	body := st.log
	if st.pending != "" {
		body = append(append([]string{}, body...), st.pending) // the line still being streamed
	}
	if len(body) == 0 {
		body = []string{"—"}
	}
	gutter := txt(st.color, bg).Render("│ ")
	rows := max(per-2, 1) // -2: the header, plus a blank row separating this block from the next
	for i := max(len(body)-rows, 0); i < len(body); i++ {
		style := txt(theme.Fg, bg)
		if st.pending != "" && i == len(body)-1 {
			style = txt(theme.Muted, bg) // dimmed: this line hasn't finished arriving
		}
		lines = append(lines, gutter+style.Render(truncate(body[i], max(w-2, 0))))
	}
	return exactly(lines, min(len(lines)+1, per)) // +1 for the separating blank row
}

func agentHeader(st *agentState, w int, bg lipgloss.Color) string {
	name := st.avatar + " " + st.cfg.Role
	if st.cfg.Lead {
		name += " ★"
	}
	status := "● " + st.status
	// The role and status are what identify a block; the model id gives up width first.
	model := truncate("  "+st.cfg.Provider+"/"+st.cfg.Model, max(w-lipgloss.Width(name)-lipgloss.Width(status)-1, 0))
	gap := max(w-lipgloss.Width(name)-lipgloss.Width(model)-lipgloss.Width(status), 1)

	return txt(st.color, bg).Bold(true).Render(name) +
		txt(theme.Muted, bg).Render(model) +
		txt(theme.Muted, bg).Render(strings.Repeat(" ", gap)) +
		txt(theme.StatusColor(st.status), bg).Render(status)
}

// graphView: who is talking to whom. The roster with the orchestrator marked, then the recent
// edges — as many as the pane has room for.
func (m Model) graphView(w, h int) string {
	bg := theme.BgDeep
	lines := []string{txt(theme.Accent, bg).Bold(true).Render("AGENTS")}
	for _, id := range m.order {
		st := m.agents[id]
		lead := ""
		if st.cfg.Lead {
			lead = txt(theme.Alt, bg).Render(" ★ orchestrator")
		}
		lines = append(lines, txt(st.color, bg).Render(" "+st.avatar+" "+truncate(id, max(w/2, 1)))+
			txt(theme.StatusColor(st.status), bg).Render(" ("+st.status+")")+lead)
	}
	lines = append(lines, "", txt(theme.Accent, bg).Bold(true).Render("MESSAGES"))

	shown := max(h-len(lines), 0)
	for i := max(len(m.messages)-shown, 0); i < len(m.messages); i++ {
		msg := m.messages[i]
		edge := fmt.Sprintf(" %s ─%s→ %s", msg.From, msg.Kind, msg.To)
		edge = truncate(edge, w)
		lines = append(lines, txt(theme.MessageColor(msg.Kind), bg).Render(edge)+
			txt(theme.Muted, bg).Render(truncate("  "+msg.Subject, max(w-lipgloss.Width(edge), 0))))
	}
	return exactly(lines, h)
}

func (m Model) usageView(w, h int) string {
	bg := theme.BgDeep
	lines := []string{txt(theme.Accent, bg).Bold(true).Render("USAGE")}
	for _, id := range m.order {
		st := m.agents[id]
		lines = append(lines, txt(theme.Fg, bg).Render(truncate(fmt.Sprintf(" %-20s %9s tok  %s/%s",
			truncate(st.cfg.Role, 20), fmtTok(st.tokens), st.cfg.Provider, st.cfg.Model), w)))
	}
	lines = append(lines,
		"",
		txt(theme.Accent, bg).Bold(true).Render(truncate(fmt.Sprintf(" %-20s %9s tok  %d calls",
			"TOTAL", fmtTok(m.totals.InputTokens+m.totals.OutputTokens), m.totals.Calls), w)),
		txt(theme.Green, bg).Render(truncate(" "+m.spend(), w)))
	return exactly(lines, h)
}

// --- bottom strips ---

func (m Model) tasksStrip(w int) string {
	bg := theme.BgDeep
	glyphs := map[string]string{"done": "●", "in_progress": "◐", "failed": "✖"}
	var parts []string
	used := 1
	for i, t := range m.tasks {
		g := glyphs[t.Status]
		if g == "" {
			g = "○"
		}
		chip := g + " " + t.ID
		if used+lipgloss.Width(chip)+2 > w-6 { // leave room for the "+N" overflow marker
			parts = append(parts, txt(theme.Muted, bg).Render(fmt.Sprintf("+%d", len(m.tasks)-i)))
			break
		}
		used += lipgloss.Width(chip) + 2
		parts = append(parts, txt(theme.StatusColor(t.Status), bg).Render(chip))
	}
	return lipgloss.NewStyle().Width(w).MaxWidth(w).Background(bg).Render(" " + strings.Join(parts, "  "))
}

// The agent-to-agent traffic — amux's whole point, so it keeps a permanent strip rather than
// living only behind /graph.
func (m Model) commFeed(w, lineCount int) string {
	bg := theme.BgDeep
	var lines []string
	for i := max(len(m.feed)-lineCount, 0); i < len(m.feed); i++ {
		lines = append(lines, txt(theme.Muted, bg).Render(" "+truncate(m.feed[i], max(w-1, 0))))
	}
	return lipgloss.NewStyle().Width(w).MaxWidth(w).Background(bg).Render(exactly(lines, lineCount))
}

// The command menu — the small guessing window that sits right over the prompt bar while a "/" is
// being typed, so the whole command set is discoverable instead of memorised.
func (m Model) menuView(w, rows int) string {
	bg := theme.BgPane
	return lipgloss.NewStyle().Width(w).MaxWidth(w).Background(bg).
		Render(m.menu.Render(max(w-1, 1), rows, bg))
}

func (m Model) inputBar(w int) string {
	bg := theme.BgPane
	c := theme.Accent
	if m.mode == "plan" {
		c = theme.Alt
	}
	return lipgloss.NewStyle().Width(w).MaxWidth(w).Background(bg).
		Render(txt(c, bg).Bold(true).Render(" ▸ ") + m.input.View())
}

func (m Model) approvalBar(w int) string {
	bg := theme.BgPane
	r := m.approvals[0]
	keys := "  [y]es  [a]lways  [n]o"
	head := fmt.Sprintf(" ⚠ %s wants to run %s %v", r.AgentID, r.Tool, r.Input)
	return lipgloss.NewStyle().Width(w).MaxWidth(w).Background(bg).Render(
		txt(theme.Amber, bg).Bold(true).Render(truncate(head, max(w-len(keys), 0))) +
			txt(theme.Muted, bg).Render(keys))
}

func (m Model) footer(w int) string {
	bg := theme.BgDeep
	next := "plan"
	if m.mode == "plan" {
		next = "build"
	}
	line := fmt.Sprintf(" tab: %s · ctrl+p: models · shift+tab: %s · ctrl+t: %s · / for commands · %s",
		m.view, next, theme.Current(), m.status)
	return lipgloss.NewStyle().Width(w).MaxWidth(w).Background(bg).
		Render(txt(theme.Muted, bg).Render(truncate(line, w)))
}
