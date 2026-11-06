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
//	event: bye              {type, reason: "max_age", retry_ms}
//	: hb                    (a comment every 20 s)
//
// Run is GET /v1/conversions/{id}'s answer, Project GET /v1/projects/{id}'s
// without its conversions. version is the document's update time in
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
	if err := s.Store.PutStreamTicket(ctx, ticket, user.UID, exp); err != nil {
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
}

func newEventStream(s *Service, w io.Writer, flush func() error) *eventStream {
	return &eventStream{s: s, w: w, flush: flush, sent: map[string]int64{}, lastFull: map[string]string{},
		lastState: map[string]string{}, progressAt: map[string]time.Time{}, pending: map[string]*store.WatchedDoc{}}
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
		if d.Removed || d.Conversion == nil || ver <= e.sent[key] {
			return nil // left the window, a duplicate, or older than what was sent
		}
		c := d.Conversion
		full, restHash := e.runJSON(c)
		prev, seen := e.lastFull[key]
		if seen && prev == restHash && e.lastState[key] == c.State {
			if now.Sub(e.progressAt[key]) < eventsProgressGap {
				dd := d
				e.pending[key] = &dd // the latest wins
				return nil
			}
			return e.sendProgress(key, c, full, ver, now)
		}
		delete(e.pending, key)
		e.sent[key], e.lastFull[key], e.lastState[key] = ver, restHash, c.State
		return e.write(sseEvent{name: "run.state", id: e.nextID(ver), data: map[string]any{"type": "run.state", "run_id": c.ID,
			"project_id": c.ProjectID, "version": ver, "state": c.State, "run": full}})
	case "project":
		key := projectKey(d.ID)
		if d.Removed || d.Project == nil || ver <= e.sent[key] {
			return nil
		}
		e.sent[key] = ver
		return e.write(sseEvent{name: "project.updated", id: e.nextID(ver), data: map[string]any{"type": "project.updated",
			"project_id": d.Project.ID, "version": ver, "deleted": d.Project.Deleted, "project": e.projectJSON(d.Project)}})
	}
	return nil
}

func (e *eventStream) sendProgress(key string, c *store.Conversion, full map[string]any, ver int64, now time.Time) error {
	e.sent[key], e.progressAt[key] = ver, now
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
	var top int64
	for _, d := range initial {
		top = max(top, d.Version.UnixMicro())
		switch {
		case d.Kind == "run" && d.Conversion != nil:
			full, _ := e.runJSON(d.Conversion)
			runs = append(runs, full)
		case d.Kind == "project" && d.Project != nil:
			projects = append(projects, e.projectJSON(d.Project))
		}
		e.remember(d)
	}
	slices.Reverse(runs) // newest first, as the lists
	slices.Reverse(projects)
	return e.write(sseEvent{name: "snapshot", id: e.nextID(top), data: map[string]any{"type": "snapshot", "version": top,
		"runs": runs, "projects": projects}})
}

// remember marks a document as already known to the client.
func (e *eventStream) remember(d store.WatchedDoc) {
	ver := d.Version.UnixMicro()
	switch {
	case d.Kind == "run" && d.Conversion != nil:
		key := runKey(d.ID)
		_, h := e.runJSON(d.Conversion)
		e.sent[key], e.lastFull[key], e.lastState[key] = ver, h, d.Conversion.State
	case d.Kind == "project":
		e.sent[projectKey(d.ID)] = ver
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
		kind    string
		initial bool
	}
	batches := make(chan batch, 64)
	watchErr := make(chan error, 1)
	go func() {
		watchErr <- s.Store.WatchUser(ctx, uid, eventsRunWindow, eventsProjectWindow, func(docs []store.WatchedDoc, kind string, initial bool) {
			select {
			case batches <- batch{docs, kind, initial}:
			case <-ctx.Done():
			}
		})
	}()
	es := newEventStream(s, w, rc.Flush)
	var initial []store.WatchedDoc
	ready := map[string]bool{}
	var early []store.WatchedDoc // changes before both first batches
	hb := time.NewTicker(timing.Heartbeat)
	defer hb.Stop()
	fl := time.NewTicker(timing.Flush)
	defer fl.Stop()
	for {
		select {
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
			if len(ready) < 2 {
				if b.initial && !ready[b.kind] {
					ready[b.kind] = true
					initial = append(initial, b.docs...)
				} else {
					early = append(early, b.docs...)
				}
				if len(ready) == 2 {
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
			if len(ready) == 2 && es.flushPending(time.Now()) != nil {
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
