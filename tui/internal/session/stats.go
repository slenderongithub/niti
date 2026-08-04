package session

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/niti/tui/internal/api"
	"github.com/niti/tui/internal/theme"
	"github.com/charmbracelet/lipgloss"
)

// Rendering for the Stats overlay's history-backed panels: the GitHub-style contribution heatmap,
// the tokens-per-day chart, and the streak/active-day math behind them. All pure over the /stats
// payload (api.Stats.PerDay), so the layout is testable without a running server.

const dayFmt = "2006-01-02" // the date format the server emits (strftime %Y-%m-%d)

func parseDay(s string) (time.Time, bool) {
	t, err := time.ParseInLocation(dayFmt, s, time.Local)
	return t, err == nil
}

// tokensByDate folds PerDay into a date→tokens lookup, ignoring rows that don't parse.
func tokensByDate(days []api.StatsDay) map[string]int {
	m := make(map[string]int, len(days))
	for _, d := range days {
		m[d.Date] += d.Tokens
	}
	return m
}

// heatmap draws a year of activity: one column per week (most recent on the right), one row per
// weekday, each cell shaded by that day's token total. Mon/Wed/Fri are labelled like GitHub's.
func heatmap(days []api.StatsDay, w int) []string {
	bg := theme.BgDeep
	tok := tokensByDate(days)
	peak := 1
	for _, v := range tok {
		if v > peak {
			peak = v
		}
	}
	const labelW = 4 // "Mon " gutter
	weeks := clamp(w-labelW-1, 8, 53)
	today := time.Now()
	// The Sunday that starts this week, then wind back so the rightmost column is the current week.
	sundayThis := today.AddDate(0, 0, -int(today.Weekday()))
	start := sundayThis.AddDate(0, 0, -(weeks-1)*7)

	shades := []string{"·", "░", "▒", "▓", "█"}
	level := func(t int) int {
		switch {
		case t <= 0:
			return 0
		case t >= peak*3/4:
			return 4
		case t >= peak/2:
			return 3
		case t >= peak/4:
			return 2
		default:
			return 1
		}
	}

	// Month header, aligned to the columns below it.
	header := []rune(strings.Repeat(" ", weeks))
	prev, lastCol := "", -3
	for c := 0; c < weeks; c++ {
		mon := start.AddDate(0, 0, c*7).Format("Jan")
		// Place the label only when the month changed and the previous one is ≥3 columns back, so a
		// month with just a week or two at the edge doesn't collide into "JAug".
		if mon != prev && c >= lastCol+3 {
			for i, r := range mon {
				if c+i < weeks {
					header[c+i] = r
				}
			}
			lastCol = c
		}
		prev = mon
	}
	lines := []string{strings.Repeat(" ", labelW) + txt(theme.Muted, bg).Render(string(header))}

	for r := 0; r < 7; r++ {
		label := "   "
		switch r {
		case 1:
			label = "Mon"
		case 3:
			label = "Wed"
		case 5:
			label = "Fri"
		}
		var b strings.Builder
		b.WriteString(txt(theme.Muted, bg).Render(label + " "))
		for c := 0; c < weeks; c++ {
			day := start.AddDate(0, 0, c*7+r)
			if day.After(today) {
				b.WriteString(txt(theme.Line, bg).Render(" "))
				continue
			}
			lv := level(tok[day.Format(dayFmt)])
			col := theme.Accent
			if lv == 0 {
				col = theme.Line
			}
			b.WriteString(txt(col, bg).Render(shades[lv]))
		}
		lines = append(lines, b.String())
	}
	legend := txt(theme.Muted, bg).Render("Less ") +
		txt(theme.Line, bg).Render("·") + txt(theme.Accent, bg).Render("░▒▓█") +
		txt(theme.Muted, bg).Render(" More")
	return append(lines, "", strings.Repeat(" ", labelW)+legend)
}

// dayChart is a compact vertical bar chart of tokens per day over the most recent recorded days.
func dayChart(days []api.StatsDay, w, height int) []string {
	bg := theme.BgDeep
	if len(days) == 0 {
		return []string{txt(theme.Muted, bg).Render("  no activity yet")}
	}
	cols := clamp(w-8, 10, 60)
	if len(days) > cols {
		days = days[len(days)-cols:]
	}
	peak := 1
	for _, d := range days {
		if d.Tokens > peak {
			peak = d.Tokens
		}
	}
	// filled[c] = how many of the `height` cells this column lights up (0..height).
	filled := make([]int, len(days))
	for i, d := range days {
		filled[i] = d.Tokens * height / peak
		if d.Tokens > 0 && filled[i] == 0 {
			filled[i] = 1 // a day with any activity shows at least one cell
		}
	}
	var lines []string
	for row := 0; row < height; row++ {
		lvl := height - row // top row is the tallest
		gutter := "      "
		if row == 0 {
			gutter = padLeft(fmtTok(peak), 6)
		}
		var b strings.Builder
		b.WriteString(txt(theme.Muted, bg).Render(gutter + "│"))
		for _, f := range filled {
			if f >= lvl {
				b.WriteString(txt(theme.Accent, bg).Render("█"))
			} else {
				b.WriteString(txt(bg, bg).Render(" "))
			}
		}
		lines = append(lines, b.String())
	}
	axis := txt(theme.Muted, bg).Render("     0└" + strings.Repeat("─", len(days)))
	first, _ := parseDay(days[0].Date)
	last, _ := parseDay(days[len(days)-1].Date)
	span := first.Format("Jan 2")
	if len(days) > 1 {
		fs, ls := first.Format("Jan 2"), last.Format("Jan 2")
		gap := len(days) - len(fs) - len(ls) // date labels are ASCII, so byte len == cell width
		span = fs + strings.Repeat(" ", max(gap, 1)) + ls
	}
	return append(lines, axis, txt(theme.Muted, bg).Render("       "+span))
}

// streaks returns the longest run of consecutive active days ever, and the current run ending today
// (or yesterday, so a streak isn't declared broken until a whole day has been missed).
func streaks(days []api.StatsDay) (longest, current int) {
	return streaksAt(activeSet(days), time.Now())
}

func activeSet(days []api.StatsDay) map[string]bool {
	set := map[string]bool{}
	for _, d := range days {
		if d.Tokens > 0 {
			set[d.Date] = true
		}
	}
	return set
}

func streaksAt(set map[string]bool, today time.Time) (longest, current int) {
	dates := make([]time.Time, 0, len(set))
	for d := range set {
		if t, ok := parseDay(d); ok {
			dates = append(dates, t)
		}
	}
	sort.Slice(dates, func(i, j int) bool { return dates[i].Before(dates[j]) })
	run := 0
	for i, d := range dates {
		if i > 0 && d.Sub(dates[i-1]) == 24*time.Hour {
			run++
		} else {
			run = 1
		}
		if run > longest {
			longest = run
		}
	}
	// Current: walk backwards from today (allowing it to end yesterday).
	day := today
	if !set[day.Format(dayFmt)] {
		day = day.AddDate(0, 0, -1)
	}
	for set[day.Format(dayFmt)] {
		current++
		day = day.AddDate(0, 0, -1)
	}
	return longest, current
}

// activeSpan is (days with activity, calendar days from the first active day to today).
func activeSpan(days []api.StatsDay) (active, span int) {
	return activeSpanAt(days, time.Now())
}

func activeSpanAt(days []api.StatsDay, today time.Time) (active, span int) {
	var first time.Time
	for _, d := range days {
		if d.Tokens <= 0 {
			continue
		}
		active++
		if t, ok := parseDay(d.Date); ok && (first.IsZero() || t.Before(first)) {
			first = t
		}
	}
	if first.IsZero() {
		return active, 0
	}
	return active, int(today.Sub(first).Hours()/24) + 1
}

// mostActiveDay is the calendar day with the most tokens, formatted "Jan 2".
func mostActiveDay(days []api.StatsDay) string {
	best, bestDate := -1, ""
	for _, d := range days {
		if d.Tokens > best {
			best, bestDate = d.Tokens, d.Date
		}
	}
	if t, ok := parseDay(bestDate); ok {
		return t.Format("Jan 2")
	}
	return "—"
}

// --- small formatters ---

// shortModel keeps just the model half of a "provider/model" id — the part worth reading at a glance.
func shortModel(name string) string {
	if i := strings.LastIndexByte(name, '/'); i >= 0 && i+1 < len(name) {
		return name[i+1:]
	}
	return name
}

// fmtTokLong is fmtTok with the lowercase k/m the stats screenshots use (20.2m, 347.5k).
func fmtTokLong(n int) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fm", float64(n)/1e6)
	case n >= 1_000:
		return fmt.Sprintf("%.1fk", float64(n)/1e3)
	default:
		return fmt.Sprintf("%d", n)
	}
}

// dur renders a millisecond span as "1d 4h 42m" — the longest-session readout.
func dur(ms int64) string {
	s := ms / 1000
	d, h, m := s/86400, (s%86400)/3600, (s%3600)/60
	var p []string
	if d > 0 {
		p = append(p, fmt.Sprintf("%dd", d))
	}
	if h > 0 {
		p = append(p, fmt.Sprintf("%dh", h))
	}
	p = append(p, fmt.Sprintf("%dm", m))
	return strings.Join(p, " ")
}

// bookQuip is the screenshot's flourish: your token count against a famous long novel.
func bookQuip(total int) string {
	const mobyDick = 416_000 // ~320k words · ~1.3 tokens/word
	if total < mobyDick {
		return ""
	}
	return fmt.Sprintf("You've used ~%dx more tokens than Moby-Dick", total/mobyDick)
}

// kvc is a compact inline "Label  value" cell for the two-column overview grid.
func kvc(label, val string) string {
	bg := theme.BgDeep
	return txt(theme.Accent, bg).Render(label+"  ") + txt(theme.Amber, bg).Render(val)
}

// padVis pads a styled string to n visible cells (ANSI-aware), for column alignment.
func padVis(s string, n int) string {
	if fill := n - lipgloss.Width(s); fill > 0 {
		return s + txt(theme.BgDeep, theme.BgDeep).Render(strings.Repeat(" ", fill))
	}
	return s
}

func padLeft(s string, n int) string {
	if len(s) >= n {
		return s
	}
	return strings.Repeat(" ", n-len(s)) + s
}
