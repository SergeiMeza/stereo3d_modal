package store

import (
	"context"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// AdminGrant is a promotional grant made from Admin → Grant Pro (owner
// 2026-11-04): promo_grants_{env}/{id}. Support never grants from the
// RevenueCat dashboard, so these records are the source of truth for
// support grants: the refund and dispute snapshots add the active ones
// RevenueCat's collapsed view can't show.
type AdminGrant struct {
	ID           string     `firestore:"-" json:"id"`
	UID          string     `firestore:"uid" json:"uid"`
	Entitlement  string     `firestore:"entitlement" json:"entitlement"` // pro | business | studio
	EndsAt       time.Time  `firestore:"ends_at" json:"ends_at"`
	GrantedBy    string     `firestore:"granted_by" json:"granted_by"`
	Reason       string     `firestore:"reason" json:"reason"`
	CreatedAt    time.Time  `firestore:"created_at" json:"created_at"`
	State        string     `firestore:"state" json:"-"` // granting | granted | failed | revoked
	RCError      string     `firestore:"rc_error,omitempty" json:"rc_error,omitempty"`
	RevokedAt    *time.Time `firestore:"revoked_at,omitempty" json:"revoked_at,omitempty"`
	RevokedBy    string     `firestore:"revoked_by,omitempty" json:"revoked_by,omitempty"`
	RevokeReason string     `firestore:"revoke_reason,omitempty" json:"revoke_reason,omitempty"`
}

// Status: active | expired | revoked | failed | granting.
func (g *AdminGrant) Status(now time.Time) string {
	switch {
	case g.State == "revoked":
		return "revoked"
	case g.State == "failed":
		return "failed"
	case g.State == "granting":
		return "granting"
	case !g.EndsAt.After(now):
		return "expired"
	}
	return "active"
}

func adminGrantCol(s *Store) *firestore.CollectionRef {
	return s.fs.Collection("promo_grants_" + s.env)
}

func (s *Store) CreateAdminGrant(ctx context.Context, g *AdminGrant) error {
	g.ID = NewID()
	_, err := adminGrantCol(s).Doc(g.ID).Create(ctx, g)
	return err
}

func (s *Store) GetAdminGrant(ctx context.Context, id string) (*AdminGrant, error) {
	snap, err := adminGrantCol(s).Doc(id).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var g AdminGrant
	if err := snap.DataTo(&g); err != nil {
		return nil, err
	}
	g.ID = id
	return &g, nil
}

// UpdateAdminGrant changes one in a transaction.
func (s *Store) UpdateAdminGrant(ctx context.Context, id string, mutate func(g *AdminGrant) error) (*AdminGrant, error) {
	doc := adminGrantCol(s).Doc(id)
	var out *AdminGrant
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(doc)
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		var g AdminGrant
		if err := snap.DataTo(&g); err != nil {
			return err
		}
		if err := mutate(&g); err != nil {
			return err
		}
		g.ID = id
		out = &g
		return tx.Set(doc, &g)
	})
	return out, err
}

// ListUserAdminGrants is an account's grants (by uid alone, no composite
// index).
func (s *Store) ListUserAdminGrants(ctx context.Context, uid string, limit int) ([]*AdminGrant, error) {
	snaps, err := adminGrantCol(s).Where("uid", "==", uid).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]*AdminGrant, 0, len(snaps))
	for _, sn := range snaps {
		var g AdminGrant
		if sn.DataTo(&g) == nil {
			g.ID = sn.Ref.ID
			out = append(out, &g)
		}
	}
	return out, nil
}
