package store

import (
	"context"
	"time"
)

// OffSessionRetry is a failed web off-session charge's retry schedule (D2,
// owner 2026-11-07): soft declines are tried again at +24 h and +72 h
// after the first failure (do_not_honor once), then stop; a bank check,
// a hard decline, a stop code or a configuration error is never retried.
// It sits on the failed record (a reload's top-up, a deletion's dues).
type OffSessionRetry struct {
	State string `firestore:"state" json:"state"` // RetryPending | RetryFinal | RetryPaid | RetryCanceled
	// Reason: why it stopped or keeps trying: soft_decline |
	// authentication_required | hard_decline | stop_code | config.
	Reason        string     `firestore:"reason" json:"reason"`
	Attempts      int        `firestore:"attempts" json:"attempts"` // charges tried, the first included
	MaxAttempts   int        `firestore:"max_attempts" json:"max_attempts"`
	AmountCents   int64      `firestore:"amount_cents" json:"amount_cents"`
	FirstFailedAt time.Time  `firestore:"first_failed_at" json:"first_failed_at"`
	LastFailedAt  time.Time  `firestore:"last_failed_at" json:"last_failed_at"`
	NextAttemptAt *time.Time `firestore:"next_attempt_at,omitempty" json:"next_attempt_at"`
	FinalAt       *time.Time `firestore:"final_at,omitempty" json:"final_at"`
	ClosedAt      *time.Time `firestore:"closed_at,omitempty" json:"-"`
	LastCode      string     `firestore:"last_code,omitempty" json:"-"`
	// LastDeclineCode is Stripe's decline code; LastErrorMessage the
	// customer-safe sentence mapped from it (never Stripe's text).
	LastDeclineCode  string `firestore:"last_decline_code,omitempty" json:"last_decline_code,omitempty"`
	LastErrorMessage string `firestore:"last_error_message,omitempty" json:"last_error_message,omitempty"`
	CloseReason      string `firestore:"close_reason,omitempty" json:"-"`
	PayRequestID     string `firestore:"pay_request_id,omitempty" json:"-"`
}

// Retry states.
const (
	RetryPending  = "pending"
	RetryFinal    = "final"
	RetryPaid     = "paid"
	RetryCanceled = "canceled"
)

// Due reports a pending retry whose time has come.
func (r *OffSessionRetry) Due(now time.Time) bool {
	return r != nil && r.State == RetryPending && r.NextAttemptAt != nil && !now.Before(*r.NextAttemptAt)
}

// ListTopupsByRetryState lists top-ups whose retry is in state (the sweep
// reads pending ones; one equality, no composite index).
func (s *Store) ListTopupsByRetryState(ctx context.Context, state string, limit int) ([]*Topup, error) {
	iter := s.fs.Collection(topupsCol(s.env)).Where("retry.state", "==", state).Limit(limit).Documents(ctx)
	defer iter.Stop()
	var out []*Topup
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		var t Topup
		if err := snap.DataTo(&t); err != nil {
			return nil, err
		}
		t.ID = snap.Ref.ID
		out = append(out, &t)
	}
}

// ListUserReloadRetries lists an account's auto-reloads that have a retry
// record (any state).
func (s *Store) ListUserReloadRetries(ctx context.Context, uid string) ([]*Topup, error) {
	iter := s.fs.Collection(topupsCol(s.env)).Where("uid", "==", uid).Where("auto", "==", true).Where("state", "==", TopupFailed).
		Limit(50).Documents(ctx)
	defer iter.Stop()
	var out []*Topup
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		var t Topup
		if err := snap.DataTo(&t); err != nil {
			return nil, err
		}
		t.ID = snap.Ref.ID
		if t.Retry != nil {
			out = append(out, &t)
		}
	}
}

// ClosedAtOr is when the group closed (its charge went out), or def.
func (b *Batch) ClosedAtOr(def time.Time) time.Time {
	if b.ClosedAt != nil {
		return *b.ClosedAt
	}
	return def
}
