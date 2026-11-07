package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Live updates for the web (owner 2026-11-07, ADR in the SVS repo):
// Server-Sent Events, GET /v1/events, one stream per signed-in viewer.
//
//	event: snapshot         {type, version, runs: [Run], projects: [Project]}
//	event: run.state        {type, run_id, project_id, version, state, run: Run}
//	event: run.progress     {type, run_id, project_id, version, state, progress, stage,
//	                         eta_seconds, waiting_for_gpu, queued_s}
//	event: project.updated  {type, project_id, version, deleted, project: Project}
//	event: run.formats      {type, run_id, project_id, version, formats: Formats, outputs: [name]}
//	event: handoff.state    {type, code, run_id, version, state}
//	event: billing.updated  {type, kind: settle|balance, version, settle_id?, state?,
//	                         amount_cents?, balance_cents?, held_cents?}
//	event: bye              {type, reason: max_age|listener|restart, retry_ms}
//	                        (restart: the instance is stopping, retry_ms 1000–3000)
//	: hb                    (a comment every 20 s)
//
// Run is GET /v1/conversions/{id}'s answer, Project GET /v1/projects/{id}'s
// without its conversions, Formats GET /v1/runs/{id}/formats'. The
// snapshot also carries run_formats {run_id: Formats} (runs with format
// jobs), handoffs [{code, run_id, state, version}], settles [{settle_id,
// state, amount_cents, version}] and billing {balance_cents, held_cents,
// version} (null without a balance). The console's stream (GET
// /v1/admin/events) carries runs only. version is the document's update time in
// microseconds: apply an event only when its version is above the one
// held for that run or project (duplicates and late arrivals are then
// harmless). Every event has an id (monotonic within the stream); on
// reconnect the browser sends Last-Event-ID and gets what changed since
// (a resume more than 10 minutes old, or unreadable, gets a snapshot
// instead). The stream closes itself before Cloud Run's request timeout
// with bye; EventSource then reconnects.
//
// Fan-out is a Firestore listener per stream on the viewer's newest runs
// and projects (uid == X), so any instance's writes reach every stream;
// nothing is held in instance memory. Progress is sent at most once a
// second per run (the latest wins); state and every other change go at
// once.

const (
	eventsRunWindow     = 50
	eventsProjectWindow = 100
	eventsReplayWindow  = 10 * time.Minute
	eventsReplaySlack   = 10 * time.Second // listeners can deliver slightly out of order
	eventsProgressGap   = time.Second
	eventsTicketTTL     = 2 * time.Minute
)

// eventsTiming: the stream's clock (tests shorten it).
type eventsTiming struct {
	Heartbeat time.Duration
	MaxAge    time.Duration
	Flush     time.Duration
}

func (s *Service) eventsTiming() eventsTiming {
	if s.EventsTiming != nil {
		return *s.EventsTiming
	}
	// Cloud Run's request timeout is 3600 s (deploy.sh); close well inside it.
	return eventsTiming{Heartbeat: 20 * time.Second, MaxAge: 55 * time.Minute, Flush: 250 * time.Millisecond}
}

// POST /v1/events/ticket → {ticket, expires_at, url}: for EventSource,
// which can't send an Authorization header. Good for 2 minutes (and for
// EventSource's own reconnects within them); fetch a new one to
// reconnect after.
func (s *Service) HandleEventsTicket(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	ticket := hex.EncodeToString(b)
	exp := time.Now().UTC().Add(eventsTicketTTL)
	if err := s.Store.PutStreamTicket(ctx, ticket, &store.StreamTicket{UID: user.UID, ExpiresAt: exp}); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, map[string]any{"ticket": ticket, "expires_at": exp.Format(time.RFC3339), "url": "/v1/events?ticket=" + ticket})
}

// eventsUser: a Firebase ID token (Authorization: Bearer, for fetch-based
// clients) or a ticket (?ticket=, for EventSource).
func (s *Service) eventsUser(r *http.Request) (string, bool) {
	if t := r.URL.Query().Get("ticket"); t != "" {
		uid := s.Store.StreamTicketUID(r.Context(), t, time.Now())
		return uid, uid != ""
	}
	if s.EventsAuth != nil {
		return s.EventsAuth(r)
	}
	if s.Auth == nil {
		return "", false
	}
	u, err := s.Auth.FromRequest(r)
	if err != nil {
		return "", false
	}
	return u.UID, true
}

// sseEvent is one event to write.
type sseEvent struct {
	name string
	id   int64
	data any
}

// eventStream is one viewer's stream state.
type eventStream struct {
	s      *Service
	w      io.Writer
	flush  func() error
	lastID int64
	// sent: the version last sent per entity ("run:<id>", "project:<id>").
	sent map[string]int64
	// lastFull: a run's last sent answer without its progress fields (a
	// change outside them is a run.state event); lastState its state.
	lastFull  map[string]string
	lastState map[string]string
	// progress throttle: when a run's progress was last sent, and the
	// latest held back.
	progressAt map[string]time.Time
	pending    map[string]*store.WatchedDoc
	// lastProgress / lastFormats: a run's last sent progress and formats.
	lastProgress map[string]string
	lastFormats  map[string]string
	runsOnly     bool // the console's stream
	// jobs: the project job watchers this stream holds (live_jobs.go),
	// project id → release.
	jobs map[string]func()
}

func newEventStream(s *Service, w io.Writer, flush func() error) *eventStream {
	return &eventStream{s: s, w: w, flush: flush, sent: map[string]int64{}, lastFull: map[string]string{},
		lastState: map[string]string{}, progressAt: map[string]time.Time{}, pending: map[string]*store.WatchedDoc{},
		lastProgress: map[string]string{}, lastFormats: map[string]string{}, jobs: map[string]func(){}}
}

// trackJobs holds a job watcher for a shown project while its analyze or
// shot profiling runs, and lets go when it stops or leaves the window.
func (e *eventStream) trackJobs(d store.WatchedDoc) {
	if e.runsOnly || e.s == nil {
		return
	}
	running := !d.Removed && jobRunning(d.Project)
	switch release, held := e.jobs[d.ID]; {
	case running && !held:
		e.jobs[d.ID] = e.s.watchProjectJobs(d.ID)
	case !running && held:
		release()
		delete(e.jobs, d.ID)
	}
}

// releaseJobs lets go of every watcher (the stream ended).
func (e *eventStream) releaseJobs() {
	for id, release := range e.jobs {
		release()
		delete(e.jobs, id)
	}
}

func (e *eventStream) write(ev sseEvent) error {
	b, err := json.Marshal(ev.data)
	if err != nil {
		return err
	}
	// one write per event (the relay rewrites storage links write by write)
	if _, err := fmt.Fprintf(e.w, "event: %s\nid: %d\ndata: %s\n\n", ev.name, ev.id, b); err != nil {
		return err
	}
	return e.flush()
}

// nextID is monotonic within the stream and at least the version.
func (e *eventStream) nextID(version int64) int64 {
	e.lastID = max(e.lastID+1, version)
	return e.lastID
}

// progressFields are what a run.progress event carries; a change in
// anything else is a run.state event.
var progressFields = []string{"progress", "stage", "eta_seconds", "eta_source", "waiting_for_gpu", "queued_s",
	"queue_wait_max_seconds", "parts", "updated_at"}

func runKey(id string) string     { return "run:" + id }
func projectKey(id string) string { return "project:" + id }

func hashOf(v any) string {
	b, _ := json.Marshal(v)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:8])
}

// progressOf is what a run.progress event carries.
func progressOf(full map[string]any) map[string]any {
	return map[string]any{"progress": full["progress"], "stage": full["stage"], "eta_seconds": full["eta_seconds"],
		"waiting_for_gpu": full["waiting_for_gpu"], "queued_s": full["queued_s"]}
}

// formatsOf is the run's "another format" jobs (nil without any).
func (e *eventStream) formatsOf(c *store.Conversion) map[string]any {
	if len(c.Repacks) == 0 {
		return nil
	}
	return e.s.runFormatsOf(context.Background(), c).json(c)
}

func outputNames(c *store.Conversion) []string {
	names := make([]string, 0, len(c.Outputs))
	for n := range c.Outputs {
		names = append(names, n)
	}
	slices.Sort(names)
	return names
}

func (e *eventStream) runJSON(c *store.Conversion) (map[string]any, string) {
	full := e.s.conversionResponse(c, nil)
	rest := make(map[string]any, len(full))
	for k, v := range full {
		if !slices.Contains(progressFields, k) {
			rest[k] = v
		}
	}
	b, _ := json.Marshal(rest)
	sum := sha256.Sum256(b)
	return full, hex.EncodeToString(sum[:8])
}

func (e *eventStream) projectJSON(p *store.Project) map[string]any {
	return e.s.projectResponse(p, nil)
}

// handle sends one change (or holds back a run's progress); false when
// it was already sent or is older than what was.
func (e *eventStream) handle(d store.WatchedDoc, now time.Time) error {
	ver := d.Version.UnixMicro()
	switch d.Kind {
	case "run":
		key := runKey(d.ID)
		if d.Removed && e.runsOnly && e.sent[key] > 0 {
			// left the console's feed (finished, failed): its last state
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			got, ok := e.s.Store.GetRun(ctx, d.ID)
			cancel()
			if !ok || got.Removed {
				return nil
			}
			d, ver = got, got.Version.UnixMicro()
		}
		if d.Removed || d.Conversion == nil || ver <= e.sent[key] {
			return nil // left the window, a duplicate, or older than what was sent
		}
		c := d.Conversion
		full, restHash := e.runJSON(c)
		_, seen := e.lastFull[key]
		if !e.runsOnly {
			if f := e.formatsOf(c); f != nil || e.lastFormats[key] != "" {
				if h := hashOf([]any{f, outputNames(c)}); h != e.lastFormats[key] {
					e.lastFormats[key] = h
					if seen {
						if err := e.write(sseEvent{name: "run.formats", id: e.nextID(ver), data: map[string]any{"type": "run.formats",
							"run_id": c.ID, "project_id": c.ProjectID, "version": ver, "formats": f, "outputs": outputNames(c)}}); err != nil {
							return err
						}
					}
				}
			}
		}
		if seen && e.lastFull[key] == restHash && e.lastState[key] == c.State {
			ph := hashOf(progressOf(full))
			if ph == e.lastProgress[key] {
				e.sent[key] = ver // nothing a client shows changed
				return nil
			}
			if now.Sub(e.progressAt[key]) < eventsProgressGap {
				dd := d
				e.pending[key] = &dd // the latest wins
				return nil
			}
			return e.sendProgress(key, c, full, ver, now)
		}
		delete(e.pending, key)
		e.sent[key], e.lastFull[key], e.lastState[key] = ver, restHash, c.State
		e.lastProgress[key] = hashOf(progressOf(full))
		return e.write(sseEvent{name: "run.state", id: e.nextID(ver), data: map[string]any{"type": "run.state", "run_id": c.ID,
			"project_id": c.ProjectID, "version": ver, "state": c.State, "run": full}})
	case "project":
		key := projectKey(d.ID)
		e.trackJobs(d)
		if d.Removed || d.Project == nil || ver <= e.sent[key] {
			return nil
		}
		e.sent[key] = ver
		return e.write(sseEvent{name: "project.updated", id: e.nextID(ver), data: map[string]any{"type": "project.updated",
			"project_id": d.Project.ID, "version": ver, "deleted": d.Project.Deleted, "project": e.projectJSON(d.Project)}})
	case "handoff":
		key := "handoff:" + d.ID
		if d.Removed && e.sent[key] > 0 { // used or expired: gone
			v := max(time.Now().UnixMicro(), e.sent[key]+1)
			delete(e.sent, key)
			return e.write(sseEvent{name: "handoff.state", id: e.nextID(v), data: map[string]any{"type": "handoff.state", "code": d.ID,
				"version": v, "state": "closed"}})
		}
		if d.Removed || d.Handoff == nil || ver <= e.sent[key] {
			return nil
		}
		e.sent[key] = ver
		return e.write(sseEvent{name: "handoff.state", id: e.nextID(ver), data: handoffJSON(d.Handoff, ver, "handoff.state")})
	case "settle":
		key := "settle:" + d.ID
		if d.Removed || d.Settle == nil || ver <= e.sent[key] {
			return nil
		}
		e.sent[key] = ver
		return e.write(sseEvent{name: "billing.updated", id: e.nextID(ver), data: settleJSON(d.Settle, ver, "billing.updated")})
	case "balance":
		if d.Removed || d.Balance == nil || ver <= e.sent["balance"] {
			return nil
		}
		e.sent["balance"] = ver
		return e.write(sseEvent{name: "billing.updated", id: e.nextID(ver), data: balanceJSON(d.Balance, ver, "billing.updated")})
	}
	return nil
}

func handoffJSON(h *store.Handoff, ver int64, typ string) map[string]any {
	out := map[string]any{"code": h.Code, "run_id": h.ConversionID, "state": h.State, "version": ver}
	if typ != "" {
		out["type"] = typ
	}
	return out
}

func settleJSON(st *store.Settle, ver int64, typ string) map[string]any {
	out := map[string]any{"settle_id": st.ID, "state": st.State, "amount_cents": st.AmountCents, "version": ver}
	if typ != "" {
		out["type"], out["kind"] = typ, "settle"
	}
	return out
}

func balanceJSON(b *store.Balance, ver int64, typ string) map[string]any {
	out := map[string]any{"balance_cents": max(b.Available(), 0), "held_cents": b.HeldCents, "version": ver}
	if typ != "" {
		out["type"], out["kind"] = typ, "balance"
	}
	return out
}

func (e *eventStream) sendProgress(key string, c *store.Conversion, full map[string]any, ver int64, now time.Time) error {
	e.sent[key], e.progressAt[key] = ver, now
	e.lastProgress[key] = hashOf(progressOf(full))
	return e.write(sseEvent{name: "run.progress", id: e.nextID(ver), data: map[string]any{"type": "run.progress", "run_id": c.ID,
		"project_id": c.ProjectID, "version": ver, "state": c.State, "progress": full["progress"], "stage": full["stage"],
		"eta_seconds": full["eta_seconds"], "waiting_for_gpu": full["waiting_for_gpu"], "queued_s": full["queued_s"]}})
}

// flushPending sends held-back progress whose second has passed.
func (e *eventStream) flushPending(now time.Time) error {
	for key, d := range e.pending {
		if now.Sub(e.progressAt[key]) < eventsProgressGap {
			continue
		}
		delete(e.pending, key)
		ver := d.Version.UnixMicro()
		if ver <= e.sent[key] {
			continue
		}
		full, _ := e.runJSON(d.Conversion)
		if err := e.sendProgress(key, d.Conversion, full, ver, now); err != nil {
			return err
		}
	}
	return nil
}

// start answers the first batches: a snapshot, or on a recent resume the
// documents that changed since Last-Event-ID.
func (e *eventStream) start(initial []store.WatchedDoc, lastEventID int64, now time.Time) error {
	slices.SortFunc(initial, func(a, b store.WatchedDoc) int { return a.Version.Compare(b.Version) })
	resumeFrom := time.UnixMicro(lastEventID)
	if lastEventID > 0 && now.Sub(resumeFrom) <= eventsReplayWindow {
		since := resumeFrom.Add(-eventsReplaySlack).UnixMicro()
		e.lastID = lastEventID
		for _, d := range initial {
			ver := d.Version.UnixMicro()
			if ver > since {
				if err := e.handle(d, time.Time{}); err != nil {
					return err
				}
			} else {
				e.remember(d)
			}
		}
		return nil
	}
	runs, projects := []map[string]any{}, []map[string]any{}
	handoffs, settles := []map[string]any{}, []map[string]any{}
	formats := map[string]any{}
	var billing map[string]any
	var top int64
	for _, d := range initial {
		ver := d.Version.UnixMicro()
		top = max(top, ver)
		switch {
		case d.Kind == "run" && d.Conversion != nil:
			full, _ := e.runJSON(d.Conversion)
			runs = append(runs, full)
			if f := e.formatsOf(d.Conversion); f != nil && !e.runsOnly {
				formats[d.Conversion.ID] = f
			}
		case d.Kind == "project" && d.Project != nil:
			projects = append(projects, e.projectJSON(d.Project))
		case d.Kind == "handoff" && d.Handoff != nil:
			handoffs = append(handoffs, handoffJSON(d.Handoff, ver, ""))
		case d.Kind == "settle" && d.Settle != nil:
			settles = append(settles, settleJSON(d.Settle, ver, ""))
		case d.Kind == "balance" && d.Balance != nil:
			billing = balanceJSON(d.Balance, ver, "")
		}
		e.remember(d)
	}
	slices.Reverse(runs) // newest first, as the lists
	slices.Reverse(projects)
	data := map[string]any{"type": "snapshot", "version": top, "runs": runs}
	if !e.runsOnly {
		data["projects"], data["run_formats"], data["handoffs"], data["settles"], data["billing"] = projects, formats, handoffs, settles, billing
	}
	return e.write(sseEvent{name: "snapshot", id: e.nextID(top), data: data})
}

// remember marks a document as already known to the client.
func (e *eventStream) remember(d store.WatchedDoc) {
	ver := d.Version.UnixMicro()
	switch {
	case d.Kind == "run" && d.Conversion != nil:
		key := runKey(d.ID)
		full, h := e.runJSON(d.Conversion)
		e.sent[key], e.lastFull[key], e.lastState[key] = ver, h, d.Conversion.State
		e.lastProgress[key] = hashOf(progressOf(full))
		if f := e.formatsOf(d.Conversion); f != nil {
			e.lastFormats[key] = hashOf([]any{f, outputNames(d.Conversion)})
		}
	case d.Kind == "project":
		e.sent[projectKey(d.ID)] = ver
		e.trackJobs(d)
	case d.Kind == "handoff":
		e.sent["handoff:"+d.ID] = ver
	case d.Kind == "settle":
		e.sent["settle:"+d.ID] = ver
	case d.Kind == "balance":
		e.sent["balance"] = ver
	}
}

// GET /v1/events — the live stream (see the top of this file). Auth: a
// Firebase ID token or ?ticket=. Old clients keep polling the status
// routes, which are unchanged.
func (s *Service) HandleEventStream(w http.ResponseWriter, r *http.Request) {
	uid, ok := s.eventsUser(r)
	if !ok {
		httpx.WriteErr(r.Context(), w, httpx.ErrUnauthorized())
		return
	}
	specs := []store.WatchSpec{s.Store.UserRuns(uid, eventsRunWindow), s.Store.UserProjects(uid, eventsProjectWindow),
		s.Store.UserHandoffs(uid), s.Store.UserSettles(uid), s.Store.UserBalance(uid)}
	s.rcAttrsActive(r.Context(), r, uid) // web_last_active_at, web_country
	s.serveStream(w, r, specs, false)
}

// POST /v1/admin/events/ticket (admin session) → {ticket, expires_at,
// url}: the console's EventSource ticket, 2 minutes.
func (s *Service) HandleAdminEventsTicket(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	ticket := hex.EncodeToString(b)
	exp := time.Now().UTC().Add(eventsTicketTTL)
	if err := s.Store.PutStreamTicket(ctx, ticket, &store.StreamTicket{UID: a.UID, Admin: a.who(), Scope: "admin", ExpiresAt: exp}); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, map[string]any{"ticket": ticket, "expires_at": exp.Format(time.RFC3339), "url": "/v1/admin/events?ticket=" + ticket})
}

// GET /v1/admin/events?ticket=&(uid=|run_id=|feed=active) — the
// console's stream: snapshot, run.state, run.progress and bye for one
// account's newest runs, one run, or the runs created, paid or processing
// anywhere (at most 100). The ticket comes from POST
// /v1/admin/events/ticket under a passkey session; each open is audited.
func (s *Service) HandleAdminEventStream(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var t *store.StreamTicket
	if s.AdminEventsAuth != nil {
		t = s.AdminEventsAuth(r)
	} else {
		t = s.Store.GetStreamTicket(ctx, r.URL.Query().Get("ticket"), time.Now())
	}
	if t == nil || t.Scope != "admin" {
		httpx.WriteErr(ctx, w, httpx.ErrUnauthorized())
		return
	}
	q := r.URL.Query()
	var spec store.WatchSpec
	filter := map[string]any{}
	switch {
	case q.Get("run_id") != "" && len(q.Get("run_id")) <= 64 && !strings.Contains(q.Get("run_id"), "/"):
		spec, filter["run_id"] = s.Store.OneRun(q.Get("run_id")), q.Get("run_id")
	case q.Get("uid") != "" && len(q.Get("uid")) <= 128:
		spec, filter["uid"] = s.Store.UserRuns(q.Get("uid"), eventsRunWindow), q.Get("uid")
	case q.Get("feed") == "active":
		spec, filter["feed"] = s.Store.ActiveRuns(100), "active"
	default:
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("name a uid, a run_id or feed=active"))
		return
	}
	s.audit(ctx, &AdminUser{UID: t.UID, Email: t.Admin}, "events_stream", filter)
	s.serveStream(w, r, []store.WatchSpec{spec}, true)
}

// serveStream runs one SSE stream over the listeners.
func (s *Service) serveStream(w http.ResponseWriter, r *http.Request, specs []store.WatchSpec, runsOnly bool) {
	timing := s.eventsTiming()
	ctx, cancel := context.WithTimeout(r.Context(), timing.MaxAge)
	defer cancel()
	rc := http.NewResponseController(w)
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if _, err := io.WriteString(w, "retry: 2000\n\n"); err != nil {
		return
	}
	if rc.Flush() != nil {
		return
	}
	lastEventID, _ := strconv.ParseInt(r.Header.Get("Last-Event-ID"), 10, 64)
	if lastEventID == 0 {
		lastEventID, _ = strconv.ParseInt(r.URL.Query().Get("last_event_id"), 10, 64)
	}

	type batch struct {
		docs    []store.WatchedDoc
		spec    int
		initial bool
	}
	batches := make(chan batch, 64)
	watchErr := make(chan error, 1)
	go func() {
		watchErr <- s.Store.Watch(ctx, specs, func(docs []store.WatchedDoc, spec int, initial bool) {
			select {
			case batches <- batch{docs, spec, initial}:
			case <-ctx.Done():
			}
		})
	}()
	es := newEventStream(s, w, rc.Flush)
	es.runsOnly = runsOnly
	defer es.releaseJobs()
	var initial []store.WatchedDoc
	ready := map[int]bool{}
	var early []store.WatchedDoc // changes before every first batch
	hb := time.NewTicker(timing.Heartbeat)
	defer hb.Stop()
	fl := time.NewTicker(timing.Flush)
	defer fl.Stop()
	drain := s.drainCh()
	for {
		select {
		case <-drain: // SIGTERM: reconnect to the next revision soon, not all at once
			_ = es.write(sseEvent{name: "bye", id: es.nextID(0), data: map[string]any{"type": "bye", "reason": "restart", "retry_ms": byeRetryMS()}})
			return
		case <-ctx.Done():
			if r.Context().Err() == nil { // our own max age, not the viewer leaving
				_ = es.write(sseEvent{name: "bye", id: es.nextID(0), data: map[string]any{"type": "bye", "reason": "max_age", "retry_ms": 1000}})
			}
			return
		case err := <-watchErr:
			if err != nil {
				httpx.Log(r.Context()).Warn("events listener ended", "err", err)
				_ = es.write(sseEvent{name: "bye", id: es.nextID(0), data: map[string]any{"type": "bye", "reason": "listener", "retry_ms": 2000}})
			}
			return
		case b := <-batches:
			if len(ready) < len(specs) {
				if b.initial && !ready[b.spec] {
					ready[b.spec] = true
					initial = append(initial, b.docs...)
				} else {
					early = append(early, b.docs...)
				}
				if len(ready) == len(specs) {
					if es.start(initial, lastEventID, time.Now()) != nil {
						return
					}
					for _, d := range early {
						if es.handle(d, time.Now()) != nil {
							return
						}
					}
					early = nil
				}
				continue
			}
			for _, d := range b.docs {
				if es.handle(d, time.Now()) != nil {
					return
				}
			}
		case <-fl.C:
			if len(ready) == len(specs) && es.flushPending(time.Now()) != nil {
				return
			}
		case <-hb.C:
			if _, err := io.WriteString(w, ": hb\n\n"); err != nil || rc.Flush() != nil {
				return
			}
		}
	}
}

// GET /v1/events/probe?seconds=N (public, at most 90): a heartbeat-only
// stream for checking that a path (the HK relay, the load balancer)
// passes SSE unbuffered and keeps it open.
func (s *Service) HandleEventsProbe(w http.ResponseWriter, r *http.Request) {
	secs, _ := strconv.Atoi(r.URL.Query().Get("seconds"))
	secs = min(max(secs, 1), 90)
	rc := http.NewResponseController(w)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	start := time.Now()
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	deadline := time.After(time.Duration(secs) * time.Second)
	fmt.Fprintf(w, "event: probe\ndata: {\"t\":0}\n\n")
	_ = rc.Flush()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-deadline:
			fmt.Fprintf(w, "event: bye\ndata: {\"t\":%d}\n\n", int(time.Since(start).Seconds()))
			_ = rc.Flush()
			return
		case <-t.C:
			fmt.Fprintf(w, "event: probe\ndata: {\"t\":%d}\n\n", int(time.Since(start).Seconds()))
			if rc.Flush() != nil {
				return
			}
		}
	}
}
