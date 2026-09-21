package session

import (
	"reflect"
	"testing"
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
