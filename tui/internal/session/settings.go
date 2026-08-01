package session

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/amux/tui/internal/api"
	"github.com/amux/tui/internal/theme"
	"github.com/amux/tui/internal/ui"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// The settings overlay is amux's version of the Claude app's settings panel: one screen, tabs
// across the top (Settings · Status · Config · Usage · Stats), painted over the whole TUI. Every
// panel is built from data the session already holds — the team, the live usage totals, the
// per-agent token split — so nothing here needs a server round-trip.

const version = ui.Version

var settingsTabs = []string{"Settings", "Status", "Config", "Usage", "Stats"}

// settingsTabFor maps a slash command to the tab it opens on, and reports whether the overlay owns
// that command at all. "/settings" lands on the summary tab; the rest jump straight to their panel.
func settingsTabFor(name string) (int, bool) {
	switch name {
	case "settings":
		return 0, true
	case "status":
		return 1, true
	case "config":
		return 2, true
	case "usage":
		return 3, true
	case "stats":
		return 4, true
	}
	return 0, false
}

type settings struct {
	open        bool
	tab         int // index into settingsTabs
	statsTab    int // 0 Overview · 1 Models, only meaningful on the Stats tab
	stats       api.Stats
	statsLoaded bool
	statsErr    string
}

// settingsKey drives the overlay. ←/→/tab move between panels; on Stats, ↑/↓ toggle its two
// sub-views; esc closes. Everything is swallowed so the prompt underneath never sees a keystroke.
func (m *Model) settingsKey(k tea.KeyMsg) tea.Cmd {
	switch k.String() {
	case "esc", "q":
		m.sett = settings{}
	case "right", "tab", "l":
		m.sett.tab = (m.sett.tab + 1) % len(settingsTabs)
	case "left", "shift+tab", "h":
		m.sett.tab = (m.sett.tab - 1 + len(settingsTabs)) % len(settingsTabs)
	case "up", "down":
		if m.sett.tab == 4 {
			m.sett.statsTab ^= 1 // Overview ⇄ Models
		}
	}
	return nil
}

// --- render ---

func (m Model) settingsView(w, h int) string {
	bg := theme.BgDeep
	iw := max(w-4, 10) // the Padding(1,2) below

	// Tab bar: the active panel is a filled chip, the rest are muted labels — same grammar as the
	// BUILD/PLAN pills in the header.
	var chips []string
	for i, t := range settingsTabs {
		if i == m.sett.tab {
			chips = append(chips, lipgloss.NewStyle().Foreground(bg).Background(theme.Accent).Bold(true).Render(" "+t+" "))
		} else {
			chips = append(chips, txt(theme.Muted, bg).Render(" "+t+" "))
		}
	}
	lines := []string{strings.Join(chips, txt(theme.Line, bg).Render(" ")), ""}

	var body []string
	switch m.sett.tab {
	case 0:
		body = m.settWelcome(iw)
	case 1:
		body = m.settStatus(iw)
	case 2:
		body = m.settConfig(iw)
	case 3:
		body = m.settUsage(iw)
	case 4:
		body = m.settStats(iw)
	}
	lines = append(lines, body...)

	hint := "←/→ switch tabs · esc close"
	if m.sett.tab == 4 {
		hint = "↑/↓ overview/models · ←/→ tabs · esc close"
	}
	inner := max(h-2, 1) // Padding(1,·) eats the top and bottom row
	lines = padTo(lines, inner-1)
	lines = append(lines, txt(theme.Muted, bg).Render(hint))
	return lipgloss.NewStyle().Width(w).Height(h).MaxHeight(h).Padding(1, 2).Background(bg).
		Render(exactly(lines, inner))
}

// settWelcome — the landing panel: greeting, version, a one-line project summary, and a signpost to
// the other tabs. The same greeting the empty work pane shows, so the two read as one product.
func (m Model) settWelcome(w int) []string {
	bg := theme.BgDeep
	return []string{
		txt(theme.Accent, bg).Bold(true).Render(truncate(greeting(), w)),
		txt(theme.Muted, bg).Render("amux v" + version),
		"",
		m.avatarRow(w),
		"",
		kv(w, "Project", shortPath(m.root, max(w-14, 8))),
		kv(w, "Team", fmt.Sprintf("%d agents · %s mode", len(m.order), m.mode)),
		kv(w, "Theme", theme.Current()),
		"",
		txt(theme.Muted, bg).Render(truncate("Status · Config · Usage · Stats — ←/→ to explore.", w)),
	}
}

func (m Model) settStatus(w int) []string {
	bg := theme.BgDeep
	mcp := "none connected"
	if len(m.mcp) > 0 {
		var names []string
		for _, s := range m.mcp {
			names = append(names, fmt.Sprintf("%s(%d)", s.Name, s.Tools))
		}
		mcp = fmt.Sprintf("%d connected · %s", len(m.mcp), strings.Join(names, ", "))
	}
	lsp := "none configured"
	if len(m.lsp) > 0 {
		running := 0
		var names []string
		for _, l := range m.lsp {
			if l.Running {
				running++
			}
			names = append(names, l.Name)
		}
		lsp = fmt.Sprintf("%d running / %d · %s", running, len(m.lsp), strings.Join(names, ", "))
	}
	lines := []string{
		kv(w, "Version", version),
		kv(w, "Project", shortPath(m.root, max(w-14, 8))),
		kv(w, "Team", fmt.Sprintf("%d agents", len(m.order))),
		kv(w, "Mode", m.mode),
		kv(w, "Theme", theme.Current()),
		kv(w, "Status", m.status),
		"",
		txt(theme.Accent, bg).Bold(true).Render("Models"),
	}
	for _, id := range m.order {
		st := m.agents[id]
		lines = append(lines, txt(theme.Fg, bg).Render(truncate(fmt.Sprintf("  %s %-14s %s/%s", st.avatar, st.cfg.Role, st.cfg.Provider, st.cfg.Model), w)))
	}
	return append(lines, "",
		kv(w, "MCP servers", mcp),
		kv(w, "Language servers", lsp))
}

// settConfig — amux's real, changeable settings, not a mock of Claude Code's forty toggles. Theme
// and mode are live-editable (ctrl+t / shift+tab); the model assignments are what /config exists to
// show. ponytail: no fake switches — a config row for a value nothing reads is just decoration.
func (m Model) settConfig(w int) []string {
	bg := theme.BgDeep
	lines := []string{
		kvHint(w, "Theme", theme.Current(), "ctrl+t cycles"),
		kvHint(w, "Mode", m.mode, "shift+tab toggles"),
		kvHint(w, "Themes", strings.Join(theme.Names(), " "), "/theme <name>"),
		"",
		txt(theme.Accent, bg).Bold(true).Render("Agents"),
	}
	for _, id := range m.order {
		st := m.agents[id]
		lead := ""
		if st.cfg.Lead {
			lead = " ★"
		}
		lines = append(lines,
			txt(st.color, bg).Render(truncate(fmt.Sprintf("  %s %s%s", st.avatar, st.cfg.Role, lead), max(w/2, 8)))+
				txt(theme.Muted, bg).Render(truncate("  "+st.cfg.Provider+"/"+st.cfg.Model, max(w/2, 8))))
	}
	return append(lines, "",
		txt(theme.Muted, bg).Render(truncate("ctrl+p switches an agent's model.", w)))
}

func (m Model) settUsage(w int) []string {
	bg := theme.BgDeep
	used, limit, pct := m.contextDepth()
	lines := []string{
		txt(theme.Accent, bg).Bold(true).Render("Session"),
		kv(w, "Total cost", m.spend()),
		kv(w, "Tokens", fmt.Sprintf("%s in · %s out", fmtTok(m.totals.InputTokens), fmtTok(m.totals.OutputTokens))),
		kv(w, "Calls", fmt.Sprintf("%d", m.totals.Calls)),
		"",
		txt(theme.Accent, bg).Bold(true).Render("Deepest context"),
		"  " + bar(pct, clamp(w/3, 8, 40), theme.Accent, theme.Line, bg) +
			txt(theme.Muted, bg).Render(fmt.Sprintf(" %d%%  %s / %s", pct, fmtTok(used), fmtTok(limit))),
		"",
		txt(theme.Accent, bg).Bold(true).Render("Per agent"),
	}
	for _, id := range m.order {
		st := m.agents[id]
		lines = append(lines, txt(theme.Fg, bg).Render(truncate(fmt.Sprintf("  %s %-14s %6s in · %6s out",
			st.avatar, st.cfg.Role, fmtTok(st.in), fmtTok(st.out)), w)))
	}
	// ponytail: no plan-limit / weekly bars like the screenshot — amux runs on your own API keys, so
	// there is no quota to draw a percentage against. Add if a hosted plan ever gates usage.
	return lines
}

func (m Model) settStats(w int) []string {
	if m.sett.statsTab == 1 {
		return m.settStatsModels(w)
	}
	return m.settStatsOverview(w)
}

// subTabHead is the "Overview · Models" line at the top of the Stats panels, the active one lit.
func subTabHead(active int) string {
	bg := theme.BgDeep
	names := []string{"Overview", "Models"}
	var parts []string
	for i, n := range names {
		if i == active {
			parts = append(parts, txt(theme.Accent, bg).Bold(true).Render(n))
		} else {
			parts = append(parts, txt(theme.Muted, bg).Render(n))
		}
	}
	return strings.Join(parts, txt(theme.Muted, bg).Render("   ·   ")) + txt(theme.Muted, bg).Render("   (↑/↓)")
}

func (m Model) settStatsOverview(w int) []string {
	bg := theme.BgDeep
	s := m.sett.stats
	lines := []string{subTabHead(0), ""}
	if !m.sett.statsLoaded {
		return append(lines, txt(theme.Muted, bg).Render("loading history…"))
	}
	if m.sett.statsErr != "" {
		return append(lines, txt(theme.Red, bg).Render(truncate("stats unavailable: "+m.sett.statsErr, w)))
	}

	// The contribution heatmap: a year of days, most recent on the right, shaded by that day's tokens.
	lines = append(lines, heatmap(s.PerDay, w)...)
	lines = append(lines, "")

	total := s.InTokens + s.OutTokens
	fav := "—"
	if len(s.PerModel) > 0 {
		fav = shortModel(s.PerModel[0].Name)
	}
	longest, current := streaks(s.PerDay)
	active, span := activeSpan(s.PerDay)
	// Two columns of headline numbers, laid out like the screenshot.
	rows := [][2]string{
		{kvc("Favorite model", fav), kvc("Total tokens", fmtTokLong(total))},
		{kvc("Sessions", fmt.Sprintf("%d", s.Sessions)), kvc("Longest session", dur(s.LongestSessionMs))},
		{kvc("Active days", fmt.Sprintf("%d/%d", active, span)), kvc("Longest streak", fmt.Sprintf("%d days", longest))},
		{kvc("Most active", mostActiveDay(s.PerDay)), kvc("Current streak", fmt.Sprintf("%d days", current))},
	}
	half := max(w/2, 20)
	for _, r := range rows {
		lines = append(lines, truncate(padVis(r[0], half)+r[1], w))
	}
	return append(lines, "", txt(theme.Blue, bg).Render(truncate(bookQuip(total), w)))
}

func (m Model) settStatsModels(w int) []string {
	bg := theme.BgDeep
	s := m.sett.stats
	lines := []string{subTabHead(1), ""}
	if !m.sett.statsLoaded {
		return append(lines, txt(theme.Muted, bg).Render("loading history…"))
	}
	if m.sett.statsErr != "" {
		return append(lines, txt(theme.Red, bg).Render(truncate("stats unavailable: "+m.sett.statsErr, w)))
	}

	lines = append(lines, txt(theme.Accent, bg).Bold(true).Render("Tokens per day"))
	lines = append(lines, dayChart(s.PerDay, w, 6)...)
	lines = append(lines, "", txt(theme.Accent, bg).Bold(true).Render("Tokens by model  (all time)"))

	total := s.InTokens + s.OutTokens
	if total == 0 {
		total = 1
	}
	for i, a := range s.PerModel {
		tot := a.InTokens + a.OutTokens
		pct := tot * 100 / total
		c := theme.AgentColor(i)
		usd := fmt.Sprintf("$%.2f", a.Usd)
		if !a.Priced {
			usd = "$?"
		}
		lines = append(lines,
			txt(c, bg).Render(truncate("● "+shortModel(a.Name), max(2*w/3, 10)))+
				txt(theme.Muted, bg).Render(fmt.Sprintf("  (%d%%)", pct)),
			"  "+bar(pct, clamp(w/3, 8, 40), c, theme.Line, bg)+
				txt(theme.Muted, bg).Render(fmt.Sprintf("  in %s · out %s · %s", fmtTok(a.InTokens), fmtTok(a.OutTokens), usd)))
	}
	if len(s.PerModel) == 0 {
		lines = append(lines, txt(theme.Muted, bg).Render("  no tokens recorded yet"))
	}
	return lines
}

// --- welcome (work-pane empty state) ---

func (m Model) welcomeView(w, h int) string {
	bg := theme.BgDeep
	lines := []string{
		"",
		txt(theme.Accent, bg).Bold(true).Render(truncate(greeting(), w)),
		txt(theme.Muted, bg).Render(truncate("amux v"+version+" · "+fmt.Sprintf("%d agents on %s mode", len(m.order), m.mode), w)),
		"",
		m.avatarRow(w),
		"",
		txt(theme.Fg, bg).Render(truncate("Describe your project below to begin, or type / for commands.", w)),
		txt(theme.Muted, bg).Render(truncate("/settings for status · usage · stats · config", w)),
	}
	return exactly(lines, h)
}

// avatarRow draws the team as its avatars wired together with ⇄ — the "visual representation of
// data transfer" from the notes, standing in for the roster before any traffic has flowed.
func (m Model) avatarRow(w int) string {
	bg := theme.BgDeep
	var parts []string
	for _, id := range m.order {
		st := m.agents[id]
		parts = append(parts, txt(st.color, bg).Bold(true).Render(st.avatar))
	}
	if len(parts) == 0 {
		return ""
	}
	return truncate(strings.Join(parts, txt(theme.Muted, bg).Render(" ⇄ ")), w)
}

// --- shared bits ---

// kv is one "Label      value" row, matching the settings screenshots: accent label, value popped
// in amber so numbers catch the eye.
func kv(w int, label, val string) string {
	bg := theme.BgDeep
	l := txt(theme.Accent, bg).Render(pad(label, 16))
	return truncate(l+txt(theme.Amber, bg).Render(val), w)
}

func kvHint(w int, label, val, hint string) string {
	bg := theme.BgDeep
	return truncate(kv(w, label, val)+txt(theme.Muted, bg).Render("   "+hint), w)
}

func pad(s string, n int) string {
	if len(s) >= n {
		return s
	}
	return s + strings.Repeat(" ", n-len(s))
}

// padTo grows (never shrinks) a line slice to n with blank rows — used to push the footer hint to
// the bottom of the overlay regardless of how much a panel drew.
func padTo(lines []string, n int) []string {
	for len(lines) < n {
		lines = append(lines, "")
	}
	return lines
}

// greeting is the time-of-day welcome: "Morning, Shubh!" and so on. The name is the git author, or
// $USER, so it's personal without any config.
func greeting() string {
	name := userName
	switch h := time.Now().Hour(); {
	case h < 5:
		return "Late night, " + name + "!"
	case h < 12:
		return "Morning, " + name + "!"
	case h < 17:
		return "Afternoon, " + name + "!"
	case h < 22:
		return "Evening, " + name + "!"
	default:
		return "Late night, " + name + "!"
	}
}

// userName is resolved once at startup: the git author's first name, else $USER, else a neutral
// fallback. ponytail: computed at package load, not per-frame — it can't change mid-session.
var userName = detectUser()

func detectUser() string {
	if out, err := exec.Command("git", "config", "user.name").Output(); err == nil {
		if f := strings.Fields(string(out)); len(f) > 0 {
			return f[0]
		}
	}
	if u := os.Getenv("USER"); u != "" {
		return u
	}
	return "there"
}
