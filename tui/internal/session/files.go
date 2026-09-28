package session

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/niti/tui/internal/api"
	"github.com/niti/tui/internal/theme"
	"github.com/niti/tui/internal/ui"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// The Files panel: the project's tree under the Agents panel, marked with what the agents are doing
// to it — M edited, A created, · read — so it doubles as a live map of the work. Enter opens a file
// read-only in the main panel (e hands it to $EDITOR); it is a viewer, not an editor.

const regionFiles = "files"

type filesMsg struct {
	files []string
	err   error
}

func fetchFiles(client *api.Client) tea.Cmd {
	if client == nil {
		return nil
	}
	return func() tea.Msg {
		f, err := client.Files()
		return filesMsg{files: f, err: err}
	}
}

// --- the tree ---

type treeRow struct {
	path  string // project-relative; a directory's path has no trailing slash
	name  string
	depth int
	dir   bool
}

type tnode struct {
	name, path string
	dir        bool
	kids       map[string]*tnode
}

// treeRows is the visible tree: directories first, each level sorted, closed directories' contents
// left out. changedOnly keeps just the files the agents touched (and the folders that hold them).
func (m Model) treeRows() []treeRow {
	root := &tnode{dir: true, kids: map[string]*tnode{}}
	for _, f := range m.files {
		if m.changedOnly && m.touched[f] == 0 {
			continue
		}
		cur := root
		parts := strings.Split(f, "/")
		for i, p := range parts {
			k, ok := cur.kids[p]
			if !ok {
				k = &tnode{name: p, path: strings.Join(parts[:i+1], "/"), dir: i < len(parts)-1, kids: map[string]*tnode{}}
				cur.kids[p] = k
			}
			cur = k
		}
	}
	var rows []treeRow
	var walk func(n *tnode, depth int)
	walk = func(n *tnode, depth int) {
		kids := make([]*tnode, 0, len(n.kids))
		for _, k := range n.kids {
			kids = append(kids, k)
		}
		sort.Slice(kids, func(i, j int) bool {
			if kids[i].dir != kids[j].dir {
				return kids[i].dir
			}
			return kids[i].name < kids[j].name
		})
		for _, k := range kids {
			rows = append(rows, treeRow{path: k.path, name: k.name, depth: depth, dir: k.dir})
			if k.dir && m.dirOpen(k.path) {
				walk(k, depth+1)
			}
		}
	}
	walk(root, 0)
	return rows
}

// dirOpen: what the user toggled wins; otherwise a folder is open when it holds something the
// agents touched, or when the whole project is small enough to show at once.
func (m Model) dirOpen(path string) bool {
	if v, ok := m.openDirs[path]; ok {
		return v
	}
	if len(m.files) <= 40 || m.changedOnly {
		return true
	}
	prefix := path + "/"
	for f := range m.touched {
		if strings.HasPrefix(f, prefix) {
			return true
		}
	}
	return false
}

// markTouched records what an agent did to a file: an edit or create outranks a read.
func (m *Model) markTouched(path string, kind byte) {
	if path == "" {
		return
	}
	if m.touched == nil {
		m.touched = map[string]byte{}
	}
	if prev := m.touched[path]; prev == 'M' || prev == 'A' {
		if kind == 'R' {
			return
		}
		if prev == 'A' {
			kind = 'A' // created this session, then edited: still new
		}
	}
	m.touched[path] = kind
	if i := sort.SearchStrings(m.files, path); i >= len(m.files) || m.files[i] != path {
		m.files = append(m.files, "")
		copy(m.files[i+1:], m.files[i:])
		m.files[i] = path
	}
}

// noteChangedLines keeps which lines of a file this session added or changed, for the viewer's gutter.
func (m *Model) noteChangedLines(ae api.AgentEvent) {
	if m.changed == nil {
		m.changed = map[string]map[int]bool{}
	}
	lines := m.changed[ae.Path]
	if lines == nil {
		lines = map[int]bool{}
		m.changed[ae.Path] = lines
	}
	for _, h := range ae.Hunks {
		for _, l := range h.Lines {
			if l.K == "+" {
				lines[l.N] = true
			}
		}
	}
}

// filesPanel renders the tree inside a titled panel at w×h.
func (m Model) filesPanel(w, h int) string {
	bg := theme.BgDeep
	iw := w - 4
	rows := m.treeRows()
	focused := m.context() == regionFiles
	cursor := clamp(m.fileCursor, 0, max(len(rows)-1, 0))
	visible := max(h-2, 1)
	top := clamp(cursor-visible/2, 0, max(len(rows)-visible, 0))
	var lines []string
	for i := top; i < len(rows) && i < top+visible; i++ {
		r := rows[i]
		rowBg := bg
		if focused && i == cursor {
			rowBg = theme.Tint(theme.Accent)
		}
		indent := strings.Repeat("  ", r.depth)
		var name string
		if r.dir {
			arrow := "▸ "
			if m.dirOpen(r.path) {
				arrow = "▾ "
			}
			name = txt(theme.Muted, rowBg).Render(indent+arrow) + txt(theme.Fg, rowBg).Bold(true).Render(r.name)
		} else {
			name = txt(theme.Fg, rowBg).Render(indent + "  " + r.name)
		}
		mark := ""
		switch m.touched[r.path] {
		case 'M':
			mark = txt(theme.Amber, rowBg).Bold(true).Render("M")
		case 'A':
			mark = txt(theme.Green, rowBg).Bold(true).Render("A")
		case 'R':
			mark = txt(theme.Muted, rowBg).Render("·")
		}
		name = truncate(name, max(iw-2, 1))
		gap := max(iw-lipgloss.Width(name)-lipgloss.Width(mark), 1)
		lines = append(lines, name+txt(theme.Fg, rowBg).Render(strings.Repeat(" ", gap))+mark)
	}
	body := strings.Join(lines, "\n")
	if len(rows) == 0 {
		msg := "no files"
		if m.changedOnly {
			msg = "nothing changed yet"
		}
		body = ui.Hatch(msg, iw, max(h-2, 1), bg)
	}
	// Short: the sidebar is ~20 columns inside. `c` toggles the filter (the footer spells it out).
	sub := fmt.Sprintf("%d files", len(m.files))
	if n := len(m.touched); n > 0 {
		sub = fmt.Sprintf("%d touched · c", n)
		if m.changedOnly {
			sub = "only touched · c"
		}
	}
	return ui.Panel{Title: "Files", Subtitle: sub, Focused: focused}.Render(body, w, h)
}

// fileAtCursor is the tree row the cursor is on.
func (m Model) fileAtCursor() (treeRow, bool) {
	rows := m.treeRows()
	if len(rows) == 0 {
		return treeRow{}, false
	}
	return rows[clamp(m.fileCursor, 0, len(rows)-1)], true
}

// openAtCursor opens a folder, or a file in the viewer.
func (m *Model) openAtCursor() tea.Cmd {
	r, ok := m.fileAtCursor()
	if !ok {
		return nil
	}
	if r.dir {
		if m.openDirs == nil {
			m.openDirs = map[string]bool{}
		}
		m.openDirs[r.path] = !m.dirOpen(r.path)
		return nil
	}
	return m.openFile(r.path)
}

// closeAtCursor collapses the folder the cursor is in (or on).
func (m *Model) closeAtCursor() tea.Cmd {
	r, ok := m.fileAtCursor()
	if !ok {
		return nil
	}
	dir := r.path
	if !r.dir || !m.dirOpen(r.path) {
		dir = filepath.ToSlash(filepath.Dir(r.path))
	}
	if dir == "." || dir == "" {
		return nil
	}
	if m.openDirs == nil {
		m.openDirs = map[string]bool{}
	}
	m.openDirs[dir] = false
	for i, row := range m.treeRows() {
		if row.path == dir {
			m.fileCursor = i
		}
	}
	return nil
}

// --- the viewer ---

type fileView struct {
	path  string
	lines []string
	top   int
	err   string
}

type fileLoadedMsg struct {
	path    string
	content string
	err     error
}

func (m *Model) openFile(path string) tea.Cmd {
	m.viewer = &fileView{path: path}
	m.region = regionTranscript
	client := m.client
	if client == nil {
		return nil
	}
	return func() tea.Msg {
		c, err := client.File(path)
		return fileLoadedMsg{path: path, content: c, err: err}
	}
}

func (m *Model) onFileLoaded(msg fileLoadedMsg) {
	if m.viewer == nil || m.viewer.path != msg.path {
		return
	}
	if msg.err != nil {
		m.viewer.err = msg.err.Error()
		return
	}
	m.viewer.lines = strings.Split(strings.TrimSuffix(msg.content, "\n"), "\n")
	// Open on the first changed line, when there is one — that's why most files get opened.
	first := 0
	for n := range m.changed[msg.path] {
		if first == 0 || n < first {
			first = n
		}
	}
	if first > 0 {
		m.viewer.top = max(first-4, 0)
	}
}

func (m *Model) scrollViewer(delta int) {
	if v := m.viewer; v != nil {
		v.top = clamp(v.top+delta, 0, max(len(v.lines)-1, 0))
	}
}

// viewerBody renders the file: line numbers, a green bar beside lines this session changed.
func (m Model) viewerBody(w, h int) string {
	v := m.viewer
	bg := theme.BgDeep
	if v.err != "" {
		return ui.Hatch(v.err, w, h, bg)
	}
	if v.lines == nil {
		return txt(theme.Muted, bg).Render("loading " + v.path + "…")
	}
	changed := m.changed[v.path]
	numW := len(fmt.Sprint(len(v.lines)))
	var out []string
	for i := v.top; i < len(v.lines) && len(out) < h; i++ {
		bar := txt(theme.Line, bg).Render(" ")
		if changed[i+1] {
			bar = txt(theme.Green, bg).Render("▎")
		}
		num := txt(theme.Line, bg).Render(fmt.Sprintf("%*d ", numW, i+1))
		text := strings.ReplaceAll(v.lines[i], "\t", "    ")
		out = append(out, bar+num+txt(theme.Fg, bg).Render(truncate(text, max(w-numW-2, 1))))
	}
	return strings.Join(out, "\n")
}

type editorDoneMsg struct {
	path string
	err  error
}

// editFile suspends the TUI and opens the file in $VISUAL / $EDITOR; on return the viewer reloads.
func (m *Model) editFile(path string) tea.Cmd {
	editor := os.Getenv("VISUAL")
	if editor == "" {
		editor = os.Getenv("EDITOR")
	}
	if editor == "" {
		editor = "vi"
		if runtime.GOOS == "windows" {
			editor = "notepad"
		}
	}
	parts := strings.Fields(editor)
	c := exec.Command(parts[0], append(parts[1:], filepath.Join(m.root, filepath.FromSlash(path)))...)
	return tea.ExecProcess(c, func(err error) tea.Msg { return editorDoneMsg{path: path, err: err} })
}

// --- @-mentions ---

// mentionQuery is the partial path after a trailing "@" in the prompt, if the cursor sits on one.
func mentionQuery(text string) (string, bool) {
	i := strings.LastIndexAny(text, " \t"+newlineMark)
	word := text[i+1:]
	if i >= 0 && strings.HasPrefix(text[i:], newlineMark) {
		word = strings.TrimPrefix(text[i:], newlineMark)
	}
	if !strings.HasPrefix(word, "@") {
		return "", false
	}
	return strings.TrimPrefix(word, "@"), true
}

// completeMention replaces the trailing @partial with the chosen path.
func (m *Model) completeMention(path string) {
	text := m.input.Value()
	q, _ := mentionQuery(text)
	m.input.SetValue(strings.TrimSuffix(text, "@"+q) + "@" + path + " ")
	m.input.CursorEnd()
	m.menuFiles = false
	m.menuOpen = false
}

func (m Model) fileItems() []ui.Item {
	items := make([]ui.Item, 0, len(m.files))
	for _, f := range m.files {
		items = append(items, ui.Item{Label: f, Value: f})
	}
	return items
}
