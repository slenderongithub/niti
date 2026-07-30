package session

import "testing"

func TestTruncate(t *testing.T) {
	cases := []struct {
		name string
		s    string
		n    int
		want string
	}{
		{"under limit returned as-is", "hi", 10, "hi"},
		{"exact limit returned as-is", "hello", 5, "hello"},
		{"over limit truncated with ellipsis", "hello world", 5, "hell…"},
		{"newlines collapsed to spaces first", "a\nb\nc", 10, "a b c"},
		{"n zero never panics, returns empty", "hello", 0, ""},
		{"n negative never panics, returns empty", "hello", -5, ""},
		{"n one returns just the ellipsis", "hello", 1, "…"},
		{"empty string with n<=0", "", 0, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := truncate(c.s, c.n)
			if got != c.want {
				t.Errorf("truncate(%q, %d) = %q, want %q", c.s, c.n, got, c.want)
			}
		})
	}
}

// Regression guard: a narrow terminal must never panic here (the bug this fix closed).
func TestTruncateNeverPanics(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("truncate panicked: %v", r)
		}
	}()
	for n := -5; n < 5; n++ {
		truncate("some non-empty status text", n)
	}
}
