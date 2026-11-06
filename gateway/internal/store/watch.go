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
	Kind       string // run | project
	Conversion *Conversion
	Project    *Project
	Removed    bool      // left the window (or deleted for good)
	ID         string    // the document id
	Version    time.Time // the document's update time
}

// WatchUser streams the account's newest runs and projects: the first
// batch of each is everything in the window (initial true), then the
// changes. It ends when ctx ends or a listener fails (the error).
func (s *Store) WatchUser(ctx context.Context, uid string, runs, projects int, out func(docs []WatchedDoc, kind string, initial bool)) error {
	errc := make(chan error, 2)
	listen := func(kind string, q firestore.Query) {
		it := q.Snapshots(ctx)
		defer it.Stop()
		first := true
		for {
			snap, err := it.Next()
			if err != nil {
				if ctx.Err() != nil || status.Code(err) == codes.Canceled {
					errc <- nil
				} else {
					errc <- err
				}
				return
			}
			var docs []WatchedDoc
			for _, ch := range snap.Changes {
				d := WatchedDoc{Kind: kind, ID: ch.Doc.Ref.ID, Version: ch.Doc.UpdateTime, Removed: ch.Kind == firestore.DocumentRemoved}
				if !d.Removed {
					switch kind {
					case "run":
						c, err := snapToConversion(ch.Doc)
						if err != nil {
							continue
						}
						d.Conversion = c
					default:
						var p Project
						if ch.Doc.DataTo(&p) != nil {
							continue
						}
						p.ID = ch.Doc.Ref.ID
						d.Project = &p
					}
				}
				docs = append(docs, d)
			}
			out(docs, kind, first)
			first = false
		}
	}
	go listen("run", s.fs.Collection(conversionsCol(s.env)).Where("uid", "==", uid).OrderBy("created_at", firestore.Desc).Limit(runs))
	go listen("project", s.fs.Collection(projectsCol(s.env)).Where("uid", "==", uid).OrderBy("created_at", firestore.Desc).Limit(projects))
	var first error
	for range 2 {
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
}

func streamTicketsCol(env string) string { return "stream_tickets_" + env }

func ticketDoc(ticket string) string {
	sum := sha256.Sum256([]byte("stream-ticket:" + ticket))
	return hex.EncodeToString(sum[:])
}

// PutStreamTicket stores a ticket (by its hash, never the value).
func (s *Store) PutStreamTicket(ctx context.Context, ticket, uid string, expires time.Time) error {
	_, err := s.fs.Collection(streamTicketsCol(s.env)).Doc(ticketDoc(ticket)).Set(ctx, &StreamTicket{UID: uid, ExpiresAt: expires})
	return err
}

// StreamTicketUID is the account a live ticket belongs to ("" when it's
// unknown or expired).
func (s *Store) StreamTicketUID(ctx context.Context, ticket string, now time.Time) string {
	if ticket == "" || len(ticket) > 128 {
		return ""
	}
	snap, err := s.fs.Collection(streamTicketsCol(s.env)).Doc(ticketDoc(ticket)).Get(ctx)
	if err != nil {
		return ""
	}
	var t StreamTicket
	if snap.DataTo(&t) != nil || !now.Before(t.ExpiresAt) {
		return ""
	}
	return t.UID
}
