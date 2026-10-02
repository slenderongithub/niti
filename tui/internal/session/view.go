package session

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/niti/tui/internal/theme"
	"github.com/niti/tui/internal/ui"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

// Layout — posting's shape: titled panels whose borders carry the live detail, a prompt panel whose
// border names the mode, and a footer listing the keys that work right now.
//
//	 niti 0.3.3                                   ~/code/app · gemini-flash · Build
//	╭──────────── Agents ─╮╭─────────────────────────────────────── Transcript ─╮
//	│ ◆ Lead ★    working ││ ≡ All agents   ◆ Lead   ▲ Coder                    │
//	│ ▲ Coder        idle ││ ◆ Lead  google/gemini-flash             ● working  │
//	│                     ││ │ ⏺ Read src/engine.ts                             │
//	│ Tasks               ││ │ ⎿ 554 lines                                      │
//	│ ● Add login route   ││                                                    │
//	╰─ 45% ctx · $0.03 ───╯╰─ 2 agents · 12.4k tok ─────────────────────────────╯
//	╭─ Build ──────────────────────────────────────────────────────────────────╮
//	│ ▸ describe the change…                                                    │
//	╰─ status messages land here ──────────────────────────────────────────────╯
//	 ^p Commands  tab Focus  ⇧tab Plan mode  ^l Models  f1 Help  ^c Quit
//
// Every row is sized from m.width/m.height, which Update() refreshes on each tea.WindowSizeMsg, so
// a resize reflows rather than clipping — and the body is what flexes, so the prompt can never be
// pushed off the bottom. Small terminals (and the "spacing: Compact" palette entry) drop the
// borders, as posting's compact mode does.
const (
	headerRows  = 1  // the title bar
	sidebarMin  = 22 // narrower than this and the sidebar is unreadable, so it's dropped instead
	sidebarMax  = 32
	sidebarHide = 76 // total width below which there's no room for a sidebar at all
	minAgentRow = 3  // an agent block worth drawing: header + 2 transcript lines
)

// compact is posting's spacing mode: no panel borders. Chosen automatically when the terminal is
// too small for frames to be worth their rows, or explicitly from the palette.
func (m Model) compact() bool {
	return m.prefs["compact"] || (m.width > 0 && m.width < 70) || (m.height > 0 && m.height < 20)
}

func (m Model) sidebarShown() bool { return m.width == 0 || m.width >= sidebarHide }

func (m Model) View() (frame string) {
	if m.quitting {
		return "bye.\n"
	}
	w, h := m.width, m.height
	if m.vm != nil {
		m.vm.scrollMax, m.vm.measured = 0, true // agentBlock raises it as it lays out
	}
	if w == 0 {
		w = 100 // before the first WindowSizeMsg arrives
	}
	if h == 0 {
		h = 30
	}
	// Whatever any view below returns, it leaves here no wider or taller than the terminal: a row
	// that wraps pushes every panel down a line and leaves stale copies of the bottom rows behind.
	defer func() { frame = ui.Frame(frame, w, h) }()

	// The settings overlay paints over the whole TUI — like the ctrl+p palette it takes the screen
	// while open rather than tiling into the layout.
	if m.sett.open {
		return m.settingsView(w, h)
	}
	// A diff on the head of the approval queue gets the same full-screen treatment — there's no
	// reading a real patch (or editing one) inside a one-line bar.
	if len(m.approvals) > 0 {
		if _, ok := approvalDiff(m.approvals[0]); ok {
			return m.diffView(w, h)
		}
	}

	compact := m.compact()
	promptRows := 3
	if compact {
		promptRows = 1
	}
	// Fixed chrome is budgeted first; the body absorbs whatever is left. The agent-to-agent feed is
	// the first thing given up on a short terminal, then the command menu.
	feedRows := 0
	if len(m.feed) > 0 {
		switch {
		case h >= 30:
			feedRows = 2
		case h >= 18:
			feedRows = 1
		}
	}
	menuRows := 0
	if m.menuOpen && m.menu.Len() > 0 {
		menuRows = clamp(m.menu.Len(), 1, 6)
	}
	if len(m.approvals) > 0 && !compact {
		promptRows = 3 + len(m.approvalCallLines(w)) // border, "who wants to run:", the call, border
	}
	fixed := headerRows + promptRows + 1 // +1: the footer
	bodyH := h - fixed - feedRows - menuRows
	if bodyH < 3 {
		feedRows = 0
		bodyH = h - fixed - menuRows
	}
	if bodyH < 3 {
		menuRows, bodyH = 0, max(h-fixed, 1)
	}

	sw := 0
	if w >= sidebarHide {
		sw = clamp(w/5, sidebarMin, sidebarMax)
	}
	body := m.mainPane(w-sw, bodyH, compact)
	if sw > 0 {
		body = lipgloss.JoinHorizontal(lipgloss.Top, m.sidebar(sw, bodyH, compact), body)
	}

	rows := []string{m.header(w), body}
	if feedRows > 0 {
		rows = append(rows, m.commFeed(w, feedRows))
	}
	if menuRows > 0 {
		rows = append(rows, m.menuView(w, menuRows))
	}
	rows = append(rows, m.promptPanel(w, promptRows, compact), m.footer(w, compact))
	// Clamped before the popups go on, so they overlay rows that are already the right width.
	out := ui.Frame(strings.Join(rows, "\n"), w, h)
	// At most one popup is reachable at a time (onKey gives whichever is open the keyboard), so the
	// order here is only about which one wins if two flags are somehow set.
	switch {
	case m.out.open:
		out = ui.Overlay(out, m.outputView(w, h), w, h)
	case m.pal.open:
		out = ui.OverlayAt(out, m.paletteView(w, h), w, h, 2)
	case m.car.open:
		out = ui.Overlay(out, m.carouselView(w, h), w, h)
	case m.akp.open:
		out = ui.Overlay(out, m.apiKeyView(w, h), w, h)
	case m.ap.open:
		out = ui.Overlay(out, m.agentPickerView(w, h), w, h)
	case m.tp.open:
		out = ui.Overlay(out, m.themePickerView(w, h), w, h)
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

func bar(pct, width int, fill, empty, bg lipgloss.Color) string {
	if width < 1 {
		return ""
	}
	done := clamp(pct*width/100, 0, width)
	return txt(fill, bg).Render(strings.Repeat("█", done)) + txt(empty, bg).Render(strings.Repeat("░", width-done))
}

// --- header ---

// posting's title bar: the app name and version on the left, where-am-I on the right — here the
// project, the model of the agent on screen, and the mode as a tinted chip.
func (m Model) header(w int) string {
	bg := theme.BgDeep
	left := txt(theme.Accent, bg).Bold(true).Render(" niti") + txt(theme.Muted, bg).Render(" "+ui.Version)
	if m.disconnected {
		left += txt(theme.Red, bg).Bold(true).Render("  offline — reconnecting")
	}

	mode, mc := "Build", theme.Accent
	if m.mode == "plan" {
		mode, mc = "Plan", theme.Alt
	}
	chip := lipgloss.NewStyle().Foreground(mc).Background(theme.Tint(mc)).Bold(true).Render(" " + mode + " ")
	model := ""
	if st := m.shownAgent(); st != nil {
		model = st.cfg.Model
	}
	room := max(w-lipgloss.Width(left)-lipgloss.Width(chip)-4, 0)
	where := ui.ShortPath(m.root, room*2/3)
	if model != "" {
		where = ui.Truncate(where+" · "+model, room)
	}
	right := txt(theme.Muted, bg).Render(where+" ") + chip + txt(theme.Muted, bg).Render(" ")
	gap := max(w-lipgloss.Width(left)-lipgloss.Width(right), 0)
	return left + txt(theme.Muted, bg).Render(strings.Repeat(" ", gap)) + right
}

// shownAgent is the agent the screen is about: the one maximized, else the lead, else the first.
func (m Model) shownAgent() *agentState {
	if st := m.agents[m.focus]; st != nil {
		return st
	}
	for _, id := range m.order {
		if m.agents[id].cfg.Lead {
			return m.agents[id]
		}
	}
	if len(m.order) > 0 {
		return m.agents[m.order[0]]
	}
	return nil
}

// --- sidebar: who is on the team, what they're doing, and what the session is wired to ---

func (m Model) sidebar(sw, h int, compact bool) string {
	bg := theme.BgDeep
	iw := sw - 4 // border + padding either side
	if compact {
		iw = sw - 2
	}
	var lines []string
	label := func(s string) {
		lines = append(lines, txt(theme.Muted, bg).Bold(true).Render(truncate(s, iw)))
	}
	focused := m.context() == regionAgents

	// Agents: avatar + role on the left, status on the right, cursor bar when this panel has focus.
	for i, id := range m.order {
		st := m.agents[id]
		name := st.avatar + " " + st.cfg.Role
		if st.cfg.Lead {
			name += " ★"
		}
		status := st.status
		rowBg := bg
		if focused && i == m.agentCursor {
			rowBg = theme.Tint(theme.Accent)
		}
		name = truncate(name, max(iw-lipgloss.Width(status)-1, 1))
		gap := max(iw-lipgloss.Width(name)-lipgloss.Width(status), 1)
		lines = append(lines, txt(st.color, rowBg).Bold(st.id() == m.focus).Render(name)+
			txt(theme.Muted, rowBg).Render(strings.Repeat(" ", gap))+
			txt(theme.StatusColor(st.status), rowBg).Render(status))
	}

	if len(m.tasks) > 0 {
		lines = append(lines, "")
		label("Tasks")
		glyphs := map[string]string{"done": "●", "in_progress": "◐", "failed": "✖"}
		for _, t := range m.tasks {
			g := glyphs[t.Status]
			if g == "" {
				g = "○"
			}
			title := t.Description
			if title == "" {
				title = t.ID
			}
			lines = append(lines, txt(theme.StatusColor(t.Status), bg).Render(g+" ")+txt(theme.Fg, bg).Render(truncate(title, max(iw-2, 1))))
		}
	}

	// LSP/MCP: what the session is wired to. Given up first when the panel runs out of rows.
	var wired []string
	for _, l := range m.lsp {
		dot, c := "○", theme.Muted
		if l.Running {
			dot, c = "●", theme.Green
		}
		wired = append(wired, txt(c, bg).Render(dot+" ")+txt(theme.Fg, bg).Render(truncate("lsp "+l.Name, max(iw-2, 1))))
	}
	for _, s := range m.mcp {
		wired = append(wired, txt(theme.Blue, bg).Render("● ")+txt(theme.Fg, bg).Render(truncate(fmt.Sprintf("mcp %s · %d tools", s.Name, s.Tools), max(iw-2, 1))))
	}
	if len(wired) > 0 {
		lines = append(lines, "")
		label("Connected")
		lines = append(lines, wired...)
	}

	// The context figure is the agent closest to its window; it names that agent when there's room,
	// and drops detail rather than cutting a word in half when there isn't.
	_, limit, pct := m.contextDepth()
	who := ""
	if st := m.deepestAgent(); st != nil && len(m.order) > 1 {
		who = " " + st.cfg.Role
	}
	subtitle := ""
	for _, c := range []string{
		fmt.Sprintf("ctx %d%% of %s%s · %s", pct, fmtTok(limit), who, m.spend()),
		fmt.Sprintf("ctx %d%%%s · %s", pct, who, m.spend()),
		fmt.Sprintf("ctx %d%% · %s", pct, m.spend()),
		fmt.Sprintf("ctx %d%%", pct),
	} {
		if lipgloss.Width(c) <= sw-6 {
			subtitle = c
			break
		}
	}
	if compact {
		return lipgloss.NewStyle().Width(sw).Height(h).MaxHeight(h).Padding(0, 1).Background(theme.BgPane).Render(exactly(lines, h))
	}
	// The Files panel takes what the Agents panel doesn't need — the roster is a few lines, and the
	// space under it used to sit empty.
	agentsH, filesH := m.sidebarSplit(len(lines), h)
	agents := ui.Panel{Title: "Agents", Subtitle: subtitle, Focused: focused}.Render(strings.Join(lines, "\n"), sw, agentsH)
	if filesH == 0 {
		return agents
	}
	return agents + "\n" + m.filesPanel(sw, filesH)
}

// sidebarSplit sizes the Agents panel to its content (at most half the column) and gives the rest
// to Files — or everything to Agents when there'd be too little left for a useful tree.
func (m Model) sidebarSplit(agentLines, h int) (int, int) {
	agentsH := clamp(agentLines+2, 4, max(h/2, 4))
	if len(m.files) == 0 || h-agentsH < 6 {
		return h, 0
	}
	return agentsH, h - agentsH
}

// filesShown reports whether a Files panel is on screen to take focus.
func (m Model) filesShown() bool {
	return m.sidebarShown() && !m.compact() && len(m.files) > 0
}

func (s *agentState) id() string { return s.cfg.ID }

// deepestAgent is the agent closest to its context window — the one the sidebar's figure is about.
func (m Model) deepestAgent() *agentState {
	var best *agentState
	bestR := -1.0
	for _, id := range m.order {
		st := m.agents[id]
		lim := st.ctxLimit
		if lim <= 0 {
			lim = 128_000
		}
		if r := float64(st.ctxUsed) / float64(lim); r > bestR {
			best, bestR = st, r
		}
	}
	return best
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
		return "cost unknown"
	}
	if !m.costKnown {
		return fmt.Sprintf("$%.2f+", m.cost) // some model has no published price
	}
	return fmt.Sprintf("$%.2f", m.cost)
}

// --- main pane ---

func (m Model) mainPane(mw, h int, compact bool) string {
	iw, ih := max(mw-4, 1), max(h-2, 1) // inside the border and its padding
	if compact {
		iw, ih = max(mw-2, 1), h
	}
	var rows []string
	if len(m.order) > 1 && m.view != "usage" {
		rows = append(rows, m.tabBar(iw))
	}
	ch := max(ih-len(rows), 1)
	// The last run's card sits at the bottom of the transcript, where the eye lands when work ends.
	card := ""
	if cr := m.cardRows(); cr > 0 && m.view != "usage" && ch-cr >= 6 {
		card = m.cardView(iw)
		ch -= cr
	}
	switch {
	case m.view == "usage":
		rows = append(rows, m.usageView(iw, ch))
	case m.viewer != nil:
		rows = append(rows, m.viewerBody(iw, ch))
	case m.agents[m.focus] != nil:
		// A focused agent gets the whole pane via the same agentBlock renderer workView uses per
		// agent — no new rendering path, just a share of 1 instead of len(shown).
		rows = append(rows, m.agentBlock(m.agents[m.focus], iw, ch))
	default:
		rows = append(rows, m.workView(iw, ch))
	}
	if card != "" {
		rows = append(rows, card)
	}
	content := strings.Join(rows, "\n")
	if compact {
		return lipgloss.NewStyle().Width(mw).Height(h).MaxHeight(h).Padding(0, 1).Background(theme.BgDeep).Render(content)
	}

	title, sub := "Transcript", ""
	switch st := m.agents[m.focus]; {
	case m.view == "usage":
		title, sub = "Usage", fmt.Sprintf("%d calls · %s", m.totals.Calls, m.spend())
	case m.viewer != nil:
		title = m.viewer.path
		sub = fmt.Sprintf("%d lines · read-only · e edit · esc close", len(m.viewer.lines))
		if n := len(m.changed[m.viewer.path]); n > 0 {
			sub = fmt.Sprintf("%d lines · ▎%d changed this session · e edit · esc close", len(m.viewer.lines), n)
		}
	case st != nil:
		title, sub = st.avatar+" "+st.cfg.Role, fmt.Sprintf("%s/%s · %s tok", st.cfg.Provider, st.cfg.Model, fmtTok(st.tokens))
	default:
		sub = fmt.Sprintf("%d agents · %s tok", len(m.order), fmtTok(m.totals.InputTokens+m.totals.OutputTokens))
	}
	if r := m.runningLine(); r != "" && m.viewer == nil {
		sub = r
	}
	if m.scrollBack > 0 {
		sub = "scrolled back · G follows"
		if m.unseen > 0 {
			sub = fmt.Sprintf("scrolled back · %d new below · G follows", m.unseen)
		}
	}
	return ui.Panel{Title: title, Subtitle: sub, Focused: m.context() == regionTranscript}.Render(content, mw, h)
}

// tabBar lists the agents' views, posting-style: the active one bold with an underline, the rest
// muted. ctrl+g / alt+1…9 / the Agents panel switch between them; esc returns to All agents.
func (m Model) tabBar(w int) string {
	bg := theme.BgDeep
	tab := func(label string, active bool, c lipgloss.Color) string {
		if active {
			return lipgloss.NewStyle().Foreground(c).Background(bg).Bold(true).Underline(true).Render(label) + txt(theme.Fg, bg).Render("   ")
		}
		return txt(theme.Muted, bg).Render(label + "   ")
	}
	segs := []string{tab("≡ All agents", m.focus == "" && m.viewer == nil, theme.Fg)}
	for _, id := range m.order {
		st := m.agents[id]
		segs = append(segs, tab(st.avatar+" "+st.cfg.Role, id == m.focus && m.viewer == nil, st.color))
	}
	if m.viewer != nil {
		segs = append(segs, tab("▤ "+filepath.Base(m.viewer.path), true, theme.Accent))
	}
	return lipgloss.NewStyle().Width(w).MaxWidth(w).Background(bg).Render(truncate(strings.Join(segs, ""), w))
}

// One block per agent, stacked: who it is, then its live transcript. Stacked rather than tiled
// because streamed text needs width to be readable — tiling is how the old layout ended up as
// "two small boxes".
func (m Model) workView(w, h int) string {
	bg := theme.BgDeep
	if len(m.order) == 0 {
		return txt(theme.Muted, bg).Render(truncate("no agents configured — restart niti to pick a team", w))
	}
	// Before the first prompt there's nothing to transcribe, so the pane is the welcome: a
	// time-of-day greeting, the version, and the roster as avatars wired together — the visual the
	// notes ask for, sitting right on top of the command bar.
	if m.goal == "" {
		return m.welcomeView(w, h)
	}

	shown, note := m.order, ""
	per := h / len(shown)
	if per < minAgentRow {
		// More agents than rows: show as many as read properly and say what's hidden, rather than
		// slicing every one of them down to a single unreadable line.
		per = minAgentRow
		if fits := max(h/per-1, 1); fits < len(shown) {
			note = fmt.Sprintf("… %d more agent(s) — ^g opens one", len(shown)-fits)
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
	// The checklist stays pinned under the header while steps remain — it's the one thing that says
	// how far along the agent is, so it shouldn't scroll away.
	lines = append(lines, todoLines(st.todos, w, bg)...)

	body := make([]string, 0, len(st.log)+8)
	for _, l := range st.log {
		if visible(l, m.expanded) {
			body = append(body, l)
		}
	}
	if st.pending != "" {
		body = append(body, st.pending) // the line still being streamed
	}
	if st.running != "" {
		elapsed := ""
		if !st.runStart.IsZero() {
			elapsed = " · " + fmtDur(time.Since(st.runStart))
		}
		body = append(body, spinner(m.prefs["reduceMotion"])+" "+st.running+"…"+elapsed)
		// A running command's latest output, live — what makes a long test run watchable.
		for _, o := range st.runOut {
			if strings.TrimSpace(o) != "" {
				body = append(body, string(mkOut)+"    "+o)
			}
		}
	}
	if len(body) == 0 {
		body = []string{"—"}
	}
	gutter := txt(st.color, bg).Render("│ ")
	rows := max(per-2-len(st.todos), 1) // -2: the header, plus a blank row separating this block from the next
	if m.vm != nil {
		m.vm.scrollMax = max(m.vm.scrollMax, len(body)-rows)
	}
	end := max(len(body)-m.scrollBack, min(rows, len(body))) // scrolled back: stop short of the newest
	for i := max(end-rows, 0); i < end; i++ {
		line := renderLine(body[i], max(w-2, 0), bg)
		if st.pending != "" && body[i] == st.pending && i == len(body)-1 && st.running == "" {
			line = txt(theme.Muted, bg).Render(truncate(plainLine(body[i]), max(w-2, 0))) // dimmed: still arriving
		}
		lines = append(lines, gutter+line)
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

// The agent-to-agent traffic — niti's whole point, so it keeps a permanent strip rather than
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

// promptPanel is the prompt, framed: the border names the mode (Build in the accent, Plan in the
// secondary color) and carries the latest status message in its bottom edge, so a one-line command
// answer or a warning never competes with the key hints for the footer. With an approval pending
// it becomes the approval banner instead.
func (m Model) promptPanel(w, rows int, compact bool) string {
	if len(m.approvals) > 0 {
		return m.approvalBanner(w, rows, compact)
	}
	mode, mc := "Build", theme.Accent
	if m.mode == "plan" {
		mode, mc = "Plan", theme.Alt
	}
	bg := theme.BgDeep
	line := txt(mc, bg).Bold(true).Render("▸ ") + m.input.View()
	if compact {
		return lipgloss.NewStyle().Width(w).MaxWidth(w).Background(theme.BgPane).Render(" " + line)
	}
	p := ui.Panel{Title: mode, Subtitle: strings.TrimSpace(m.status), Focused: m.context() == regionPrompt || m.context() == "menu", TitleLeft: true, Color: mc}
	return p.Render(line, w, rows)
}

// approvalBanner is posting's "editing row" banner, for a decision: tinted in the warning color,
// saying who wants to run what in words — the footer carries the y/a/n keys.
func (m Model) approvalBanner(w, rows int, compact bool) string {
	r := m.approvals[0]
	bg := theme.BgDeep
	// The whole call, wrapped: a long command cut at the panel edge hid the part being approved.
	lines := []string{txt(theme.Fg, bg).Bold(true).Render(r.AgentID) + txt(theme.Fg, bg).Render(" wants to run:")}
	for _, l := range m.approvalCallLines(w) {
		lines = append(lines, txt(theme.Amber, bg).Bold(true).Render(l))
	}
	text := strings.Join(lines, "\n")
	if compact {
		return lipgloss.NewStyle().Width(w).MaxWidth(w).Background(theme.Tint(theme.Amber)).Render(" ⚠ " + truncate(r.AgentID+" wants to run "+approvalCall(r.Tool, r.Input), w-3))
	}
	sub := ""
	if n := len(m.approvals); n > 1 {
		sub = fmt.Sprintf("%d more waiting", n-1)
	}
	return ui.Panel{Title: "Approval needed", Subtitle: sub, Focused: true, TitleLeft: true, Color: theme.Amber}.Render(text, w, rows)
}

// approvalCallLines is the pending call wrapped to the banner's width, at most four lines; a longer
// one ends in "…".
func (m Model) approvalCallLines(w int) []string {
	const most = 4
	r := m.approvals[0]
	iw := max(w-4, 10)
	lines := strings.Split(ansi.Hardwrap(ansi.Wordwrap(ui.Clean(approvalCall(r.Tool, r.Input)), iw, " /"), iw, true), "\n")
	if len(lines) > most {
		lines = lines[:most]
		lines[most-1] = ui.Truncate(lines[most-1], iw-1) + "…"
	}
	return lines
}

// approvalCall renders a tool call the way a person would say it — `shell: git commit -m "x"`,
// `write_file: src/a.ts` — instead of Go's `map[command:git args:[commit -m x]]`.
func approvalCall(tool string, input map[string]any) string {
	str := func(k string) string {
		if v, ok := input[k].(string); ok {
			return v
		}
		return ""
	}
	switch {
	case str("command") != "":
		parts := []string{str("command")}
		if args, ok := input["args"].([]any); ok {
			for _, a := range args {
				s := fmt.Sprint(a)
				if strings.ContainsAny(s, " \t\"'") {
					s = fmt.Sprintf("%q", s)
				}
				parts = append(parts, s)
			}
		}
		return tool + ": " + strings.Join(parts, " ")
	case str("path") != "":
		return tool + ": " + str("path")
	}
	keys := make([]string, 0, len(input))
	for k := range input {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%v", k, input[k]))
	}
	return strings.TrimSpace(tool + " " + strings.Join(parts, " "))
}

// footer lists the keys that work right now (keys.go). In compact mode there is no prompt border
// to carry the status, so a fresh status message takes the footer's place.
func (m Model) footer(w int, compact bool) string {
	if s := strings.TrimSpace(m.status); compact && s != "" {
		return lipgloss.NewStyle().Width(w).MaxWidth(w).Background(theme.BgDeep).Render(txt(theme.Muted, theme.BgDeep).Render(truncate(" "+s, w)))
	}
	return m.footerLine(w)
}

// Line kind by leading glyph (set in humanize): actions and outcomes recede so the agent's own
// prose stands out, failures are red, task boundaries carry the accent.
func lineStyle(line string, bg lipgloss.Color) lipgloss.Style {
	switch {
	case strings.HasPrefix(line, "✖"):
		return txt(theme.Red, bg)
	case strings.HasPrefix(line, "✔"):
		return txt(theme.Green, bg)
	case strings.HasPrefix(line, "  - "):
		return txt(theme.Red, bg)
	case strings.HasPrefix(line, "  + "):
		return txt(theme.Green, bg)
	case strings.HasPrefix(line, "  │ "), strings.HasPrefix(line, "  ╭ "):
		return txt(theme.Muted, bg)
	case isSpinning(line):
		return txt(theme.Accent, bg)
	case strings.HasPrefix(line, "⚠"):
		return txt(theme.Amber, bg)
	case strings.HasPrefix(line, "▸"):
		return txt(theme.Accent, bg).Bold(true)
	case strings.HasPrefix(line, "⏺"), strings.HasPrefix(line, "  ⎿"), strings.HasPrefix(line, "·"):
		return txt(theme.Muted, bg)
	}
	return txt(theme.Fg, bg)
}
