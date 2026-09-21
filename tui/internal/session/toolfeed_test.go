package session

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestToolFeedCollapsesRuns(t *testing.T) {
	s := &agentState{}
	s.toolStart("Run npm test")
	if s.running == "" || len(s.log) != 0 {
		t.Fatal("a call in flight must be live, not yet in the log")
	}
	s.toolStart("Run git status")
	s.toolStart("Read src/a.ts")
	s.toolEnd(false)
	want := []string{"✔ Ran 2 shell commands", "✔ Read src/a.ts"}
	if !reflect.DeepEqual(s.log, want) {
		t.Fatalf("got %q, want %q", s.log, want)
	}
	if s.running != "" {
		t.Fatal("still running after toolEnd")
	}
}

func TestToolFeedBreaksOnOtherEvents(t *testing.T) {
	s := &agentState{}
	s.toolStart("Read a")
	s.toolEnd(false) // e.g. a delta arrived
	s.toolStart("Read b")
	s.toolEnd(false)
	if want := []string{"✔ Read a", "✔ Read b"}; !reflect.DeepEqual(s.log, want) {
		t.Fatalf("got %q", s.log)
	}
}

func TestToolFeedKeepsEditsIndividual(t *testing.T) {
	s := &agentState{}
	s.toolStart("Edit x.ts")
	s.toolStart("Edit y.ts")
	s.toolEnd(false)
	if want := []string{"✔ Edited x.ts", "✔ Edited y.ts"}; !reflect.DeepEqual(s.log, want) {
		t.Fatalf("got %q", s.log)
	}
}

func TestTurnDurationIsAppendedOnlyWhenEnabled(t *testing.T) {
	for _, show := range []bool{false, true} {
		st := &agentState{showDur: show}
		st.toolStart("Run npm test")
		st.runStart = time.Now().Add(-2300 * time.Millisecond)
		st.toolEnd(false)
		got := st.log[len(st.log)-1]
		if has := strings.HasSuffix(got, "(2.3s)"); has != show {
			t.Fatalf("show=%v: %q", show, got)
		}
	}
	// A collapsed run reports the total for the whole run.
	st := &agentState{showDur: true}
	for i := 0; i < 2; i++ {
		st.toolStart("Run ls")
		st.runStart = time.Now().Add(-1 * time.Second)
	}
	st.toolEnd(false)
	if got := st.log[len(st.log)-1]; !strings.Contains(got, "2 shell commands") || !strings.HasSuffix(got, "s)") {
		t.Fatalf("collapsed line = %q", got)
	}
	for d, want := range map[time.Duration]string{400 * time.Millisecond: "0.4s", 12 * time.Second: "12s", 65 * time.Second: "1m05s"} {
		if got := fmtDur(d); got != want {
			t.Errorf("fmtDur(%v) = %q, want %q", d, got, want)
		}
	}
}
