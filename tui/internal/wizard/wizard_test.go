package wizard

import "testing"

func TestValidModelID(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"anthropic/claude-opus-4-8", true},
		{"openai/gpt-4o", true},
		{"/opus", false},      // empty provider
		{"anthropic/", false}, // empty model
		{"noslash", false},    // no separator
		{"", false},           // empty
		{"/", false},          // both sides empty
		{"a/b/c", true},       // model itself may contain '/'; only the first split matters
	}
	for _, c := range cases {
		if got := validModelID(c.in); got != c.want {
			t.Errorf("validModelID(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestAddRoleRejectsInvalidModelID(t *testing.T) {
	m := &Model{usedIDs: map[string]bool{}}
	m.addRole("/opus", "Broken Role", "read_file")
	if len(m.roles) != 0 {
		t.Fatalf("addRole with an invalid model id should be a no-op, got %d roles", len(m.roles))
	}
	m.addRole("anthropic/claude-opus-4-8", "Backend Engineer", "read_file,write_file")
	if len(m.roles) != 1 {
		t.Fatalf("expected 1 role after a valid addRole, got %d", len(m.roles))
	}
	r := m.roles[0]
	if r.Provider != "anthropic" || r.Model != "claude-opus-4-8" || r.ID != "backend-engineer" {
		t.Errorf("unexpected role: %+v", r)
	}
}

func TestSanitizeDedupesIDs(t *testing.T) {
	m := &Model{usedIDs: map[string]bool{}}
	m.addRole("anthropic/x", "Engineer", "")
	m.addRole("openai/y", "Engineer", "") // same role name again
	if m.roles[0].ID == m.roles[1].ID {
		t.Fatalf("expected distinct ids for duplicate role names, got %q twice", m.roles[0].ID)
	}
}
