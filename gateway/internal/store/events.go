package store

import (
	"context"
	"time"

	"cloud.google.com/go/firestore"
)

// Product events (owner 2026-11-04): events_{env}/{auto_id}, our own
// first-party events from the web (POST /v1/events), each with the uid
// and the time. Only allow-listed names are stored (api/events.go).
type Event struct {
	UID   string         `firestore:"uid" json:"-"`
	Name  string         `firestore:"name" json:"name"`
	Props map[string]any `firestore:"props,omitempty" json:"props,omitempty"`
	At    time.Time      `firestore:"at" json:"at"`
}

func eventsCol(env string) string { return "events_" + env }

// AddEvent stores one event.
func (s *Store) AddEvent(ctx context.Context, e Event) error {
	_, _, err := s.fs.Collection(eventsCol(s.env)).Add(ctx, e)
	return err
}

// ListEventsSince is every event named name since t, oldest first. It
// queries on the time alone (no composite index) and filters the name.
func (s *Store) ListEventsSince(ctx context.Context, name string, since time.Time, limit int) ([]Event, error) {
	snaps, err := s.fs.Collection(eventsCol(s.env)).Where("at", ">=", since).OrderBy("at", firestore.Asc).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]Event, 0, len(snaps))
	for _, sn := range snaps {
		var e Event
		if sn.DataTo(&e) == nil && e.Name == name {
			out = append(out, e)
		}
	}
	return out, nil
}
