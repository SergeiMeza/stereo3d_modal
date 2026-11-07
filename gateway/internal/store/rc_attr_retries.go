package store

import (
	"context"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// RCAttrRetry is rc_attr_retries_{env}/{uid}: a RevenueCat attribute write
// that failed (D14's web plan marker) and is tried again by the
// reconciler. At is the write's own time, sent again as updated_at_ms, so
// a retry never wins over a later write; one record per uid, the latest
// write's.
type RCAttrRetry struct {
	UID       string            `firestore:"-"`
	Attrs     map[string]string `firestore:"attrs"`
	At        time.Time         `firestore:"at"`
	Attempts  int               `firestore:"attempts"`
	NextAt    time.Time         `firestore:"next_at"`
	LastError string            `firestore:"last_error,omitempty"`
	Alerted   bool              `firestore:"alerted,omitempty"`
	CreatedAt time.Time         `firestore:"created_at"`
}

func rcAttrRetriesCol(env string) string { return "rc_attr_retries_" + env }

// QueueRCAttrRetry records a failed write of attrs made at `at`. A record
// for a later write is kept as it is (false); an earlier one is replaced,
// its keys the new write doesn't set carried over.
func (s *Store) QueueRCAttrRetry(ctx context.Context, uid string, attrs map[string]string, at time.Time, errText string, nextAt time.Time) (bool, error) {
	ref := s.fs.Collection(rcAttrRetriesCol(s.env)).Doc(uid)
	queued := false
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		queued = false
		merged := map[string]string{}
		snap, err := tx.Get(ref)
		switch {
		case status.Code(err) == codes.NotFound:
		case err != nil:
			return err
		default:
			var old RCAttrRetry
			if err := snap.DataTo(&old); err != nil {
				return err
			}
			if old.At.After(at) {
				return nil // a later write is already waiting
			}
			for k, v := range old.Attrs {
				merged[k] = v
			}
		}
		for k, v := range attrs {
			merged[k] = v
		}
		queued = true
		return tx.Set(ref, &RCAttrRetry{Attrs: merged, At: at.UTC(), NextAt: nextAt.UTC(), LastError: errText, CreatedAt: time.Now().UTC()})
	})
	return queued, err
}

// ListDueRCAttrRetries returns the retries due at now.
func (s *Store) ListDueRCAttrRetries(ctx context.Context, now time.Time, limit int) ([]*RCAttrRetry, error) {
	iter := s.fs.Collection(rcAttrRetriesCol(s.env)).Where("next_at", "<=", now.UTC()).Limit(limit).Documents(ctx)
	defer iter.Stop()
	var out []*RCAttrRetry
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		var r RCAttrRetry
		if err := snap.DataTo(&r); err != nil {
			return nil, err
		}
		r.UID = snap.Ref.ID
		out = append(out, &r)
	}
}

// GetRCAttrRetry returns uid's waiting retry (nil when none).
func (s *Store) GetRCAttrRetry(ctx context.Context, uid string) (*RCAttrRetry, error) {
	snap, err := s.fs.Collection(rcAttrRetriesCol(s.env)).Doc(uid).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var r RCAttrRetry
	if err := snap.DataTo(&r); err != nil {
		return nil, err
	}
	r.UID = uid
	return &r, nil
}

// DoneRCAttrRetry removes uid's retry once a write made at `at` or later
// went through (a record for a later write stays).
func (s *Store) DoneRCAttrRetry(ctx context.Context, uid string, at time.Time) error {
	ref := s.fs.Collection(rcAttrRetriesCol(s.env)).Doc(uid)
	return s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(ref)
		if status.Code(err) == codes.NotFound {
			return nil
		}
		if err != nil {
			return err
		}
		var r RCAttrRetry
		if err := snap.DataTo(&r); err != nil {
			return err
		}
		if r.At.After(at) {
			return nil
		}
		return tx.Delete(ref)
	})
}

// FailRCAttrRetry records another failed attempt of the retry made at
// `at` (nothing when the record is for another write by now).
func (s *Store) FailRCAttrRetry(ctx context.Context, uid string, at time.Time, errText string, nextAt time.Time, alerted bool) error {
	ref := s.fs.Collection(rcAttrRetriesCol(s.env)).Doc(uid)
	return s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(ref)
		if status.Code(err) == codes.NotFound {
			return nil
		}
		if err != nil {
			return err
		}
		var r RCAttrRetry
		if err := snap.DataTo(&r); err != nil {
			return err
		}
		if !r.At.Equal(at) {
			return nil
		}
		r.Attempts++
		r.LastError, r.NextAt = errText, nextAt.UTC()
		r.Alerted = r.Alerted || alerted
		return tx.Set(ref, &r)
	})
}
