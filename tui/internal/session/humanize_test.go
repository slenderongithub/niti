package session

import (
	"strings"
	"testing"

	"github.com/niti/tui/internal/api"
)

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
	// Styled, not stripped: the text reads "• Bold x", with bold and code spans marked for renderLine.
	got := cleanMarkdown("- **Bold** `x`")
	if plainLine(got) != "• Bold x" || !strings.ContainsRune(got, mkBold) || !strings.ContainsRune(got, mkCode) {
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

func TestHumanizePlan(t *testing.T) {
	if got := humanize("thought", "plan: [x] find it · [~] fix it"); got != "▸ plan: [x] find it · [~] fix it" {
		t.Errorf("plan line = %q", got)
	}
	// The call itself reads as an action, not as raw JSON.
	if got := humanize("tool_call", `todo {"items":[{"text":"a"}]}`); got != "⏺ Plan" {
		t.Errorf("todo call = %q", got)
	}
}

func TestCheckLines(t *testing.T) {
	got := checkLines([]api.AcceptCheck{
		{Name: "index.html: linked files exist", Ok: true, Grade: "must"},
		{Name: "its own fonts", Ok: false, Grade: "quality", Detail: "The page uses Arial — the default look.\nLoad a font pair."},
		{Name: "the server starts", Ok: false, Grade: "must", Detail: "`npm start` exited (code 1)"},
	})
	want := []string{"⚠ niti checked the work — not done yet (1/3 pass)", "  ⚠ The page uses Arial — the default look.", "  ✖ `npm start` exited (code 1)"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %q", got)
	}
	if all := checkLines([]api.AcceptCheck{{Name: "x", Ok: true}}); all[0] != "▸ niti checked the work — all 1 checks pass" {
		t.Fatalf("got %q", all)
	}
}
