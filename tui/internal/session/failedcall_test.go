package session

import (
	"strings"
	"testing"

	"github.com/niti/tui/internal/api"
)

// A tool call that fails must not leave a "✔" line behind it — only the "✖" that reports why.
func TestFailedToolCallShowsNoSuccessLine(t *testing.T) {
	m := model(1)
	ev := func(js string) { m.apply(api.Event{Kind: "agent_event", Event: []byte(js)}) }
	ev(`{"agentId":"a","type":"tool_call","payload":"edit {\"path\":\"a.txt\",\"oldString\":\"x\",\"newString\":\"y\"}","time":1,"phase":"start","tool":"edit"}`)
	ev(`{"agentId":"a","type":"error","payload":"edit: error: oldString not found","time":2,"phase":"end","tool":"edit","ok":false}`)
	log := strings.Join(m.agents["a"].log, "\n")
	if strings.Contains(log, "✔") {
		t.Errorf("a failed call left a success line:\n%s", log)
	}
	if !strings.Contains(log, "✖") {
		t.Errorf("the failure is not shown:\n%s", log)
	}
}
