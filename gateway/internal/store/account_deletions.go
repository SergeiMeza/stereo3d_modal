package store

import (
	"context"
	"errors"
	"slices"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Scheduled account deletions (owner 2026-11-07): a delete request waits
// account_delete_delay_hours (48) before today's deletion runs, so an
// account can't be deleted and made again at once. One row per account in
// account_deletions_{env}/{uid}; a later request after a cancel replaces
// it.

// Account deletion states.
const (
	DeletionStatePending   = "pending"   // waiting for delete_after; the account is frozen
	DeletionStateCancelled = "cancelled" // the person (or support) kept the account
	DeletionStateDone      = "done"      // today's deletion ran (outcome says how)
)

// Outcomes of a processed deletion.
const (
	DeletionOutcomeDeleted    = "deleted"     // soft-deleted, sign-in removed
	DeletionOutcomeRefundCase = "refund_case" // waits for its closure case (N8), which finishes it
)

// ErrNotPendingDeletion: there is no pending deletion to change.
var ErrNotPendingDeletion = errors.New("no pending deletion")

// AccountDeletion is one account's scheduled deletion.
type AccountDeletion struct {
	UID              string    `firestore:"uid"`
	State            string    `firestore:"state"`
	RequestedAt      time.Time `firestore:"requested_at"`
	DeleteAfter      time.Time `firestore:"delete_after"`
	BalanceConfirmed bool      `firestore:"balance_confirmed"` // "Delete and refund" said yes to
	Email            string    `firestore:"email,omitempty"`   // for the mails, the account's own address
	Source           string    `firestore:"source,omitempty"`  // web | api
	// Blocked: the sweep found something in the way at delete_after (a
	// plan renewing again, a run going, dues it couldn't collect); the row
	// stays pending, flagged for the console, and is tried again at
	// NextAttemptAt.
	BlockedReason string     `firestore:"blocked_reason,omitempty"`
	BlockedAt     *time.Time `firestore:"blocked_at,omitempty"`
	NextAttemptAt *time.Time `firestore:"next_attempt_at,omitempty"`
	Attempts      int        `firestore:"attempts,omitempty"`
	CancelledAt   *time.Time `firestore:"cancelled_at,omitempty"`
	CancelledBy   string     `firestore:"cancelled_by,omitempty"` // customer | admin:<who>
	ProcessedAt   *time.Time `firestore:"processed_at,omitempty"`
	ProcessedBy   string     `firestore:"processed_by,omitempty"` // sweep | admin:<who> | request
	Outcome       string     `firestore:"outcome,omitempty"`
}

// Pending: the deletion is scheduled and hasn't run.
func (d *AccountDeletion) Pending() bool { return d != nil && d.State == DeletionStatePending }

func accountDeletionsCol(env string) string { return "account_deletions_" + env }

// GetAccountDeletion is the account's deletion row (ErrNotFound without one).
func (s *Store) GetAccountDeletion(ctx context.Context, uid string) (*AccountDeletion, error) {
	snap, err := s.fs.Collection(accountDeletionsCol(s.env)).Doc(uid).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var d AccountDeletion
	if err := snap.DataTo(&d); err != nil {
		return nil, err
	}
	return &d, nil
}

// PendingAccountDeletion is the account's pending deletion, nil when there
// is none (or it can't be read: callers fail open only where nothing is
// lost).
func (s *Store) PendingAccountDeletion(ctx context.Context, uid string) *AccountDeletion {
	d, err := s.GetAccountDeletion(ctx, uid)
	if err != nil || !d.Pending() {
		return nil
	}
	return d
}

// ScheduleAccountDeletion makes the account's deletion pending, due at
// after. Idempotent: a pending one is returned unchanged (created false),
// so a repeat keeps its delete_after.
func (s *Store) ScheduleAccountDeletion(ctx context.Context, d *AccountDeletion) (*AccountDeletion, bool, error) {
	ref := s.fs.Collection(accountDeletionsCol(s.env)).Doc(d.UID)
	var out *AccountDeletion
	created := false
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		created = false
		snap, err := tx.Get(ref)
		if err != nil && status.Code(err) != codes.NotFound {
			return err
		}
		if err == nil {
			var cur AccountDeletion
			if derr := snap.DataTo(&cur); derr == nil && cur.Pending() {
				out = &cur
				return nil
			}
		}
		row := *d
		row.State = DeletionStatePending
		out, created = &row, true
		return tx.Set(ref, &row)
	})
	if err != nil {
		return nil, false, err
	}
	return out, created, nil
}

// UpdateAccountDeletion changes a pending deletion in a transaction;
// ErrNotPendingDeletion when there is none.
func (s *Store) UpdateAccountDeletion(ctx context.Context, uid string, mutate func(d *AccountDeletion) error) (*AccountDeletion, error) {
	ref := s.fs.Collection(accountDeletionsCol(s.env)).Doc(uid)
	var out *AccountDeletion
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(ref)
		if status.Code(err) == codes.NotFound {
			return ErrNotPendingDeletion
		}
		if err != nil {
			return err
		}
		var d AccountDeletion
		if err := snap.DataTo(&d); err != nil {
			return err
		}
		if !d.Pending() {
			return ErrNotPendingDeletion
		}
		if err := mutate(&d); err != nil {
			return err
		}
		out = &d
		return tx.Set(ref, &d)
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// CancelAccountDeletion keeps the account: the pending deletion is
// cancelled by who (customer | admin:<who>).
func (s *Store) CancelAccountDeletion(ctx context.Context, uid, who string, now time.Time) (*AccountDeletion, error) {
	return s.UpdateAccountDeletion(ctx, uid, func(d *AccountDeletion) error {
		d.State, d.CancelledAt, d.CancelledBy = DeletionStateCancelled, &now, who
		return nil
	})
}

// FinishAccountDeletionRow marks a deletion processed (a no-op without a
// pending row: a deletion that ran at once, through the proxy).
func (s *Store) FinishAccountDeletionRow(ctx context.Context, uid, by, outcome string, now time.Time) error {
	_, err := s.UpdateAccountDeletion(ctx, uid, func(d *AccountDeletion) error {
		d.State, d.ProcessedAt, d.ProcessedBy, d.Outcome = DeletionStateDone, &now, by, outcome
		d.BlockedReason, d.BlockedAt, d.NextAttemptAt = "", nil, nil
		return nil
	})
	if errors.Is(err, ErrNotPendingDeletion) {
		return nil
	}
	return err
}

// ListAccountDeletions is the rows in a state (single-field index), at
// most limit, soonest delete_after first.
func (s *Store) ListAccountDeletions(ctx context.Context, state string, limit int) ([]*AccountDeletion, error) {
	snaps, err := s.fs.Collection(accountDeletionsCol(s.env)).Where("state", "==", state).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]*AccountDeletion, 0, len(snaps))
	for _, snap := range snaps {
		var d AccountDeletion
		if snap.DataTo(&d) == nil {
			out = append(out, &d)
		}
	}
	sortDeletions(out)
	return out, nil
}

func sortDeletions(ds []*AccountDeletion) {
	slices.SortFunc(ds, func(a, b *AccountDeletion) int { return a.DeleteAfter.Compare(b.DeleteAfter) })
}
