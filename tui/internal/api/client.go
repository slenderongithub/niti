// Package api is the typed client for the niti core server (the TS↔Go seam). It mirrors the JSON
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
	SystemPrompt string   `json:"systemPrompt"`
	AllowedTools []string `json:"allowedTools"`
}

type Task struct {
	ID          string   `json:"id"`
	Description string   `json:"description"`
	AssignedTo  string   `json:"assignedTo"`
	Status      string   `json:"status"`
	DependsOn   []string `json:"dependsOn"`
}

// LspInfo / McpInfo describe what the project is wired to — listed in the sidebar so it's obvious
// at a glance whether a language server is merely configured or actually running.
type LspInfo struct {
	Name       string   `json:"name"`
	Command    string   `json:"command"`
	Extensions []string `json:"extensions"`
	Running    bool     `json:"running"`
}

type McpInfo struct {
	Name  string `json:"name"`
	Tools int    `json:"tools"`
}

type SessionInfo struct {
	Agents  []AgentConfig `json:"agents"`
	Tasks   []Task        `json:"tasks"`
	LastSeq int           `json:"lastSeq"`
	Running bool          `json:"running"`
	// Static project context, sent once on /session rather than repeated on every event.
	Root          string          `json:"root"`
	Lsp           []LspInfo       `json:"lsp"`
	Mcp           []McpInfo       `json:"mcp"`
	ContextLimits map[string]int  `json:"contextLimits"` // agent id → its model's context window
	Theme         string          `json:"theme"`         // `theme:` from agents.yaml, applied at launch
	Prefs         map[string]bool `json:"prefs"`         // Config-tab flags from agents.yaml (lightMode, reduceMotion, …); nil from an older core
	Auto          bool            `json:"auto"`          // default permission mode: true = auto-approve
	Settings      *Settings       `json:"settings"`      // live toggles; nil from an older core
}

type AgentEvent struct {
	AgentID string `json:"agentId"`
	Type    string `json:"type"`
	Payload string `json:"payload"`
	Time    int64  `json:"time"`
	Diff    string `json:"diff"` // file_edit only: unified snippet of the change
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
	Cancelled bool       `json:"cancelled"`
	From      string     `json:"from"`
	To        []string   `json:"to"`
	Summary   string     `json:"summary"`
	// review / replan. The core has always emitted these; nothing decoded them, so the two most
	// interesting things the orchestrator does were invisible in the TUI.
	Reviewer string `json:"reviewer"`
	Phase    string `json:"phase"`
	Action   string `json:"action"`
	Reason   string `json:"reason"`
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
	// usage events only: session spend so far. CostKnown is false when some agent's model has no
	// published price, so the UI can show "$0.42+" instead of implying the total is complete.
	Cost      float64 `json:"cost"`
	CostKnown bool    `json:"costKnown"`
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

// Prompt submits a goal. mode "plan" stops after the orchestrator has built the task DAG; "build"
// (or "") runs it.
func (c *Client) Prompt(text, mode string) error {
	return c.do("POST", "/prompt", map[string]string{"text": text, "mode": mode}, nil)
}

func (c *Client) Cancel() error { return c.do("POST", "/cancel", nil, nil) }

// Command mirrors one entry of the server-side slash-command registry (src/commands/registry.ts).
// The TUI renders this list rather than hardcoding a switch, so the TUI and the web dashboard stay
// in step as commands are added.
type Command struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// CommandResult is what running one returns. View is a pure client-side view switch when set.
type CommandResult struct {
	Ok      bool   `json:"ok"`
	Message string `json:"message"`
	View    string `json:"view"`
	Error   string `json:"error"`
}

func (c *Client) Commands() ([]Command, error) {
	var r struct {
		Commands []Command `json:"commands"`
	}
	err := c.do("GET", "/commands", nil, &r)
	return r.Commands, err
}

func (c *Client) RunCommand(name, args string) (CommandResult, error) {
	var res CommandResult
	err := c.do("POST", "/commands/"+url.PathEscape(name), map[string]string{"args": args}, &res)
	return res, err
}

// StatsDay is one calendar day's token total, driving the contribution heatmap and the
// tokens-per-day chart. Date is "YYYY-MM-DD" in the server's local time.
type StatsDay struct {
	Date   string `json:"date"`
	Tokens int    `json:"tokens"`
	Msgs   int    `json:"msgs"`
}

type StatsModel struct {
	Name      string  `json:"name"` // provider/model
	InTokens  int     `json:"inTokens"`
	OutTokens int     `json:"outTokens"`
	Msgs      int     `json:"msgs"`
	Usd       float64 `json:"usd"`
	Priced    bool    `json:"priced"`
}

// Stats is the all-time usage aggregate behind the /stats overlay — computed by the server from the
// SQLite session history (src/store/session-store.ts stats()).
type Stats struct {
	PerDay           []StatsDay   `json:"perDay"`
	PerModel         []StatsModel `json:"perModel"`
	Sessions         int          `json:"sessions"`
	InTokens         int          `json:"inTokens"`
	OutTokens        int          `json:"outTokens"`
	LongestSessionMs int64        `json:"longestSessionMs"`
	TotalUsd         float64      `json:"totalUsd"`
	CostComplete     bool         `json:"costComplete"`
}

func (c *Client) Stats() (Stats, error) {
	var s Stats
	return s, c.do("GET", "/stats", nil, &s)
}

func (c *Client) SwitchModel(agentID, provider, model, baseURL string) error {
	return c.do("POST", "/model", map[string]string{"agentId": agentID, "provider": provider, "model": model, "baseURL": baseURL}, nil)
}

// SetTheme persists the active theme to .niti/agents.yaml and broadcasts it over SSE so the web
// dashboard and graph page pick it up live (see the theme carousel's enter handler).
// Settings mirrors the core's RuntimeSettings.
type Settings struct {
	AutoCompact  bool `json:"autoCompact"`
	ThinkingMode bool `json:"thinkingMode"`
}

// SetSetting flips one runtime setting ("autoCompact" | "thinkingMode") on the live engine; the
// core persists it to agents.yaml.
func (c *Client) SetSetting(key string, on bool) error {
	return c.do("POST", "/settings", map[string]bool{key: on}, nil)
}

func (c *Client) SetTheme(name string) error {
	return c.do("POST", "/theme", map[string]string{"theme": name}, nil)
}

// SetAuto persists the approval mode to .niti/agents.yaml and flips it on the live engine — the
// team picker's setup question, and the same route /auto and /manual use. Auto means writes and
// shell stop asking; genuinely dangerous commands, and anything reaching outside the project,
// still prompt either way (see src/agent/agent.ts).
func (c *Client) SetAuto(on bool) error {
	return c.do("POST", "/auto", map[string]bool{"auto": on}, nil)
}

// edited overrides fields of the approved call's input (e.g. a diff-view in-place edit) — nil for
// a plain approve/deny, unchanged from before this parameter existed.
func (c *Client) Approve(ok bool, scope string, edited map[string]any) error {
	body := map[string]any{"ok": ok, "scope": scope}
	if edited != nil {
		body["edited"] = edited
	}
	return c.do("POST", "/approval", body, nil)
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

// ProviderInfo is one flattened catalog entry, carrying the category it came from so the picker
// can say what kind of provider it is ("byok" needs a key, "local" needs a running server).
type ProviderInfo struct {
	ID       string
	Label    string
	Category string
}

// AllProviders flattens /providers into one ordered list: bring-your-own-key first, then local
// runtimes, then login-based ones. The team picker offers the whole catalog — not just providers
// with a stored key — and collects a key at the moment one is chosen.
func (c *Client) AllProviders() ([]ProviderInfo, error) {
	resp, err := c.Providers()
	var out []ProviderInfo
	for _, cat := range []string{"byok", "local", "login"} {
		for _, p := range resp.Providers[cat] {
			out = append(out, ProviderInfo{ID: p.ID, Label: p.Label, Category: cat})
		}
	}
	return out, err
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

// Credential mirrors GET /auth's redacted entries — provider + auth type, never the secret itself.
type Credential struct {
	Provider string `json:"provider"`
	Type     string `json:"type"`
}

// Credentials lists which providers already have a key/session stored, so the model picker can
// offer only providers actually usable right now.
func (c *Client) Credentials() ([]Credential, error) {
	var r struct {
		Credentials []Credential `json:"credentials"`
	}
	err := c.do("GET", "/auth", nil, &r)
	return r.Credentials, err
}

// SaveAgents persists role assignments to .niti/agents.yaml (POST /agents).
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
