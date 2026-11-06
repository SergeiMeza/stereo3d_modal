package api

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Emulator only (Firestore listeners), made-up accounts.

type sseMsg struct {
	Event, ID, Data, Comment string
}

type sseClient struct {
	t    *testing.T
	resp *http.Response
	msgs chan sseMsg
}

func openStream(t *testing.T, srv *httptest.Server, uid, lastID, query string) *sseClient {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/v1/events"+query, nil)
	if uid != "" {
		req.Header.Set("X-Test-UID", uid)
	}
	if lastID != "" {
		req.Header.Set("Last-Event-ID", lastID)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	c := &sseClient{t: t, resp: resp, msgs: make(chan sseMsg, 256)}
	t.Cleanup(func() { resp.Body.Close() })
	go func() {
		defer close(c.msgs)
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		var m sseMsg
		for sc.Scan() {
			line := sc.Text()
			switch {
			case line == "":
				if m != (sseMsg{}) {
					c.msgs <- m
				}
				m = sseMsg{}
			case strings.HasPrefix(line, ":"):
				m.Comment = strings.TrimSpace(line[1:])
			case strings.HasPrefix(line, "event: "):
				m.Event = line[7:]
			case strings.HasPrefix(line, "id: "):
				m.ID = line[4:]
			case strings.HasPrefix(line, "data: "):
				m.Data = line[6:]
			}
		}
	}()
	return c
}

// next waits for the next message matching want ("" = any event).
func (c *sseClient) next(want string, within time.Duration) (sseMsg, map[string]any) {
	c.t.Helper()
	deadline := time.After(within)
	for {
		select {
		case m, ok := <-c.msgs:
			if !ok {
				c.t.Fatalf("stream closed waiting for %q", want)
			}
			if want != "" && m.Event != want && !(want == "comment" && m.Comment != "") {
				continue
			}
			var d map[string]any
			json.Unmarshal([]byte(m.Data), &d)
			return m, d
		case <-deadline:
			c.t.Fatalf("no %q within %s", want, within)
		}
	}
}

func eventsService(t *testing.T, timing *eventsTiming) (*Service, *httptest.Server) {
	t.Helper()
	s, _ := e0Service(t)
	s.EventsAuth = func(r *http.Request) (string, bool) {
		uid := r.Header.Get("X-Test-UID")
		return uid, uid != ""
	}
	if timing == nil {
		timing = &eventsTiming{Heartbeat: time.Hour, MaxAge: time.Minute, Flush: 50 * time.Millisecond}
	}
	s.EventsTiming = timing
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/events":
			s.HandleEventStream(w, r)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/events/ticket":
			s.HandleEventsTicket(w, r, &AuthedUser{UID: r.Header.Get("X-Test-UID")})
		}
	}))
	t.Cleanup(srv.Close)
	return s, srv
}

func eventsRun(t *testing.T, s *Service, uid, projectID string) *store.Conversion {
	t.Helper()
	c := &store.Conversion{ID: store.NewID(), UID: uid, ProjectID: projectID, Kind: "video", Step: store.StepProduction,
		Method: store.MethodLifelike, State: store.StateProcessing, Quote: store.Quote{AmountCents: 500, Currency: "usd"}}
	if err := s.Store.CreateConversion(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	return c
}

func setProgress(t *testing.T, s *Service, id string, p float64) {
	t.Helper()
	if _, err := s.Store.Transition(context.Background(), id, []string{store.StateProcessing}, func(c *store.Conversion) error {
		c.Modal.Progress, c.Modal.Stage = p, "render"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

// Auth: no viewer, a bad ticket → 401; a ticket from POST /v1/events/ticket opens the stream.
func TestEventsAuth(t *testing.T) {
	s, srv := eventsService(t, nil)
	for _, q := range []string{"", "?ticket=nope"} {
		resp, err := http.Get(srv.URL + "/v1/events" + q)
		if err != nil || resp.StatusCode != 401 {
			t.Fatalf("%q: %v %v", q, resp.StatusCode, err)
		}
		resp.Body.Close()
	}
	uid := "u" + store.NewID()
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/events/ticket", nil)
	req.Header.Set("X-Test-UID", uid)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		t.Fatal(err)
	}
	var tk map[string]any
	json.NewDecoder(resp.Body).Decode(&tk)
	resp.Body.Close()
	s.EventsAuth = nil // only the ticket now
	c := openStream(t, srv, "", "", "?ticket="+tk["ticket"].(string))
	if c.resp.StatusCode != 200 || c.resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("ticket stream %d %s", c.resp.StatusCode, c.resp.Header.Get("Content-Type"))
	}
	if _, d := c.next("snapshot", 10*time.Second); d["type"] != "snapshot" {
		t.Fatalf("snapshot %v", d)
	}
}

// Connect: a snapshot with the viewer's runs and projects; then a state
// change is run.state at once, progress is run.progress at most once a
// second with the latest value, and a project change is project.updated.
func TestEventsSnapshotAndLive(t *testing.T) {
	s, srv := eventsService(t, nil)
	ctx := context.Background()
	uid := "u" + store.NewID()
	p := &store.Project{ID: store.NewID(), UID: uid, Name: "Kyoto", Method: store.MethodLifelike}
	s.Store.CreateProject(ctx, p)
	run := eventsRun(t, s, uid, p.ID)
	other := eventsRun(t, s, "u"+store.NewID(), p.ID) // someone else's: never sent
	c := openStream(t, srv, uid, "", "")
	m, snap := c.next("snapshot", 10*time.Second)
	runs, _ := snap["runs"].([]any)
	projects, _ := snap["projects"].([]any)
	if len(runs) != 1 || runs[0].(map[string]any)["conversion_id"] != run.ID || len(projects) != 1 || m.ID == "" {
		t.Fatalf("snapshot %v", snap)
	}
	setProgress(t, s, run.ID, 0.1)
	_, d := c.next("run.progress", 5*time.Second)
	if d["run_id"] != run.ID || d["progress"] != 0.1 || d["version"] == nil {
		t.Fatalf("progress %v", d)
	}
	start := time.Now()
	setProgress(t, s, run.ID, 0.2)
	setProgress(t, s, run.ID, 0.3)
	_, d = c.next("run.progress", 5*time.Second)
	if d["progress"] != 0.3 && d["progress"] != 0.2 {
		t.Fatalf("throttled progress %v", d)
	}
	if time.Since(start) < 700*time.Millisecond && d["progress"] == 0.2 {
		t.Fatal("not throttled")
	}
	setProgress(t, s, other.ID, 0.5)
	if _, err := s.Store.Transition(ctx, run.ID, []string{store.StateProcessing}, func(cc *store.Conversion) error {
		cc.State = store.StateSucceeded
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	_, d = c.next("run.state", 5*time.Second)
	if d["run_id"] != run.ID || d["state"] != "succeeded" || d["run"].(map[string]any)["state"] != "succeeded" {
		t.Fatalf("state %v", d)
	}
	s.Store.UpdateProject(ctx, p.ID, func(pp *store.Project) error { pp.Name = "Kyoto at night"; return nil })
	_, d = c.next("project.updated", 5*time.Second)
	if d["project_id"] != p.ID || d["project"].(map[string]any)["name"] != "Kyoto at night" || d["deleted"] != false {
		t.Fatalf("project %v", d)
	}
}

// Reconnect with a recent Last-Event-ID: no snapshot, just what changed
// since; with an old (or unreadable) one: a snapshot.
func TestEventsResume(t *testing.T) {
	s, srv := eventsService(t, nil)
	uid := "u" + store.NewID()
	run := eventsRun(t, s, uid, "")
	eventsRun(t, s, uid, "") // unchanged while away (may come again inside the slack; the version rule drops it)
	c := openStream(t, srv, uid, "", "")
	m, _ := c.next("snapshot", 10*time.Second)
	c.resp.Body.Close()
	setProgress(t, s, run.ID, 0.6) // changes while away
	r := openStream(t, srv, uid, m.ID, "")
	got := false
	for i := 0; i < 2 && !got; i++ {
		msg, d := r.next("", 10*time.Second)
		if msg.Event == "snapshot" {
			t.Fatal("a recent resume got a snapshot")
		}
		got = d["run_id"] == run.ID && (d["progress"] == 0.6 || d["run"].(map[string]any)["progress"] == 0.6)
	}
	if !got {
		t.Fatal("the change while away wasn't replayed")
	}
	old := openStream(t, srv, uid, strconv.FormatInt(time.Now().Add(-time.Hour).UnixMicro(), 10), "")
	if msg, _ := old.next("", 10*time.Second); msg.Event != "snapshot" {
		t.Fatalf("an old resume got %s", msg.Event)
	}
	bad := openStream(t, srv, uid, "garbage", "")
	if msg, _ := bad.next("", 10*time.Second); msg.Event != "snapshot" {
		t.Fatalf("an unreadable id got %s", msg.Event)
	}
}

// Duplicates and late arrivals: a version at or below the one sent is
// dropped; ids stay monotonic.
func TestEventsDedupeAndOrder(t *testing.T) {
	s, _ := e0Service(t)
	var out strings.Builder
	es := newEventStream(s, &out, func() error { return nil })
	now := time.Now()
	run := func(ver time.Time, state string, p float64) store.WatchedDoc {
		return store.WatchedDoc{Kind: "run", ID: "r1", Version: ver,
			Conversion: &store.Conversion{ID: "r1", State: state, Modal: store.Modal{Progress: p}}}
	}
	t0 := now.Add(-time.Minute)
	es.handle(run(t0, store.StateProcessing, 0.1), now)
	es.handle(run(t0, store.StateProcessing, 0.1), now)                    // duplicate
	es.handle(run(t0.Add(-time.Second), store.StateProcessing, 0.05), now) // late, older
	es.handle(run(t0.Add(2*time.Second), store.StateSucceeded, 1), now)    // newer
	es.handle(run(t0.Add(time.Second), store.StateProcessing, 0.5), now)   // arrives after a newer one
	if n := strings.Count(out.String(), "event: "); n != 2 {
		t.Fatalf("%d events:\n%s", n, out.String())
	}
	var ids []int64
	for _, line := range strings.Split(out.String(), "\n") {
		if v, ok := strings.CutPrefix(line, "id: "); ok {
			id, _ := strconv.ParseInt(v, 10, 64)
			ids = append(ids, id)
		}
	}
	if len(ids) != 2 || ids[1] <= ids[0] {
		t.Fatalf("ids %v", ids)
	}
}

// A heartbeat comment on the clock, and a bye before the max age, then the
// stream ends (the browser reconnects).
func TestEventsHeartbeatAndClose(t *testing.T) {
	_, srv := eventsService(t, &eventsTiming{Heartbeat: 200 * time.Millisecond, MaxAge: 1500 * time.Millisecond, Flush: 50 * time.Millisecond})
	c := openStream(t, srv, "u"+store.NewID(), "", "")
	c.next("snapshot", 10*time.Second)
	if m, _ := c.next("comment", 3*time.Second); m.Comment != "hb" {
		t.Fatalf("heartbeat %+v", m)
	}
	if _, d := c.next("bye", 5*time.Second); d["reason"] != "max_age" || d["retry_ms"] == nil {
		t.Fatalf("bye %v", d)
	}
	select {
	case _, ok := <-c.msgs:
		for ok {
			_, ok = <-c.msgs
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the stream didn't end")
	}
}
