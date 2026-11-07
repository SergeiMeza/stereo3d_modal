package store

import (
	"context"
	"time"

	"cloud.google.com/go/firestore"
)

// RCAttrSync is rc_attr_sync_{env}/{uid}: an account's RevenueCat
// attributes waiting to go (debounced), and what was last sent.
type RCAttrSync struct {
	UID          string            `firestore:"uid"`
	DueAt        *time.Time        `firestore:"due_at"`
	Reasons      []string          `firestore:"reasons,omitempty"`
	Clear        bool              `firestore:"clear,omitempty"` // the account was deleted: remove the web_* attributes
	LastActiveAt *time.Time        `firestore:"last_active_at,omitempty"`
	Country      string            `firestore:"country,omitempty"` // the last web visit's country (from the edge, never the IP)
	Sent         map[string]string `firestore:"sent,omitempty"`    // name → value last sent (a hash for the personal ones)
	SentAt       *time.Time        `firestore:"sent_at,omitempty"`
	Mode         string            `firestore:"mode,omitempty"` // how the last sync went: sent | dry_run
	LastError    string            `firestore:"last_error,omitempty"`
	Attempts     int               `firestore:"attempts,omitempty"`
}

func rcAttrCol(env string) string { return "rc_attr_sync_" + env }

func (s *Store) rcAttrDoc(uid string) *firestore.DocumentRef {
	return s.fs.Collection(rcAttrCol(s.env)).Doc(uid)
}

// TouchRCAttrs marks an account's attributes due after the debounce
// (a later change pushes it back), with what changed.
func (s *Store) TouchRCAttrs(ctx context.Context, uid, reason string, due time.Time, extra map[string]any) error {
	data := map[string]any{"uid": uid, "due_at": due, "reasons": firestore.ArrayUnion(reason)}
	for k, v := range extra {
		data[k] = v
	}
	_, err := s.rcAttrDoc(uid).Set(ctx, data, firestore.MergeAll)
	return err
}

// GetRCAttrSync reads an account's sync record (nil when none).
func (s *Store) GetRCAttrSync(ctx context.Context, uid string) *RCAttrSync {
	snap, err := s.rcAttrDoc(uid).Get(ctx)
	if err != nil {
		return nil
	}
	var r RCAttrSync
	if snap.DataTo(&r) != nil {
		return nil
	}
	return &r
}

// ClaimDueRCAttrs takes up to limit due records, moving each one's due
// time a lease ahead so no other sweep takes it meanwhile.
func (s *Store) ClaimDueRCAttrs(ctx context.Context, now time.Time, lease time.Duration, limit int) ([]*RCAttrSync, error) {
	snaps, err := s.fs.Collection(rcAttrCol(s.env)).Where("due_at", "<=", now).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	var out []*RCAttrSync
	for _, snap := range snaps {
		var got *RCAttrSync
		terr := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
			got = nil
			fresh, err := tx.Get(snap.Ref)
			if err != nil {
				return err
			}
			var r RCAttrSync
			if err := fresh.DataTo(&r); err != nil {
				return err
			}
			if r.DueAt == nil || r.DueAt.After(now) {
				return nil // pushed back or taken
			}
			next := now.Add(lease)
			got = &r
			return tx.Update(snap.Ref, []firestore.Update{{Path: "due_at", Value: next}})
		})
		if terr == nil && got != nil {
			out = append(out, got)
		}
	}
	return out, nil
}

// FinishRCAttrSync records a sync: done (due_at cleared unless a change
// came meanwhile, i.e. due_at moved past the lease), or failed (retried).
func (s *Store) FinishRCAttrSync(ctx context.Context, uid string, leaseEnd time.Time, mutate func(r *RCAttrSync)) error {
	return s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(s.rcAttrDoc(uid))
		if err != nil {
			return err
		}
		var r RCAttrSync
		if err := snap.DataTo(&r); err != nil {
			return err
		}
		touched := r.DueAt != nil && !r.DueAt.Equal(leaseEnd) // a change after the claim: go again
		mutate(&r)
		if touched && r.DueAt == nil {
			due := time.Now().UTC()
			r.DueAt = &due
		}
		return tx.Set(s.rcAttrDoc(uid), &r)
	})
}
