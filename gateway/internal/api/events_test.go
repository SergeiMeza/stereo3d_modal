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
	return readStream(t, resp)
}

// readStream reads an event stream's messages.
func readStream(t *testing.T, resp *http.Response) *sseClient {
	t.Helper()
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

// The snapshot carries handoffs, settles and the balance; a code's state
// change is handoff.state, a balance change billing.updated.
func TestEventsHandoffAndBalance(t *testing.T) {
	s, srv := eventsService(t, nil)
	ctx := context.Background()
	uid := "u" + store.NewID()
	c := openStream(t, srv, uid, "", "")
	_, snap := c.next("snapshot", 5*time.Second)
	if hs, ok := snap["handoffs"].([]any); !ok || len(hs) != 0 || snap["billing"] != nil || snap["settles"] == nil || snap["run_formats"] == nil {
		t.Fatalf("snapshot %v", snap)
	}
	code := "H" + store.NewID()[:7]
	if err := s.Store.CreateHandoff(ctx, &store.Handoff{Code: code, ConversionID: "r1", UID: uid, State: "waiting"}); err != nil {
		t.Fatal(err)
	}
	if _, d := c.next("handoff.state", 5*time.Second); d["code"] != code || d["state"] != "waiting" || d["run_id"] != "r1" || d["version"] == nil {
		t.Fatalf("handoff %v", d)
	}
	s.Store.SetHandoffState(ctx, code, "paying")
	if _, d := c.next("handoff.state", 5*time.Second); d["state"] != "paying" {
		t.Fatalf("handoff %v", d)
	}
	exp := time.Now().Add(24 * time.Hour)
	if _, _, err := s.Store.BalanceTx(ctx, uid, func(*store.Balance) ([]store.BalanceOp, error) {
		return []store.BalanceOp{{Kind: store.EntryPlanCredit, Cents: 2000, EntryID: "pc_" + store.NewID(), Ref: "test", ExpiresAt: &exp, Additive: true}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, d := c.next("billing.updated", 5*time.Second); d["kind"] != "balance" || d["balance_cents"] != float64(2000) || d["held_cents"] != float64(0) {
		t.Fatalf("billing %v", d)
	}
	c2 := openStream(t, srv, uid, "", "")
	_, snap = c2.next("snapshot", 5*time.Second)
	hs, _ := snap["handoffs"].([]any)
	b, _ := snap["billing"].(map[string]any)
	if len(hs) != 1 || hs[0].(map[string]any)["state"] != "paying" || b["balance_cents"] != float64(2000) {
		t.Fatalf("snapshot %v", snap)
	}
}

// A settle's change is billing.updated {kind: settle}; duplicates dropped.
func TestEventsSettle(t *testing.T) {
	s, _ := e0Service(t)
	var out strings.Builder
	es := newEventStream(s, &out, func() error { return nil })
	now := time.Now()
	d := store.WatchedDoc{Kind: "settle", ID: "st1", Version: now, Settle: &store.Settle{ID: "st1", State: store.SettleSettling, AmountCents: 1234}}
	es.handle(d, now)
	es.handle(d, now)
	d2 := d
	d2.Version, d2.Settle = now.Add(time.Second), &store.Settle{ID: "st1", State: store.SettlePaid, AmountCents: 1234}
	es.handle(d2, now)
	got := out.String()
	if strings.Count(got, "event: billing.updated") != 2 || !strings.Contains(got, `"state":"paid"`) || !strings.Contains(got, `"kind":"settle"`) ||
		!strings.Contains(got, `"settle_id":"st1"`) || !strings.Contains(got, `"amount_cents":1234`) {
		t.Fatal(got)
	}
}

// A format job starting or finishing is run.formats with the run's formats
// and outputs; the snapshot has run_formats for runs with format jobs.
func TestEventsRunFormats(t *testing.T) {
	s, srv := eventsService(t, nil)
	ctx := context.Background()
	uid := "u" + store.NewID()
	run := finishedRun(t, s, uid, "4k", "sbs", "half_sbs")
	c := openStream(t, srv, uid, "", "")
	c.next("snapshot", 5*time.Second)
	if _, err := s.Store.Transition(ctx, run.ID, []string{store.StateSucceeded}, func(x *store.Conversion) error {
		x.Repacks = map[string]*store.Repack{"mvhevc": {Format: "mvhevc", Source: "sbs", Status: "processing", RequestedAt: time.Now()}}
		x.RepackPending = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	_, d := c.next("run.formats", 5*time.Second)
	f, _ := d["formats"].(map[string]any)
	if d["run_id"] != run.ID || strings.Join(strs(f["pending"]), ",") != "mvhevc" || strings.Join(strs(d["outputs"]), ",") != "half_sbs,sbs" {
		t.Fatalf("formats %v", d)
	}
	if _, err := s.Store.Transition(ctx, run.ID, []string{store.StateSucceeded}, func(x *store.Conversion) error {
		x.Repacks["mvhevc"].Status = "succeeded"
		x.Outputs["mvhevc"] = "stereo3d/test/outputs/x/repack_mvhevc.mov"
		x.RepackPending = false
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	_, d = c.next("run.formats", 5*time.Second)
	f, _ = d["formats"].(map[string]any)
	if !strings.Contains(strings.Join(strs(f["have"]), ","), "mvhevc") || strings.Join(strs(d["outputs"]), ",") != "half_sbs,mvhevc,sbs" {
		t.Fatalf("formats %v", d)
	}
	c2 := openStream(t, srv, uid, "", "")
	_, snap := c2.next("snapshot", 5*time.Second)
	if rf, _ := snap["run_formats"].(map[string]any); rf[run.ID] == nil {
		t.Fatalf("snapshot %v", snap["run_formats"])
	}
}

func adminStream(t *testing.T, srv *httptest.Server, ticket, query string) (*sseClient, int) {
	t.Helper()
	resp, err := http.Get(srv.URL + "/v1/admin/events?ticket=" + ticket + query)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	if resp.StatusCode != 200 {
		return nil, resp.StatusCode
	}
	c := &sseClient{t: t, resp: resp, msgs: make(chan sseMsg, 256)}
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
			case strings.HasPrefix(line, "event: "):
				m.Event = line[7:]
			case strings.HasPrefix(line, "data: "):
				m.Data = line[6:]
			}
		}
	}()
	return c, 200
}

// The console's stream: an admin-scoped ticket only (a viewer's is
// refused, and an admin ticket doesn't open a viewer stream); one run, one
// account's runs, or the active feed; runs only; the open is audited.
func TestAdminEvents(t *testing.T) {
	s, _ := eventsService(t, nil)
	ctx := context.Background()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/admin/events", s.HandleAdminEventStream)
	mux.HandleFunc("GET /v1/events", s.HandleEventStream)
	asrv := httptest.NewServer(mux)
	t.Cleanup(asrv.Close)
	ticketOf := func(h func(w http.ResponseWriter)) string {
		rec := httptest.NewRecorder()
		h(rec)
		var out map[string]any
		json.Unmarshal(rec.Body.Bytes(), &out)
		tk, _ := out["ticket"].(string)
		if tk == "" {
			t.Fatalf("ticket %d %s", rec.Code, rec.Body.String())
		}
		return tk
	}
	uid, other := "u"+store.NewID(), "u"+store.NewID()
	userTicket := ticketOf(func(w http.ResponseWriter) {
		s.HandleEventsTicket(w, httptest.NewRequest(http.MethodPost, "/v1/events/ticket", nil), &AuthedUser{UID: uid})
	})
	adminTicket := ticketOf(func(w http.ResponseWriter) {
		s.HandleAdminEventsTicket(w, httptest.NewRequest(http.MethodPost, "/v1/admin/events/ticket", nil), &AdminUser{UID: "admin1", Email: "ops@example.test"})
	})
	if _, code := adminStream(t, asrv, userTicket, "&feed=active"); code != 401 {
		t.Fatalf("viewer ticket %d", code)
	}
	if _, code := adminStream(t, asrv, "nope", "&feed=active"); code != 401 {
		t.Fatalf("bad ticket %d", code)
	}
	if resp, _ := http.Get(asrv.URL + "/v1/events?ticket=" + adminTicket); resp.StatusCode != 401 {
		t.Fatalf("admin ticket on the viewer stream %d", resp.StatusCode)
	}
	if _, code := adminStream(t, asrv, adminTicket, ""); code != 400 {
		t.Fatalf("no filter %d", code)
	}
	r1 := eventsRun(t, s, uid, "")
	r2 := eventsRun(t, s, other, "")

	one, _ := adminStream(t, asrv, adminTicket, "&run_id="+r1.ID)
	_, snap := one.next("snapshot", 5*time.Second)
	if runs, _ := snap["runs"].([]any); len(runs) != 1 || snap["projects"] != nil || snap["billing"] != nil {
		t.Fatalf("run_id snapshot %v", snap)
	}
	setProgress(t, s, r1.ID, 0.4)
	if _, d := one.next("run.progress", 5*time.Second); d["run_id"] != r1.ID || d["progress"] != 0.4 {
		t.Fatalf("progress %v", d)
	}

	byUID, _ := adminStream(t, asrv, adminTicket, "&uid="+other)
	_, snap = byUID.next("snapshot", 5*time.Second)
	if runs, _ := snap["runs"].([]any); len(runs) != 1 || runs[0].(map[string]any)["conversion_id"] != r2.ID {
		t.Fatalf("uid snapshot %v", snap)
	}

	feed, _ := adminStream(t, asrv, adminTicket, "&feed=active")
	_, snap = feed.next("snapshot", 5*time.Second)
	ids := map[string]bool{}
	for _, r := range snap["runs"].([]any) {
		ids[r.(map[string]any)["conversion_id"].(string)] = true
	}
	if !ids[r1.ID] || !ids[r2.ID] {
		t.Fatalf("feed %v", ids)
	}
	var err error
	for range 3 { // the emulator sometimes cancels a transaction beside many listeners
		if _, err = s.Store.Transition(ctx, r2.ID, []string{store.StateProcessing}, func(c *store.Conversion) error { c.State = store.StateSucceeded; return nil }); err == nil {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if got, _ := s.Store.GetConversion(ctx, r2.ID); err != nil && (got == nil || got.State != store.StateSucceeded) {
		t.Fatal(err) // (a cancelled reply can still have committed)
	}
	if _, d := feed.next("run.state", 5*time.Second); d["run_id"] != r2.ID || d["state"] != store.StateSucceeded {
		t.Fatalf("feed state %v", d)
	}
}
