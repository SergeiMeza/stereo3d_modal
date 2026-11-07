package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
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

// Restore from a deleted account (design 1b, owner 2026-11-06): a plan
// still valid when its account was deleted waits in
// plan_restores_{env}/{subscription id} for a new account proven to own
// one of its emails (EmailID hashes; never a relay address) or its Apple
// or Google sign-in (SubjectHash, RP-04). restore_proofs_{env} are the
// 15-minute, single-use proofs a find hands out.

const (
	PlanRestoreAvailable = "available"
	PlanRestoreMoving    = "moving"
	PlanRestoreMoved     = "moved"
	RestoreProofTTL      = 15 * time.Minute
)

var (
	ErrRestoredElsewhere = errors.New("restored on another account")
	ErrProofInvalid      = errors.New("restore proof missing, used or expired")
)

// PlanRestore is one deleted account's plan waiting to be restored.
type PlanRestore struct {
	ID                string    `firestore:"-"` // the subscription id
	EmailHashes       []string  `firestore:"email_hashes"`
	SubjectHashes     []string  `firestore:"subject_hashes"`
	FromUID           string    `firestore:"from_uid"`
	FromProviders     []string  `firestore:"from_providers"`
	Tier              string    `firestore:"tier"`
	PlanID            string    `firestore:"plan_id,omitempty"`
	Interval          string    `firestore:"interval,omitempty"`
	PeriodEnd         time.Time `firestore:"period_end"`
	CancelAtPeriodEnd bool      `firestore:"cancel_at_period_end"`
	// CreditMonthsGranted: a yearly plan's month indexes granted on the
	// deleted account (RP-02 grants the others). CarryCents: the current
	// period's unspent plan credit removed at the deletion, until
	// CarryExpiresAt (RP-01 grants it once on the new account).
	CreditMonthsGranted []int      `firestore:"credit_months_granted"`
	CarryCents          int64      `firestore:"carry_cents"`
	CarryExpiresAt      *time.Time `firestore:"carry_expires_at,omitempty"`
	State               string     `firestore:"state"`
	ToUID               string     `firestore:"to_uid,omitempty"`
	ClaimedAt           *time.Time `firestore:"claimed_at,omitempty"`
	MovedAt             *time.Time `firestore:"moved_at,omitempty"`
	CreatedAt           time.Time  `firestore:"created_at"`
}

// RestoreProof is what a find proved for one account.
type RestoreProof struct {
	ID        string            `firestore:"-"`
	UID       string            `firestore:"uid"`
	Offers    map[string]string `firestore:"offers"` // offer id → subscription id
	ExpiresAt time.Time         `firestore:"expires_at"`
	UsedAt    *time.Time        `firestore:"used_at,omitempty"`
	CreatedAt time.Time         `firestore:"created_at"`
}

func planRestoresCol(env string) string  { return "plan_restores_" + env }
func restoreProofsCol(env string) string { return "restore_proofs_" + env }

// SubjectHash is a provider subject's match key (no raw ids stored).
func SubjectHash(provider, subject string) string {
	sum := sha256.Sum256([]byte("subject:" + provider + ":" + subject))
	return hex.EncodeToString(sum[:16])
}

// OfferID is what the client sees for a restore (not the Stripe id).
func OfferID(subID string) string {
	sum := sha256.Sum256([]byte("offer:" + subID))
	return "rp_" + hex.EncodeToString(sum[:8])
}

func restoreOf(snap *firestore.DocumentSnapshot) (*PlanRestore, error) {
	var r PlanRestore
	if err := snap.DataTo(&r); err != nil {
		return nil, err
	}
	r.ID = snap.Ref.ID
	return &r, nil
}

// PutPlanRestore records a deleted account's plan (once per subscription:
// a record already there is kept).
func (s *Store) PutPlanRestore(ctx context.Context, r *PlanRestore) (bool, error) {
	if r.State == "" {
		r.State = PlanRestoreAvailable
	}
	_, err := s.fs.Collection(planRestoresCol(s.env)).Doc(r.ID).Create(ctx, r)
	if status.Code(err) == codes.AlreadyExists {
		return false, nil
	}
	return err == nil, err
}

// GetPlanRestore is one record (ErrNotFound when none).
func (s *Store) GetPlanRestore(ctx context.Context, subID string) (*PlanRestore, error) {
	snap, err := s.fs.Collection(planRestoresCol(s.env)).Doc(subID).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return restoreOf(snap)
}

// FindPlanRestores are the records matching an email hash or any of the
// subject hashes (any state; the caller decides).
func (s *Store) FindPlanRestores(ctx context.Context, emailHashes, subjectHashes []string) ([]*PlanRestore, error) {
	seen := map[string]*PlanRestore{}
	run := func(field string, keys []string) error {
		for len(keys) > 0 {
			n := min(len(keys), 30)
			snaps, err := s.fs.Collection(planRestoresCol(s.env)).Where(field, "array-contains-any", keys[:n]).Limit(50).Documents(ctx).GetAll()
			if err != nil {
				return err
			}
			for _, sn := range snaps {
				if r, err := restoreOf(sn); err == nil {
					seen[r.ID] = r
				}
			}
			keys = keys[n:]
		}
		return nil
	}
	if err := run("email_hashes", emailHashes); err != nil {
		return nil, err
	}
	if err := run("subject_hashes", subjectHashes); err != nil {
		return nil, err
	}
	out := make([]*PlanRestore, 0, len(seen))
	for _, r := range seen {
		out = append(out, r)
	}
	return out, nil
}

// ClaimPlanRestore starts a move to toUID: an available record becomes
// moving; one already moving or moved to toUID answers as it is (a retry
// resumes); one claimed by another account is ErrRestoredElsewhere.
func (s *Store) ClaimPlanRestore(ctx context.Context, subID, toUID string, now time.Time) (*PlanRestore, error) {
	ref := s.fs.Collection(planRestoresCol(s.env)).Doc(subID)
	var out *PlanRestore
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(ref)
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		r, err := restoreOf(snap)
		if err != nil {
			return err
		}
		out = r
		switch {
		case r.State == PlanRestoreAvailable:
			r.State, r.ToUID, r.ClaimedAt = PlanRestoreMoving, toUID, &now
			return tx.Update(ref, []firestore.Update{{Path: "state", Value: PlanRestoreMoving}, {Path: "to_uid", Value: toUID}, {Path: "claimed_at", Value: now}})
		case r.ToUID == toUID:
			return nil
		default:
			return ErrRestoredElsewhere
		}
	})
	return out, err
}

// FinishPlanRestore marks a move done.
func (s *Store) FinishPlanRestore(ctx context.Context, subID string, now time.Time) error {
	_, err := s.fs.Collection(planRestoresCol(s.env)).Doc(subID).Update(ctx, []firestore.Update{
		{Path: "state", Value: PlanRestoreMoved}, {Path: "moved_at", Value: now}})
	return err
}

// CreateRestoreProof stores a find's proof and answers its id.
func (s *Store) CreateRestoreProof(ctx context.Context, p *RestoreProof) (string, error) {
	ref := s.fs.Collection(restoreProofsCol(s.env)).NewDoc()
	if _, err := ref.Create(ctx, p); err != nil {
		return "", err
	}
	return ref.ID, nil
}

// UseRestoreProof spends uid's proof for offerID and answers its
// subscription id (ErrProofInvalid when it isn't uid's, has no such
// offer, is spent or has expired). A spent proof answers again for the
// same offer, so a retried move resumes.
func (s *Store) UseRestoreProof(ctx context.Context, id, uid, offerID string, now time.Time) (string, error) {
	if id == "" {
		return "", ErrProofInvalid
	}
	ref := s.fs.Collection(restoreProofsCol(s.env)).Doc(id)
	var sub string
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(ref)
		if status.Code(err) == codes.NotFound {
			return ErrProofInvalid
		}
		if err != nil {
			return err
		}
		var p RestoreProof
		if err := snap.DataTo(&p); err != nil {
			return err
		}
		sub = p.Offers[offerID]
		if p.UID != uid || sub == "" || now.After(p.ExpiresAt) {
			return ErrProofInvalid
		}
		if p.UsedAt != nil {
			if used, _ := snap.Data()["used_offer"].(string); used == offerID {
				return nil
			}
			return ErrProofInvalid
		}
		return tx.Update(ref, []firestore.Update{{Path: "used_at", Value: now}, {Path: "used_offer", Value: offerID}})
	})
	return sub, err
}
