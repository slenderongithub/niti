package session

// A live end-to-end check of the TUI against a real niti core: it types every slash command and
// the main keys into the real Model, runs the commands the Model returns (HTTP to the core), and
// feeds the core's event stream back in — a small stand-in for the Bubbletea runtime. Skipped
// unless NITI_E2E_URL / NITI_E2E_TOKEN point at a running core (scripts/e2e/tui.sh starts one
// against a scripted fake model; no network, no cost).

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/niti/tui/internal/api"
)

type liveDriver struct {
	t    *testing.T
	m    Model
	msgs chan tea.Msg
	quit bool
}

func (d *liveDriver) exec(cmd tea.Cmd) {
	if cmd == nil {
		return
	}
	go func() {
		if msg := cmd(); msg != nil {
			d.msgs <- msg
		}
	}()
}

func (d *liveDriver) feed(msg tea.Msg) {
	switch msg := msg.(type) {
	case tea.BatchMsg:
		for _, c := range msg {
			d.exec(c)
		}
		return
	case tea.QuitMsg:
		d.quit = true
		return
	}
	next, cmd := d.m.Update(msg)
	d.m = next.(Model)
	d.exec(cmd)
}

// settle processes messages until `until` holds or the timeout passes.
func (d *liveDriver) settle(timeout time.Duration, until func(Model) bool) bool {
	deadline := time.After(timeout)
	for {
		if until != nil && until(d.m) {
			return true
		}
		select {
		case msg := <-d.msgs:
			d.feed(msg)
		case <-deadline:
			return until == nil
		}
	}
}

func (d *liveDriver) typeLine(s string) {
	d.m.input.SetValue("")
	for _, r := range s {
		d.feed(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
	d.feed(tea.KeyMsg{Type: tea.KeyEnter})
}

func (d *liveDriver) key(k tea.KeyType) { d.feed(tea.KeyMsg{Type: k}) }

func (d *liveDriver) closeOverlays() {
	for i := 0; i < 4 && (d.m.out.open || d.m.sett.open || d.m.tp.open || d.m.akp.open || d.m.car.open || d.m.pal.open); i++ {
		d.key(tea.KeyEsc)
		d.settle(200*time.Millisecond, nil)
	}
}

func TestLiveTUI(t *testing.T) {
	url, token := os.Getenv("NITI_E2E_URL"), os.Getenv("NITI_E2E_TOKEN")
	if url == "" {
		t.Skip("set NITI_E2E_URL/NITI_E2E_TOKEN (scripts/e2e/tui.sh) to run against a live core")
	}
	client := api.New(url, token)
	sess, err := client.Session()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := make(chan api.Event, 256)
	go func() { _ = client.StreamEvents(ctx, 0, events) }()

	d := &liveDriver{t: t, m: New(client, sess, events, cancel), msgs: make(chan tea.Msg, 1024)}
	d.feed(tea.WindowSizeMsg{Width: 140, Height: 44})
	d.exec(d.m.Init())
	if !d.settle(5*time.Second, func(m Model) bool { return len(m.commands) > 0 && len(m.files) > 0 }) {
		t.Fatalf("commands/files never loaded: %d commands, %d files", len(d.m.commands), len(d.m.files))
	}
	if !strings.Contains(d.m.View(), "src") {
		t.Errorf("Files panel does not show the project's src folder")
	}

	step := func(name string, line string, ok func(Model) bool) {
		t.Helper()
		d.closeOverlays()
		d.m.status = ""
		d.typeLine(line)
		if !d.settle(5*time.Second, ok) {
			t.Errorf("%s: %q did not work — status %q, out %q %v", name, line, d.m.status, d.m.out.title, d.m.out.lines)
		}
		if name != "unknown command" && (strings.Contains(d.m.status, "unknown command") || strings.Contains(d.m.status, "failed")) {
			t.Errorf("%s: %q → %q", name, line, d.m.status)
		}
	}
	shown := func(sub string) func(Model) bool {
		return func(m Model) bool {
			return strings.Contains(m.status, sub) || strings.Contains(strings.Join(m.out.lines, "\n"), sub)
		}
	}

	// Client-side commands.
	step("help", "/help", func(m Model) bool { return m.out.open && m.out.title == "COMMANDS" })
	step("tasks (empty)", "/tasks", shown("no tasks yet"))
	step("agents", "/agents", func(m Model) bool { return m.out.open && m.out.kind == "agents" })
	for tab, name := range []string{"settings", "status", "config", "usage", "stats"} {
		step(name, "/"+name, func(m Model) bool { return m.sett.open && m.sett.tab == tab })
	}
	step("theme picker", "/theme", func(m Model) bool { return m.tp.open })
	step("theme by name", "/theme dusk", shown("theme: "))
	step("api key popup", "/api", func(m Model) bool { return m.akp.open })
	step("model carousel", "/model", func(m Model) bool { return m.car.open })
	step("transcript", "/transcript backend", func(m Model) bool { return m.status != "" || m.out.open })

	// Server-side commands through the registry.
	step("cost", "/cost", shown("nothing spent yet"))
	step("server status", "/permissions", shown("backend"))
	step("skills", "/skills", shown("skills"))
	step("mcp", "/mcp", shown("MCP"))
	step("lsp", "/lsp", shown("language servers"))
	step("sessions", "/sessions", func(m Model) bool { return m.status != "" || m.out.open })
	step("manual", "/manual", shown("manual mode"))
	step("auto", "/auto", shown("auto-approve on"))
	step("manual again", "/manual", shown("manual mode"))
	step("unknown command", "/definitely-not-a-command", shown("unknown command"))
	d.closeOverlays()

	// A real run: prompt → plan → approvals answered with "y" in the TUI → files written.
	d.typeLine("build a reddit replica page")
	approved := 0
	done := d.settle(60*time.Second, func(m Model) bool {
		if len(m.approvals) > 0 {
			approved++
			d.feed(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'y'}})
		}
		return !m.active && m.card != nil
	})
	if !done {
		t.Fatalf("run never finished: status %q, active %v, approvals %d", d.m.status, d.m.active, len(d.m.approvals))
	}
	if approved == 0 {
		t.Errorf("no approval reached the TUI")
	}
	if d.m.touched["index.html"] == 0 {
		t.Errorf("Files panel did not mark index.html as touched: %v", d.m.touched)
	}
	if !strings.Contains(d.m.View(), "index.html") {
		t.Errorf("index.html not visible after the run")
	}
	step("tasks after run", "/tasks", func(m Model) bool { return m.out.open && m.out.kind == "tasks" })
	step("rewind", "/rewind 1", shown("rewound 1 step"))
	step("clear", "/clear", shown("session cleared"))
	if !d.settle(3*time.Second, func(m Model) bool { return len(m.tasks) == 0 }) {
		t.Errorf("/clear left %d tasks on the TUI board", len(d.m.tasks))
	}

	// Plan mode (shift+tab) plans without running anything.
	d.closeOverlays()
	d.key(tea.KeyShiftTab)
	if d.m.mode != "plan" {
		t.Fatalf("shift+tab did not switch to plan mode: %q", d.m.mode)
	}
	d.typeLine("build a reddit replica page")
	if !d.settle(30*time.Second, func(m Model) bool { return len(m.tasks) == 2 && !m.active }) {
		t.Errorf("plan mode: %d tasks, active %v", len(d.m.tasks), d.m.active)
	}
	for _, task := range d.m.tasks {
		if task.Status != "pending" {
			t.Errorf("plan mode ran task %s (%s)", task.ID, task.Status)
		}
	}
	d.key(tea.KeyShiftTab)

	// Overlays by key.
	for _, k := range []struct {
		name string
		key  tea.KeyType
		open func(Model) bool
	}{
		{"ctrl+p palette", tea.KeyCtrlP, func(m Model) bool { return m.pal.open }},
		{"ctrl+l model picker", tea.KeyCtrlL, func(m Model) bool { return m.car.open }},
		{"ctrl+t theme picker", tea.KeyCtrlT, func(m Model) bool { return m.tp.open }},
	} {
		d.closeOverlays()
		d.key(k.key)
		if !d.settle(2*time.Second, k.open) {
			t.Errorf("%s did not open", k.name)
		}
	}
	d.closeOverlays()

	// tab cycles focus prompt → transcript → agents → files.
	d.m.region = regionPrompt
	var regions []string
	for i := 0; i < 3; i++ {
		d.key(tea.KeyTab)
		regions = append(regions, d.m.region)
	}
	if strings.Join(regions, ",") != regionTranscript+","+regionAgents+","+regionFiles {
		t.Errorf("tab focus order: %v", regions)
	}

	// Files panel: open src/, then view a.ts read-only.
	d.m.fileCursor = 0
	for i, r := range d.m.treeRows() {
		if r.path == "src" {
			d.m.fileCursor = i
		}
	}
	if !d.m.dirOpen("src") {
		d.key(tea.KeyEnter) // open the folder
	}
	for i, r := range d.m.treeRows() {
		if r.path == "src/a.ts" {
			d.m.fileCursor = i
		}
	}
	d.key(tea.KeyEnter) // view the file
	if !d.settle(3*time.Second, func(m Model) bool { return m.viewer != nil }) {
		t.Errorf("enter on src/a.ts did not open the viewer (rows %v)", d.m.treeRows())
	}
	d.m.viewer = nil
	d.m.region = regionPrompt

	// @-mention completes a project file.
	d.m.input.SetValue("")
	for _, r := range "look at @src/a" {
		d.feed(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
	d.key(tea.KeyTab)
	if got := d.m.input.Value(); got != "look at @src/a.ts " {
		t.Errorf("@-mention completion: %q", got)
	}
	d.m.input.SetValue("")

	// !command runs in the project and shows its output.
	d.typeLine("!echo hello-bang && ls src")
	if !d.settle(5*time.Second, func(m Model) bool {
		return m.out.open && strings.Contains(strings.Join(m.out.lines, "\n"), "hello-bang")
	}) {
		t.Errorf("!command output not shown: %v", d.m.out.lines)
	}
	d.closeOverlays()

	// ↑ recalls the last prompt.
	d.m.input.SetValue("")
	d.key(tea.KeyUp)
	if d.m.input.Value() == "" {
		t.Errorf("↑ did not recall a previous prompt")
	}
	d.m.input.SetValue("")

	// Denying an approval with n: nothing is written.
	d.typeLine("/clear")
	d.settle(2*time.Second, func(m Model) bool { return len(m.tasks) == 0 })
	d.closeOverlays()
	d.typeLine("build a reddit replica page")
	denied := 0
	d.settle(60*time.Second, func(m Model) bool {
		if len(m.approvals) > 0 {
			denied++
			d.feed(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'n'}})
		}
		return denied > 0 && !m.active && m.card != nil
	})
	if denied == 0 {
		t.Errorf("no approval to deny")
	}

	// esc interrupts a run.
	d.closeOverlays()
	d.typeLine("SLOW build a reddit replica page")
	if !d.settle(10*time.Second, func(m Model) bool { return m.active }) {
		t.Fatalf("SLOW run never started")
	}
	d.key(tea.KeyEsc)
	if !d.settle(20*time.Second, func(m Model) bool { return !m.active }) {
		t.Errorf("esc did not stop the run: status %q", d.m.status)
	}

	// --- the rest of the keys and overlays, each checked against the core's own state ---
	press := func(k tea.KeyMsg) { d.feed(k); d.settle(150*time.Millisecond, nil) }
	runes := func(s string) {
		for _, r := range s {
			d.feed(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
		}
	}
	core := func() api.SessionInfo { s, _ := client.Session(); return s }

	d.closeOverlays()
	press(tea.KeyMsg{Type: tea.KeyCtrlG})
	if !d.m.ap.open {
		t.Errorf("ctrl+g did not open the agent picker")
	}
	press(tea.KeyMsg{Type: tea.KeyDown}) // the first row is "overview"
	press(tea.KeyMsg{Type: tea.KeyEnter})
	if d.m.focus == "" {
		t.Errorf("agent picker enter did not focus an agent")
	}
	d.m.focus = ""

	press(tea.KeyMsg{Type: tea.KeyCtrlO})
	if !d.m.expanded {
		t.Errorf("ctrl+o did not expand")
	}
	press(tea.KeyMsg{Type: tea.KeyCtrlO})

	press(tea.KeyMsg{Type: tea.KeyF1})
	if !d.m.out.open {
		t.Errorf("f1 did not open help")
	}
	d.closeOverlays()

	press(tea.KeyMsg{Type: tea.KeyCtrlR})
	if !d.m.pal.open || !strings.HasPrefix(d.m.pal.query, "history") {
		t.Errorf("ctrl+r did not open history search: %v %q", d.m.pal.open, d.m.pal.query)
	}
	d.closeOverlays()

	// Config tab: toggling a preference reaches the core.
	before := core().Prefs["reduceMotion"]
	d.typeLine("/config")
	runes("reduce")
	press(tea.KeyMsg{Type: tea.KeyEnter})
	if !d.settle(3*time.Second, func(Model) bool { return core().Prefs["reduceMotion"] != before }) {
		t.Errorf("Config tab toggle did not reach the core (reduceMotion still %v)", before)
	}
	d.closeOverlays()

	// Theme picker: enter applies and persists.
	press(tea.KeyMsg{Type: tea.KeyCtrlT})
	press(tea.KeyMsg{Type: tea.KeyRight})
	press(tea.KeyMsg{Type: tea.KeyEnter})
	picked := strings.TrimPrefix(d.m.status, "theme: ")
	if !d.settle(3*time.Second, func(Model) bool { return core().Theme == picked }) {
		t.Errorf("theme picker: picked %q, core has %q", picked, core().Theme)
	}

	// Model picker: switch frontend's model through ctrl+l.
	d.closeOverlays()
	press(tea.KeyMsg{Type: tea.KeyCtrlL})
	d.settle(2*time.Second, func(m Model) bool { return m.car.open })
	runes("frontend") // the agent stage filters as you type
	press(tea.KeyMsg{Type: tea.KeyEnter})
	runes("custom/fake-two")
	press(tea.KeyMsg{Type: tea.KeyEnter})
	if !d.settle(3*time.Second, func(Model) bool {
		for _, a := range core().Agents {
			if a.ID == "frontend" && a.Model == "fake-two" {
				return true
			}
		}
		return false
	}) {
		t.Errorf("model picker did not switch frontend (status %q, car %q)", d.m.status, d.m.car.status)
	}
	d.closeOverlays()

	// /api: a key typed into the popup is stored by the core.
	d.typeLine("/api")
	d.settle(2*time.Second, func(m Model) bool { _, ok := m.akp.list.Selected(); return m.akp.open && ok })
	sel, _ := d.m.akp.list.Selected()
	press(tea.KeyMsg{Type: tea.KeyEnter})
	runes("sk-e2e-test-key-123456")
	press(tea.KeyMsg{Type: tea.KeyEnter})
	if !d.settle(3*time.Second, func(Model) bool {
		creds, _ := client.Credentials()
		for _, c := range creds {
			if c.Provider == sel.Value {
				return true
			}
		}
		return false
	}) {
		t.Errorf("/api did not store a key for %q (status %q)", sel.Value, d.m.akp.status)
	}
	d.closeOverlays()

	// Approvals: "a" stops asking that agent for that tool; "e" edits what gets written.
	runCall := func(call, key string, edit string) int {
		asked := 0
		d.closeOverlays()
		d.typeLine("do it CALL:" + call + "END")
		d.settle(30*time.Second, func(m Model) bool {
			if len(m.approvals) > 0 && asked == 0 {
				asked++
				if edit != "" {
					d.feed(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'e'}})
					runes(edit)
					d.feed(tea.KeyMsg{Type: tea.KeyCtrlS})
				}
				d.feed(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(key)})
			}
			return !m.active && m.card != nil && m.card.Goal != ""
		})
		d.settle(500*time.Millisecond, nil)
		return asked
	}
	d.typeLine("/clear")
	if n := runCall(`{"name":"write_file","args":{"path":"a.txt","content":"one"}}`, "a", ""); n != 1 {
		t.Errorf("first write should ask once, asked %d", n)
	}
	if n := runCall(`{"name":"write_file","args":{"path":"b.txt","content":"two"}}`, "y", ""); n != 0 {
		t.Errorf("after 'a' (always for this agent) a second write still asked")
	}
	d.typeLine("/manual") // and back to asking for every write
	d.typeLine("/clear")
	// edit, not write_file: the "a" above granted write_file to this agent for the rest of the session
	if n := runCall(`{"name":"edit","args":{"path":"a.txt","oldString":"one","newString":"uno"}}`, "y", "-EDITED"); n != 1 {
		t.Errorf("edit flow: asked %d times", n)
	}
	if body, err := client.File("a.txt"); err != nil || !strings.Contains(body, "uno-EDITED") {
		t.Errorf("an edit made in the approval screen did not land: %q %v\nbackend log: %v", body, err, d.m.agents["backend"].log)
	}
	d.closeOverlays()

	// Typing while a run is going steers the working agent.
	d.typeLine("SLOW build a reddit replica page")
	if d.settle(10*time.Second, func(m Model) bool {
		return m.active && m.agents["backend"] != nil && m.agents["backend"].status != "idle"
	}) {
		d.typeLine("STEER-MARKER use orange")
		if !d.settle(15*time.Second, func(m Model) bool {
			return strings.Contains(strings.Join(m.agents["backend"].log, "\n"), "STEER-MARKER")
		}) {
			t.Errorf("typing mid-run did not reach the working agent (status %q)", d.m.status)
		}
	} else {
		t.Errorf("SLOW run never got going")
	}
	d.settle(30*time.Second, func(m Model) bool {
		if len(m.approvals) > 0 {
			d.feed(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'y'}})
		}
		return !m.active
	})

	// Files panel: c shows only what the agents touched.
	d.closeOverlays()
	d.m.region = regionFiles
	press(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'c'}})
	if !d.m.changedOnly {
		t.Errorf("c did not switch the Files panel to changed-only")
	}
	for _, r := range d.m.treeRows() {
		if r.path == "src/a.ts" {
			t.Errorf("changed-only still lists the untouched src/a.ts")
		}
	}
	press(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'c'}})
	d.m.region = regionPrompt

	// /quit leaves.
	d.closeOverlays()
	d.typeLine("/quit")
	if !d.m.quitting {
		t.Errorf("/quit did not quit")
	}
}
