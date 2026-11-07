package store

import (
	"context"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Customer support requests (refund requests from Billing, owner
// 2026-11-06): per-account windows in support_limits_{env}/{key} (the
// count holds across instances).

type supportWindow struct {
	Start time.Time `firestore:"start"`
	Count int       `firestore:"count"`
}

func supportLimitsCol(env string) string { return "support_limits_" + env }

// AllowSupport counts one use of key in a fixed window of length window
// from its first use; false (and how long until the window ends) once
// max have been used in it.
func (s *Store) AllowSupport(ctx context.Context, key string, max int, window time.Duration, now time.Time) (bool, time.Duration, error) {
	ref := s.fs.Collection(supportLimitsCol(s.env)).Doc(key)
	allowed, wait := false, time.Duration(0)
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		var w supportWindow
		snap, err := tx.Get(ref)
		switch {
		case status.Code(err) == codes.NotFound:
		case err != nil:
			return err
		default:
			if err := snap.DataTo(&w); err != nil {
				return err
			}
		}
		if w.Start.IsZero() || now.Sub(w.Start) >= window {
			w = supportWindow{Start: now}
		}
		if w.Count >= max {
			allowed, wait = false, w.Start.Add(window).Sub(now)
			return nil
		}
		w.Count++
		allowed = true
		return tx.Set(ref, w)
	})
	return allowed, wait, err
}
