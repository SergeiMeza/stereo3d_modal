package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Live updates for the web (SSE, GET /v1/events): each open stream holds
// a Firestore listener on its account's newest runs and projects (uid ==
// X), the same queries the lists use, so whatever writes a run or a
// project (Modal progress, the reconciler, the webhooks) reaches every
// stream on any instance.

// WatchedDoc is one change a listener reports.
type WatchedDoc struct {
	Kind       string // run | project | handoff | settle | balance
	Conversion *Conversion
	Project    *Project
	Handoff    *Handoff
	Settle     *Settle
	Balance    *Balance
	Removed    bool      // left the window (or deleted for good)
	ID         string    // the document id
	Version    time.Time // the document's update time
}

// WatchSpec is one listener: a query or a single document, of a kind.
type WatchSpec struct {
	Kind string
	q    *firestore.Query
	doc  *firestore.DocumentRef
}

func (s *Store) querySpec(kind string, q firestore.Query) WatchSpec {
	return WatchSpec{Kind: kind, q: &q}
}

// UserRuns: the account's newest runs (the list's index).
func (s *Store) UserRuns(uid string, n int) WatchSpec {
	return s.querySpec("run", s.fs.Collection(conversionsCol(s.env)).Where("uid", "==", uid).OrderBy("created_at", firestore.Desc).Limit(n))
}

// UserProjects: the account's newest projects.
func (s *Store) UserProjects(uid string, n int) WatchSpec {
	return s.querySpec("project", s.fs.Collection(projectsCol(s.env)).Where("uid", "==", uid).OrderBy("created_at", firestore.Desc).Limit(n))
}

// UserHandoffs: the account's hand-off codes (uid only: a single-field
// index; an account has a handful).
func (s *Store) UserHandoffs(uid string) WatchSpec {
	return s.querySpec("handoff", s.fs.Collection(handoffsCol(s.env)).Where("uid", "==", uid))
}

// UserSettles: the account's settles (uid only, a handful).
func (s *Store) UserSettles(uid string) WatchSpec {
	return s.querySpec("settle", s.fs.Collection(settlesCol(s.env)).Where("uid", "==", uid))
}

// UserBalance: the account's balance document.
func (s *Store) UserBalance(uid string) WatchSpec {
	return WatchSpec{Kind: "balance", doc: s.fs.Collection(balancesCol(s.env)).Doc(uid)}
}

// OneRun: a single run (the console's run view).
func (s *Store) OneRun(id string) WatchSpec {
	return WatchSpec{Kind: "run", doc: s.convDoc(id)}
}

// ActiveRuns: runs created, paid or processing, any account (the
// console's recent-active feed; a single-field index on state).
func (s *Store) ActiveRuns(n int) WatchSpec {
	return s.querySpec("run", s.fs.Collection(conversionsCol(s.env)).Where("state", "in", []string{StateCreated, StatePaid, StateProcessing}).Limit(n))
}

func decodeWatched(kind string, snap *firestore.DocumentSnapshot) (WatchedDoc, bool) {
	d := WatchedDoc{Kind: kind, ID: snap.Ref.ID, Version: snap.UpdateTime}
	if !snap.Exists() {
		d.Removed = true
		return d, true
	}
	switch kind {
	case "run":
		c, err := snapToConversion(snap)
		if err != nil {
			return d, false
		}
		d.Conversion = c
	case "project":
		var p Project
		if snap.DataTo(&p) != nil {
			return d, false
		}
		p.ID = snap.Ref.ID
		d.Project = &p
	case "handoff":
		var h Handoff
		if snap.DataTo(&h) != nil {
			return d, false
		}
		h.Code = snap.Ref.ID
		d.Handoff = &h
	case "settle":
		var st Settle
		if snap.DataTo(&st) != nil {
			return d, false
		}
		st.ID = snap.Ref.ID
		d.Settle = &st
	case "balance":
		var b Balance
		if snap.DataTo(&b) != nil {
			return d, false
		}
		d.Balance = &b
	}
	return d, true
}

// Watch runs the listeners: each one's first batch is everything in it
// (initial true), then its changes. It ends when ctx ends or a listener
// fails (the error).
func (s *Store) Watch(ctx context.Context, specs []WatchSpec, out func(docs []WatchedDoc, spec int, initial bool)) error {
	errc := make(chan error, len(specs))
	done := func(err error) {
		if err == nil || ctx.Err() != nil || status.Code(err) == codes.Canceled {
			errc <- nil
			return
		}
		errc <- err
	}
	for i, sp := range specs {
		go func() {
			first := true
			if sp.doc != nil {
				it := sp.doc.Snapshots(ctx)
				defer it.Stop()
				for {
					snap, err := it.Next()
					if err != nil {
						done(err)
						return
					}
					var docs []WatchedDoc
					if snap.Exists() || !first {
						if d, ok := decodeWatched(sp.Kind, snap); ok {
							docs = append(docs, d)
						}
					}
					out(docs, i, first)
					first = false
				}
			}
			it := sp.q.Snapshots(ctx)
			defer it.Stop()
			for {
				snap, err := it.Next()
				if err != nil {
					done(err)
					return
				}
				var docs []WatchedDoc
				for _, ch := range snap.Changes {
					if ch.Kind == firestore.DocumentRemoved {
						docs = append(docs, WatchedDoc{Kind: sp.Kind, ID: ch.Doc.Ref.ID, Version: ch.Doc.UpdateTime, Removed: true})
						continue
					}
					if d, ok := decodeWatched(sp.Kind, ch.Doc); ok {
						docs = append(docs, d)
					}
				}
				out(docs, i, first)
				first = false
			}
		}()
	}
	var first error
	for range specs {
		if err := <-errc; err != nil && first == nil {
			first = err
		}
	}
	return first
}

// StreamTicket lets a browser's EventSource (which can't send an
// Authorization header) open its stream: an opaque value from POST
// /v1/events/ticket, bound to the account, good for a short while (so
// EventSource's own reconnects within it work).
type StreamTicket struct {
	UID       string    `firestore:"uid"`
	ExpiresAt time.Time `firestore:"expires_at"`
	// Scope: "" (the viewer's own stream) or "admin" (the console's, UID
	// the admin; Admin their email, for the audit).
	Scope string `firestore:"scope,omitempty"`
	Admin string `firestore:"admin,omitempty"`
}

func streamTicketsCol(env string) string { return "stream_tickets_" + env }

func ticketDoc(ticket string) string {
	sum := sha256.Sum256([]byte("stream-ticket:" + ticket))
	return hex.EncodeToString(sum[:])
}

// PutStreamTicket stores a ticket (by its hash, never the value).
func (s *Store) PutStreamTicket(ctx context.Context, ticket string, t *StreamTicket) error {
	_, err := s.fs.Collection(streamTicketsCol(s.env)).Doc(ticketDoc(ticket)).Set(ctx, t)
	return err
}

// GetStreamTicket is a live ticket (nil when unknown or expired).
func (s *Store) GetStreamTicket(ctx context.Context, ticket string, now time.Time) *StreamTicket {
	if ticket == "" || len(ticket) > 128 {
		return nil
	}
	snap, err := s.fs.Collection(streamTicketsCol(s.env)).Doc(ticketDoc(ticket)).Get(ctx)
	if err != nil {
		return nil
	}
	var t StreamTicket
	if snap.DataTo(&t) != nil || !now.Before(t.ExpiresAt) {
		return nil
	}
	return &t
}

// StreamTicketUID is the account a live viewer ticket belongs to ("" when
// it's unknown, expired or an admin's).
func (s *Store) StreamTicketUID(ctx context.Context, ticket string, now time.Time) string {
	t := s.GetStreamTicket(ctx, ticket, now)
	if t == nil || t.Scope != "" {
		return ""
	}
	return t.UID
}

// GetRun reads one run as a watched document (its update time as the
// version): the console's active feed reads a run that just left it.
func (s *Store) GetRun(ctx context.Context, id string) (WatchedDoc, bool) {
	snap, err := s.convDoc(id).Get(ctx)
	if err != nil {
		return WatchedDoc{}, false
	}
	return decodeWatched("run", snap)
}
