// Package api is the typed client for the amux core server (the TS↔Go seam). It mirrors the JSON
// contract in src/server/events.ts and src/server/server.ts.
package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// --- wire types (mirror the TS contracts) ---

type AgentConfig struct {
	ID           string   `json:"id"`
	Provider     string   `json:"provider"`
	Model        string   `json:"model"`
	Role         string   `json:"role"`
	Lead         bool     `json:"lead"`
	AllowedTools []string `json:"allowedTools"`
}

type Task struct {
	ID          string   `json:"id"`
	Description string   `json:"description"`
	AssignedTo  string   `json:"assignedTo"`
	Status      string   `json:"status"`
	DependsOn   []string `json:"dependsOn"`
}

type SessionInfo struct {
	Agents  []AgentConfig `json:"agents"`
	Tasks   []Task        `json:"tasks"`
	LastSeq int           `json:"lastSeq"`
	Running bool          `json:"running"`
}

type AgentEvent struct {
	AgentID string `json:"agentId"`
	Type    string `json:"type"`
	Payload string `json:"payload"`
	Time    int64  `json:"time"`
}

type AgentMessage struct {
	ID      string `json:"id"`
	From    string `json:"from"`
	To      string `json:"to"`
	Kind    string `json:"kind"`
	Subject string `json:"subject"`
	Body    string `json:"body"`
	Time    int64  `json:"time"`
}

type PlanTask struct {
	ID          string   `json:"id"`
	Description string   `json:"description"`
	Role        string   `json:"role"`
	DependsOn   []string `json:"dependsOn"`
}

type OrchestrationEvent struct {
	Type      string     `json:"type"`
	Goal      string     `json:"goal"`
	Tasks     []PlanTask `json:"tasks"`
	TaskID    string     `json:"taskId"`
	Role      string     `json:"role"`
	Ok        bool       `json:"ok"`
	Completed int        `json:"completed"`
	Total     int        `json:"total"`
	From      string     `json:"from"`
	To        []string   `json:"to"`
	Summary   string     `json:"summary"`
}

type Usage struct {
	InputTokens  int `json:"inputTokens"`
	OutputTokens int `json:"outputTokens"`
	Calls        int `json:"calls"`
	LastInput    int `json:"lastInput"`
}

type AgentUsage struct {
	AgentID string `json:"agentId"`
	Usage   Usage  `json:"usage"`
}

type Totals struct {
	InputTokens  int `json:"inputTokens"`
	OutputTokens int `json:"outputTokens"`
	Calls        int `json:"calls"`
}

type Approval struct {
	AgentID string         `json:"agentId"`
	Tool    string         `json:"tool"`
	Input   map[string]any `json:"input"`
}

type Lock struct {
	Path   string `json:"path"`
	Holder string `json:"holder"`
}

// Event is one item of the SSE ServerEvent union. `Event` (raw) holds either an AgentEvent
// (kind=agent_event) or an OrchestrationEvent (kind=orchestration); decode with the helpers.
type Event struct {
	Kind     string          `json:"kind"`
	Seq      int             `json:"seq"`
	Time     int64           `json:"time"`
	Event    json.RawMessage `json:"event"`
	Message  *AgentMessage   `json:"message"`
	Agents   []AgentUsage    `json:"agents"`
	Totals   *Totals         `json:"totals"`
	Requests []Approval      `json:"requests"`
	Holders  []Lock          `json:"holders"`
	State    string          `json:"state"`
	Goal     string          `json:"goal"`
}

func (e Event) AsAgentEvent() (AgentEvent, bool) {
	var a AgentEvent
	if e.Kind != "agent_event" || len(e.Event) == 0 {
		return a, false
	}
	return a, json.Unmarshal(e.Event, &a) == nil
}

func (e Event) AsOrchestration() (OrchestrationEvent, bool) {
	var o OrchestrationEvent
	if e.Kind != "orchestration" || len(e.Event) == 0 {
		return o, false
	}
	return o, json.Unmarshal(e.Event, &o) == nil
}

// --- client ---

type Client struct {
	BaseURL string
	Token   string
	http    *http.Client
}

func New(baseURL, token string) *Client {
	return &Client{BaseURL: strings.TrimRight(baseURL, "/"), Token: token, http: &http.Client{Timeout: 30 * time.Second}}
}

func (c *Client) do(method, path string, body any, out any) error {
	var rdr *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(method, c.BaseURL+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		var e struct {
			Error string `json:"error"`
		}
		json.NewDecoder(resp.Body).Decode(&e)
		if e.Error == "" {
			e.Error = resp.Status
		}
		return fmt.Errorf("%s", e.Error)
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

func (c *Client) Session() (SessionInfo, error) {
	var s SessionInfo
	return s, c.do("POST", "/session", nil, &s)
}

func (c *Client) Prompt(text string) error {
	return c.do("POST", "/prompt", map[string]string{"text": text}, nil)
}

func (c *Client) Cancel() error { return c.do("POST", "/cancel", nil, nil) }

func (c *Client) SwitchModel(agentID, provider, model, baseURL string) error {
	return c.do("POST", "/model", map[string]string{"agentId": agentID, "provider": provider, "model": model, "baseURL": baseURL}, nil)
}

func (c *Client) Approve(ok bool, scope string) error {
	return c.do("POST", "/approval", map[string]any{"ok": ok, "scope": scope}, nil)
}

type ProvidersResp struct {
	Providers map[string][]struct {
		ID    string `json:"id"`
		Label string `json:"label"`
	} `json:"providers"`
}

func (c *Client) Providers() (ProvidersResp, error) {
	var p ProvidersResp
	return p, c.do("GET", "/providers", nil, &p)
}

func (c *Client) Models(provider string) ([]string, error) {
	var r struct {
		Models []string `json:"models"`
	}
	err := c.do("GET", "/models?provider="+url.QueryEscape(provider), nil, &r)
	return r.Models, err
}

// SaveAuth stores a credential (api/oauth/local). See src/server/server.ts POST /auth.
func (c *Client) SaveAuth(cred map[string]string) error {
	return c.do("POST", "/auth", cred, nil)
}

// SaveAgents persists role assignments to .amux/agents.yaml (POST /agents).
func (c *Client) SaveAgents(agents []AgentConfig) error {
	return c.do("POST", "/agents", map[string]any{"agents": agents}, nil)
}

// ErrStreamDisconnected is returned when the SSE connection ends for a reason OTHER than the
// caller's context being cancelled (server restart, network drop, oversized line) — signaling that
// a caller managing its own reconnect loop should retry, as opposed to a deliberate shutdown.
var ErrStreamDisconnected = errors.New("event stream disconnected")

// StreamEvents reads the SSE event stream, decoding each frame and sending it on `out` until the
// context is cancelled or the connection drops. Does NOT close `out` — the caller owns the
// channel's lifecycle (a caller retrying StreamEvents across reconnects must not have it closed
// out from under it). Returns ctx.Err() on a deliberate cancel, or ErrStreamDisconnected (wrapping
// the underlying cause where there is one) on any other end, so callers can tell "asked to stop"
// apart from "should reconnect."
func (c *Client) StreamEvents(ctx context.Context, fromSeq int, out chan<- Event) error {
	req, err := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("%s/events?from=%d", c.BaseURL, fromSeq), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	// no client timeout for the long-lived stream
	streamer := &http.Client{}
	resp, err := streamer.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrStreamDisconnected, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("%w: unexpected status %s", ErrStreamDisconnected, resp.Status)
	}

	scanner := bufio.NewScanner(resp.Body)
	// ponytail: bounded at 32MB rather than unbounded — a single event (e.g. a large generated
	// file's content in a "message" payload) exceeding this aborts the stream with
	// ErrStreamDisconnected rather than growing memory without limit. Raise this, or switch to a
	// streaming JSON decoder that doesn't buffer whole lines, if that ceiling is ever hit in practice.
	scanner.Buffer(make([]byte, 0, 64*1024), 32*1024*1024)
	var data strings.Builder
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "data:"):
			data.WriteString(strings.TrimPrefix(line, "data:"))
		case line == "":
			if data.Len() > 0 {
				var e Event
				if json.Unmarshal([]byte(strings.TrimSpace(data.String())), &e) == nil {
					select {
					case out <- e:
					case <-ctx.Done():
						return ctx.Err()
					}
				}
				data.Reset()
			}
		}
	}
	if ctx.Err() != nil {
		return ctx.Err() // caller asked us to stop — not a disconnect
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("%w: %v", ErrStreamDisconnected, err)
	}
	return ErrStreamDisconnected // the server closed the connection cleanly, but we didn't ask it to
}
