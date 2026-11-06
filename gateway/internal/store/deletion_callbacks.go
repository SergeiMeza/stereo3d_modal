package store

import (
	"context"
	"errors"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// The app-path deletion hand-off (agreed with svs-app 2026-11-07): when a
// deletion asked through svs-backend (keep_sign_in) completes later (the
// 48-hour sweep, the console's "Process now", a decided refund case), the
// gateway tells svs-backend so it can run its own cleanup. One outbox row
// per account in account_deletion_callbacks_{env}/{uid}, retried until a
// 2xx; the rows are also the backstop read's answer.

// Callback states.
const (
	CallbackPending = "pending"
	CallbackSent    = "sent"
	CallbackFailed  = "failed" // gave up after the retry window; the backstop read still lists it
)

// DeletionCallback is one completed app-path deletion to report.
type DeletionCallback struct {
	UID           string     `firestore:"uid" json:"uid"`
	Environment   string     `firestore:"environment" json:"environment"`
	RequestedAt   time.Time  `firestore:"requested_at" json:"requested_at"`
	CompletedAt   time.Time  `firestore:"completed_at" json:"completed_at"`
	Via           string     `firestore:"via" json:"via"` // sweep | admin | refund_case
	State         string     `firestore:"state" json:"-"`
	Attempts      int        `firestore:"attempts" json:"-"`
	NextAttemptAt time.Time  `firestore:"next_attempt_at" json:"-"`
	LastError     string     `firestore:"last_error,omitempty" json:"-"`
	SentAt        *time.Time `firestore:"sent_at,omitempty" json:"-"`
}

func deletionCallbacksCol(env string) string { return "account_deletion_callbacks_" + env }

// EnqueueDeletionCallback records a completion once (a second one for the
// same account is ignored: created false).
func (s *Store) EnqueueDeletionCallback(ctx context.Context, c *DeletionCallback) (bool, error) {
	c.State, c.NextAttemptAt = CallbackPending, c.CompletedAt
	_, err := s.fs.Collection(deletionCallbacksCol(s.env)).Doc(c.UID).Create(ctx, c)
	if status.Code(err) == codes.AlreadyExists {
		return false, nil
	}
	return err == nil, err
}

// GetDeletionCallback reads an account's callback row.
func (s *Store) GetDeletionCallback(ctx context.Context, uid string) (*DeletionCallback, error) {
	snap, err := s.fs.Collection(deletionCallbacksCol(s.env)).Doc(uid).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var c DeletionCallback
	if err := snap.DataTo(&c); err != nil {
		return nil, err
	}
	return &c, nil
}

// ListPendingDeletionCallbacks is the rows still to send (single-field
// index; the caller checks next_attempt_at).
func (s *Store) ListPendingDeletionCallbacks(ctx context.Context, limit int) ([]*DeletionCallback, error) {
	return s.listCallbacks(s.fs.Collection(deletionCallbacksCol(s.env)).Where("state", "==", CallbackPending).Limit(limit), ctx)
}

// ListCompletedDeletions is every app-path completion at or after since,
// oldest first (the backstop read).
func (s *Store) ListCompletedDeletions(ctx context.Context, since time.Time, limit int) ([]*DeletionCallback, error) {
	return s.listCallbacks(s.fs.Collection(deletionCallbacksCol(s.env)).Where("completed_at", ">=", since).
		OrderBy("completed_at", firestore.Asc).Limit(limit), ctx)
}

func (s *Store) listCallbacks(q firestore.Query, ctx context.Context) ([]*DeletionCallback, error) {
	snaps, err := q.Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]*DeletionCallback, 0, len(snaps))
	for _, sn := range snaps {
		var c DeletionCallback
		if sn.DataTo(&c) == nil {
			out = append(out, &c)
		}
	}
	return out, nil
}

// errCallbackNotDue: another sender has it, or it isn't due.
var errCallbackNotDue = errors.New("callback not due")

// ClaimDeletionCallback leases a due pending row for one send (the next
// attempt moves lease ahead); ok false when it isn't due or isn't pending.
func (s *Store) ClaimDeletionCallback(ctx context.Context, uid string, now time.Time, lease time.Duration) (*DeletionCallback, bool, error) {
	ref := s.fs.Collection(deletionCallbacksCol(s.env)).Doc(uid)
	var out *DeletionCallback
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(ref)
		if err != nil {
			return err
		}
		var c DeletionCallback
		if err := snap.DataTo(&c); err != nil {
			return err
		}
		if c.State != CallbackPending || now.Before(c.NextAttemptAt) {
			return errCallbackNotDue
		}
		c.Attempts++
		c.NextAttemptAt = now.Add(lease)
		out = &c
		return tx.Set(ref, &c)
	})
	if errors.Is(err, errCallbackNotDue) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return out, true, nil
}

// FinishDeletionCallback records a send's outcome: sent, or the next try
// (failed when giveUp).
func (s *Store) FinishDeletionCallback(ctx context.Context, uid string, sent bool, next time.Time, lastErr string, giveUp bool, now time.Time) error {
	ups := []firestore.Update{{Path: "last_error", Value: lastErr}}
	switch {
	case sent:
		ups = append(ups, firestore.Update{Path: "state", Value: CallbackSent}, firestore.Update{Path: "sent_at", Value: now})
	case giveUp:
		ups = append(ups, firestore.Update{Path: "state", Value: CallbackFailed})
	default:
		ups = append(ups, firestore.Update{Path: "next_attempt_at", Value: next})
	}
	_, err := s.fs.Collection(deletionCallbacksCol(s.env)).Doc(uid).Update(ctx, ups)
	return err
}
