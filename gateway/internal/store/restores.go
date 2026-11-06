package store

import (
	"context"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Restore Purchases (web, owner 2026-11-06): one audit row per restore in
// restores_{env}/{auto}, and a per-account window in
// restore_limits_{env}/{uid} (the counter holds across instances).

// Restore is one restore's audit row.
type Restore struct {
	UID      string    `firestore:"uid"`
	Kind     string    `firestore:"kind"` // resync (moves come later)
	At       time.Time `firestore:"at"`
	Restored bool      `firestore:"restored"`
	Repaired []string  `firestore:"repaired"`
	// What was looked at: Stripe customers (the account's and any other
	// carrying its uid), our subscriptions on them, invoices applied
	// again, promotional records taken up again.
	Customers      int      `firestore:"customers"`
	OtherCustomers int      `firestore:"other_customers"`
	Subscriptions  int      `firestore:"subscriptions"`
	Invoices       []string `firestore:"invoices,omitempty"`
	PromoRecords   []string `firestore:"promo_records,omitempty"`
	Errors         []string `firestore:"errors,omitempty"`
	IPHash         string   `firestore:"ip_hash,omitempty"`
}

func restoresCol(env string) string      { return "restores_" + env }
func restoreLimitsCol(env string) string { return "restore_limits_" + env }

// AddRestore writes a restore's audit row.
func (s *Store) AddRestore(ctx context.Context, r *Restore) error {
	_, _, err := s.fs.Collection(restoresCol(s.env)).Add(ctx, r)
	return err
}

// ListUserRestores is an account's restores (by uid alone, no composite
// index), at most limit.
func (s *Store) ListUserRestores(ctx context.Context, uid string, limit int) ([]*Restore, error) {
	snaps, err := s.fs.Collection(restoresCol(s.env)).Where("uid", "==", uid).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]*Restore, 0, len(snaps))
	for _, snap := range snaps {
		var r Restore
		if snap.DataTo(&r) == nil {
			out = append(out, &r)
		}
	}
	return out, nil
}

type restoreWindow struct {
	Start time.Time `firestore:"start"`
	Count int       `firestore:"count"`
}

// AllowRestore counts one restore for uid in a fixed window of length
// window starting at its first restore; false (and how long until the
// window ends) once max have been made in it.
func (s *Store) AllowRestore(ctx context.Context, uid string, max int, window time.Duration, now time.Time) (bool, time.Duration, error) {
	ref := s.fs.Collection(restoreLimitsCol(s.env)).Doc(uid)
	allowed, wait := false, time.Duration(0)
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		var w restoreWindow
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
			w = restoreWindow{Start: now}
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
