package store

import (
	"context"
	"sort"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// CreditGrant is credit_grants_{env}/{id}: one admin's "Grant credit"
// (owner 2026-11-07), usage credit on the account's balance (ref
// admin:grant:<id>, kind "grant"), never cash. The id is the request's:
// the same request_id never grants twice.
type CreditGrant struct {
	ID          string     `firestore:"-" json:"id"`
	UID         string     `firestore:"uid" json:"uid"`
	AmountCents int64      `firestore:"amount_cents" json:"amount_cents"`
	Reason      string     `firestore:"reason" json:"reason"` // support_goodwill | refund_as_credit | promo | test | other
	ReasonText  string     `firestore:"reason_text,omitempty" json:"reason_text,omitempty"`
	ExpiresAt   *time.Time `firestore:"expires_at" json:"expires_at"`
	OverCap     bool       `firestore:"over_cap,omitempty" json:"over_cap"`
	Admin       string     `firestore:"admin" json:"admin"`
	AdminUID    string     `firestore:"admin_uid" json:"-"`
	IPHash      string     `firestore:"ip_hash,omitempty" json:"-"`
	RequestID   string     `firestore:"request_id" json:"request_id"`
	Ref         string     `firestore:"ref" json:"-"`
	EntryID     string     `firestore:"entry_id" json:"-"`
	NotifyUser  bool       `firestore:"notify_user" json:"notify_user"`
	Message     string     `firestore:"message,omitempty" json:"message,omitempty"`
	MailState   string     `firestore:"mail_state,omitempty" json:"mail_state,omitempty"` // sent | dry_run | skipped | failed
	// State: pending (written, credit not yet on the balance), active,
	// revoked (its unspent part removed), failed.
	State        string     `firestore:"state" json:"state"`
	RevokedCents int64      `firestore:"revoked_cents,omitempty" json:"revoked_cents"`
	RevokedAt    *time.Time `firestore:"revoked_at,omitempty" json:"revoked_at"`
	RevokedBy    string     `firestore:"revoked_by,omitempty" json:"revoked_by,omitempty"`
	CreatedAt    time.Time  `firestore:"created_at" json:"created_at"`
	UpdatedAt    time.Time  `firestore:"updated_at" json:"updated_at"`
}

func creditGrantsCol(env string) string { return "credit_grants_" + env }

func (s *Store) creditGrantDoc(id string) *firestore.DocumentRef {
	return s.fs.Collection(creditGrantsCol(s.env)).Doc(id)
}

// CreateCreditGrant writes a new grant; ErrAlreadyExists when the id is
// taken (the same request).
func (s *Store) CreateCreditGrant(ctx context.Context, g *CreditGrant) error {
	now := time.Now().UTC()
	g.CreatedAt, g.UpdatedAt = now, now
	_, err := s.creditGrantDoc(g.ID).Create(ctx, g)
	if status.Code(err) == codes.AlreadyExists {
		return ErrAlreadyExists
	}
	return err
}

// GetCreditGrant reads one grant.
func (s *Store) GetCreditGrant(ctx context.Context, id string) (*CreditGrant, error) {
	snap, err := s.creditGrantDoc(id).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var g CreditGrant
	if err := snap.DataTo(&g); err != nil {
		return nil, err
	}
	g.ID = snap.Ref.ID
	return &g, nil
}

// UpdateCreditGrant changes a grant in a transaction.
func (s *Store) UpdateCreditGrant(ctx context.Context, id string, mutate func(g *CreditGrant) error) (*CreditGrant, error) {
	var out *CreditGrant
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(s.creditGrantDoc(id))
		if err != nil {
			return err
		}
		var g CreditGrant
		if err := snap.DataTo(&g); err != nil {
			return err
		}
		g.ID = id
		if err := mutate(&g); err != nil {
			return err
		}
		g.UpdatedAt = time.Now().UTC()
		out = &g
		return tx.Set(s.creditGrantDoc(id), &g)
	})
	return out, err
}

// ListCreditGrants lists grants newest first: one account's (uid), or
// everyone's (uid "").
func (s *Store) ListCreditGrants(ctx context.Context, uid string, limit int) ([]*CreditGrant, error) {
	q := s.fs.Collection(creditGrantsCol(s.env)).Query
	if uid != "" {
		q = q.Where("uid", "==", uid).Limit(limit) // sorted here: no composite index
	} else {
		q = q.OrderBy("created_at", firestore.Desc).Limit(limit)
	}
	iter := q.Documents(ctx)
	defer iter.Stop()
	var out []*CreditGrant
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			break
		}
		if err != nil {
			return out, err
		}
		var g CreditGrant
		if snap.DataTo(&g) == nil {
			g.ID = snap.Ref.ID
			out = append(out, &g)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

// RemainingByRef is an item's unspent cents by its ref (0 when gone).
func (b *Balance) RemainingByRef(ref string) int64 {
	var n int64
	for _, it := range b.Fifo {
		if it.PlanCredit && it.Ref == ref {
			n += it.RemainingCents
		}
	}
	return n
}
