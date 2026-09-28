package session

import (
	"encoding/json"
	"regexp"
	"strings"
)

// The server publishes tool telemetry as machine text — `read_file {"path":"a.html"}` for a call,
// `read_file → <!DOCTYPE…` for its result. Rendered raw that is the whole transcript: a wall of
// JSON and file dumps. humanize turns each event into one sentence-like line ("Read a.html") and
// drops results that carry no news, so the pane reads as a progress log. Line kinds are marked by
// a leading glyph (see lineStyle): ⏺ action, ⎿ outcome, ✖ failure, ▸ task, · note.

var (
	reStr = func(key string) *regexp.Regexp {
		return regexp.MustCompile(`"` + key + `"\s*:\s*"((?:[^"\\]|\\.)*)`) // tolerates a payload cut off mid-string
	}
	rePath = reStr("(?:path|file_path|filePath)")
	reCmd  = reStr("command")
	reQ    = reStr("(?:query|pattern|symbol)")
	reKey  = reStr("key")
	reTask = regexp.MustCompile(`^(starting|queued) (\S+?)(?: → (\S+))?: (.*)$`)
)

var toolVerbs = map[string]string{
	"read_file": "Read", "write_file": "Write", "edit": "Edit", "list_dir": "List", "list_files": "List",
	"glob": "Find", "grep": "Search", "search": "Search", "shell": "Run", "bash": "Run",
	"remember": "Remember", "recall": "Recall", "todo": "Plan", "hover": "Inspect", "diagnostics": "Check",
}

// humanize returns the transcript line for an event, or "" to drop it.
func humanize(kind, payload string) string {
	payload = strings.TrimSpace(strings.ReplaceAll(payload, "\n", " "))
	switch kind {
	case "tool_call", "file_edit":
		name, rest, _ := strings.Cut(payload, " ")
		if strings.HasPrefix(rest, "{") { // a call, with its arguments
			return "⏺ " + describeCall(name, rest)
		}
		if kind == "file_edit" { // a write that landed: "wrote styles.css"
			return "  ⎿ " + strings.TrimPrefix(rest, "→ ")
		}
		return "" // a read's result is a file dump — the ⏺ line already said what was read
	case "error":
		return "✖ " + strings.TrimPrefix(strings.Replace(payload, ": error: Error:", ":", 1), "error: ")
	case "warning":
		return "⚠ " + payload
	case "thought":
		if strings.HasPrefix(payload, "received ") {
			return ""
		}
		// The verification pass is the one thing in a transcript a user actively waits on, so it
		// reads as a step of the work rather than as one more stray thought.
		if strings.HasPrefix(payload, "verifying:") || strings.HasPrefix(payload, "verification ") {
			return "▸ " + payload
		}
		// The agent's own checklist. It reads as a step of the work, not a stray thought — it is
		// the one line that says what is left.
		if strings.HasPrefix(payload, "plan:") {
			return "▸ " + payload
		}
		if m := reTask.FindStringSubmatch(payload); m != nil {
			if m[1] == "queued" {
				return "▸ " + m[2] + " → " + m[3] + ": " + m[4]
			}
			return "▸ " + m[2] + ": " + m[4]
		}
		return "· " + payload
	}
	return "  " + payload
}

func describeCall(name, args string) string {
	verb, ok := toolVerbs[name]
	if !ok {
		verb = strings.ReplaceAll(name, "_", " ")
		verb = strings.ToUpper(verb[:1]) + verb[1:]
	}
	// A command reads as the whole line — "Run npm test", not "Run npm". The payload is cut at 180
	// characters, so an unparseable (truncated) one falls through to the regexes below.
	if verb == "Run" {
		var in struct {
			Command string   `json:"command"`
			Args    []string `json:"args"`
		}
		if json.Unmarshal([]byte(args), &in) == nil && in.Command != "" {
			return verb + " " + truncate(strings.TrimSpace(in.Command+" "+strings.Join(in.Args, " ")), 70)
		}
	}
	for _, re := range []*regexp.Regexp{rePath, reCmd, reQ, reKey} {
		if m := re.FindStringSubmatch(args); m != nil {
			return verb + " " + m[1]
		}
	}
	return verb
}

// cleanMarkdown turns an agent's markdown into a styled transcript line: headings and **bold**
// become bold, `code` takes the accent (via live.go's inline markers), list bullets become •.
func cleanMarkdown(s string) string {
	t := strings.TrimLeft(s, " ")
	indent := s[:len(s)-len(t)]
	heading := false
	switch {
	case strings.HasPrefix(t, "#"):
		t = strings.TrimLeft(t, "# ")
		heading = true
	case strings.HasPrefix(t, "- "), strings.HasPrefix(t, "* "):
		t = "• " + t[2:]
	}
	t = reBold.ReplaceAllString(t, string(mkBold)+"$1"+string(mkBoldEnd))
	t = reCode.ReplaceAllString(t, string(mkCode)+"$1"+string(mkCodeEnd))
	t = strings.ReplaceAll(t, "**", "") // an unpaired marker is noise
	if heading {
		t = string(mkBold) + t + string(mkBoldEnd)
	}
	return indent + t
}

var (
	reBold = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	reCode = regexp.MustCompile("`([^`]+)`")
)
