package session

import (
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
	"remember": "Remember", "recall": "Recall", "hover": "Inspect", "diagnostics": "Check",
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
	for _, re := range []*regexp.Regexp{rePath, reCmd, reQ, reKey} {
		if m := re.FindStringSubmatch(args); m != nil {
			return verb + " " + m[1]
		}
	}
	return verb
}

// cleanMarkdown strips the syntax that is noise in a terminal: heading hashes, bold markers and
// list bullets become plain text with indentation kept.
func cleanMarkdown(s string) string {
	t := strings.TrimLeft(s, " ")
	indent := s[:len(s)-len(t)]
	switch {
	case strings.HasPrefix(t, "#"):
		t = strings.TrimLeft(t, "# ")
	case strings.HasPrefix(t, "- "), strings.HasPrefix(t, "* "):
		t = "• " + t[2:]
	}
	return indent + strings.NewReplacer("**", "", "`", "").Replace(t)
}
