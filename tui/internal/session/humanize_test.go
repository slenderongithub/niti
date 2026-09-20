package session

import "testing"

func TestHumanize(t *testing.T) {
	for _, c := range []struct{ kind, in, want string }{
		{"tool_call", `read_file {"path":"index.html"}`, "⏺ Read index.html"},
		{"tool_call", `read_file → <!DOCTYPE html>`, ""},
		{"tool_call", `write_file {"path":"styles.css","content":"/* ====`, "⏺ Write styles.css"},
		{"file_edit", `write_file → wrote styles.css`, "  ⎿ wrote styles.css"},
		{"tool_call", `shell {"command":"npm test"}`, "⏺ Run npm test"},
		{"thought", "received 1 message(s)", ""},
		{"thought", "queued t1 → builder: Create HTML", "▸ t1 → builder: Create HTML"},
		{"thought", "starting t2: Design styles", "▸ t2: Design styles"},
		{"error", "edit: error: Error: edit index.html: oldString not found", "✖ edit: edit index.html: oldString not found"},
	} {
		if got := humanize(c.kind, c.in); got != c.want {
			t.Errorf("humanize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	if got := cleanMarkdown("- **Bold** `x`"); got != "• Bold x" {
		t.Errorf("cleanMarkdown = %q", got)
	}
}

func TestHumanizeVerification(t *testing.T) {
	for _, c := range []struct{ kind, in, want string }{
		{"thought", "verifying: bun run typecheck", "▸ verifying: bun run typecheck"},
		{"thought", "verification passed", "▸ verification passed"},
		{"warning", "verification failed — returning the errors to the agent", "⚠ verification failed — returning the errors to the agent"},
	} {
		if got := humanize(c.kind, c.in); got != c.want {
			t.Errorf("humanize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
