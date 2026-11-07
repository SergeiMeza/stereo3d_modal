package store

import (
	"context"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// PromoRegrant is one revoke of promotional Pro and what was given back
// (owner 2026-11-04): promo_regrants_{env}/{key}, one per (account,
// revoke event) — refund:{invoice} | dispute:{dispute} | efw:{warning} |
// end:{subscription}:{reason}. Before the revoke the account's
// promotional grants are read from RevenueCat (Snapshot); a refund gives
// back every grant but ours for the refunded purchase at once, a dispute
// or fraud warning keeps them all removed until it is resolved.
type PromoRegrant struct {
	ID     string `firestore:"-" json:"id"`
	UID    string `firestore:"uid" json:"uid"`
	Event  string `firestore:"event" json:"event"`   // the key above
	Policy string `firestore:"policy" json:"policy"` // revoke_ours | revoke_all
	Reason string `firestore:"reason" json:"reason"`
	// Status: started | snapshot_failed | revoke_failed | held |
	// regrant_failed | done | kept_removed | merged.
	Status      string       `firestore:"status" json:"status"`
	Snapshot    []PromoGrant `firestore:"snapshot" json:"snapshot"`
	Ours        []PromoGrant `firestore:"ours,omitempty" json:"ours,omitempty"` // excluded: the refunded purchase's grants
	Revoked     []string     `firestore:"revoked,omitempty" json:"revoked,omitempty"`
	RevokedAt   *time.Time   `firestore:"revoked_at,omitempty" json:"revoked_at,omitempty"`
	ToGrant     []PromoGrant `firestore:"to_grant,omitempty" json:"to_grant,omitempty"` // still to give back
	Regranted   []PromoGrant `firestore:"regranted,omitempty" json:"regranted,omitempty"`
	Skipped     []PromoGrant `firestore:"skipped,omitempty" json:"skipped,omitempty"` // expired by the time of the re-grant
	Uncertain   bool         `firestore:"uncertain,omitempty" json:"uncertain,omitempty"`
	AmountCents int64        `firestore:"amount_cents,omitempty" json:"amount_cents,omitempty"`
	CaseID      string       `firestore:"case_id,omitempty" json:"case_id,omitempty"`
	Outcome     string       `firestore:"outcome,omitempty" json:"outcome,omitempty"` // refund | won | lost | cleared | restored | merged
	MergedInto  string       `firestore:"merged_into,omitempty" json:"merged_into,omitempty"`
	RestoredBy  string       `firestore:"restored_by,omitempty" json:"restored_by,omitempty"`
	RestoreNote string       `firestore:"restore_note,omitempty" json:"restore_note,omitempty"`
	LastError   string       `firestore:"last_error,omitempty" json:"last_error,omitempty"`
	Attempts    int          `firestore:"attempts" json:"attempts"`
	CreatedAt   time.Time    `firestore:"created_at" json:"created_at"`
	UpdatedAt   time.Time    `firestore:"updated_at" json:"updated_at"`
	ResolvedAt  *time.Time   `firestore:"resolved_at,omitempty" json:"resolved_at,omitempty"`
}

// PromoGrant is a promotional grant: entitlement, RevenueCat product and
// end (nil = lifetime).
type PromoGrant struct {
	Entitlement string     `firestore:"entitlement" json:"entitlement"`
	Product     string     `firestore:"product,omitempty" json:"product,omitempty"`
	ExpiresAt   *time.Time `firestore:"expires_at,omitempty" json:"expires_at,omitempty"`
	Error       string     `firestore:"error,omitempty" json:"error,omitempty"`
}

// Promo regrant statuses a retry picks up.
var PromoRetryStatuses = []string{"started", "snapshot_failed", "revoke_failed", "regrant_failed"}

func promoCol(s *Store) *firestore.CollectionRef { return s.fs.Collection("promo_regrants_" + s.env) }

// CreatePromoRegrant stores r under key; false (and the stored one) when
// the key was there.
func (s *Store) CreatePromoRegrant(ctx context.Context, key string, r *PromoRegrant) (*PromoRegrant, bool, error) {
	now := time.Now().UTC()
	r.CreatedAt, r.UpdatedAt, r.Event = now, now, key
	_, err := promoCol(s).Doc(key).Create(ctx, r)
	if status.Code(err) == codes.AlreadyExists {
		got, gerr := s.GetPromoRegrant(ctx, key)
		return got, false, gerr
	}
	if err != nil {
		return nil, false, err
	}
	r.ID = key
	return r, true, nil
}

func (s *Store) GetPromoRegrant(ctx context.Context, key string) (*PromoRegrant, error) {
	snap, err := promoCol(s).Doc(key).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var r PromoRegrant
	if err := snap.DataTo(&r); err != nil {
		return nil, err
	}
	r.ID = key
	return &r, nil
}

// UpdatePromoRegrant changes one in a transaction.
func (s *Store) UpdatePromoRegrant(ctx context.Context, key string, mutate func(r *PromoRegrant) error) (*PromoRegrant, error) {
	doc := promoCol(s).Doc(key)
	var out *PromoRegrant
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(doc)
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		var r PromoRegrant
		if err := snap.DataTo(&r); err != nil {
			return err
		}
		if err := mutate(&r); err != nil {
			return err
		}
		r.UpdatedAt = time.Now().UTC()
		r.ID = key
		out = &r
		return tx.Set(doc, &r)
	})
	return out, err
}

func promoList(snaps []*firestore.DocumentSnapshot) []*PromoRegrant {
	out := make([]*PromoRegrant, 0, len(snaps))
	for _, sn := range snaps {
		var r PromoRegrant
		if sn.DataTo(&r) == nil {
			r.ID = sn.Ref.ID
			out = append(out, &r)
		}
	}
	return out
}

// ListUserPromoRegrants is an account's (by uid alone, no composite index).
func (s *Store) ListUserPromoRegrants(ctx context.Context, uid string, limit int) ([]*PromoRegrant, error) {
	snaps, err := promoCol(s).Where("uid", "==", uid).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	return promoList(snaps), nil
}

// ListPromoRegrantsByStatus is every one in one of statuses.
func (s *Store) ListPromoRegrantsByStatus(ctx context.Context, statuses []string, limit int) ([]*PromoRegrant, error) {
	snaps, err := promoCol(s).Where("status", "in", statuses).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	return promoList(snaps), nil
}
