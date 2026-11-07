package store

import (
	"context"
	"strings"
	"time"

	"cloud.google.com/go/firestore"
	firestorepb "cloud.google.com/go/firestore/apiv1/firestorepb"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// SearchCustomersByEmail is up to limit accounts whose email starts with
// prefix (as typed and lowercased), keyed by uid (a range on the
// single-field email index; no composite index).
func (s *Store) SearchCustomersByEmail(ctx context.Context, prefix string, limit int) (map[string]*Customer, error) {
	out := map[string]*Customer{}
	for _, p := range uniqueStrings(prefix, strings.ToLower(prefix)) {
		snaps, err := s.fs.Collection(customersCol(s.env)).Where("email", ">=", p).Where("email", "<=", p+"").
			Limit(limit).Documents(ctx).GetAll()
		if err != nil {
			return nil, err
		}
		for _, sn := range snaps {
			var c Customer
			if sn.DataTo(&c) == nil {
				out[sn.Ref.ID] = &c
			}
		}
	}
	return out, nil
}

func uniqueStrings(xs ...string) []string {
	var out []string
	for _, x := range xs {
		dup := false
		for _, y := range out {
			dup = dup || x == y
		}
		if !dup && x != "" {
			out = append(out, x)
		}
	}
	return out
}

// AdminMarker is a console-wide marker on admin_state_{env}/{key} (e.g.
// feedback_seen): no admin's uid or email is stored.
type AdminMarker struct {
	At        time.Time `firestore:"at"`
	UpdatedAt time.Time `firestore:"updated_at"`
}

func (s *Store) GetAdminMarker(ctx context.Context, key string) (*AdminMarker, error) {
	snap, err := s.fs.Collection("admin_state_" + s.env).Doc(key).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var m AdminMarker
	if err := snap.DataTo(&m); err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Store) SetAdminMarker(ctx context.Context, key string, at time.Time) error {
	_, err := s.fs.Collection("admin_state_"+s.env).Doc(key).Set(ctx, AdminMarker{At: at, UpdatedAt: time.Now().UTC()})
	return err
}

// CountUserConversions counts an account's runs (an aggregation; the
// single-field uid index).
func (s *Store) CountUserConversions(ctx context.Context, uid string) (int64, error) {
	q := s.fs.Collection(conversionsCol(s.env)).Where("uid", "==", uid)
	res, err := q.NewAggregationQuery().WithCount("n").Get(ctx)
	if err != nil {
		return 0, err
	}
	switch v := res["n"].(type) {
	case int64:
		return v, nil
	case *firestorepb.Value:
		return v.GetIntegerValue(), nil
	}
	return 0, nil
}

// ListUserConversionsPage is an account's runs newest first, created
// before `before` (zero: from the newest), at most limit (the uid,
// created_at DESC index).
func (s *Store) ListUserConversionsPage(ctx context.Context, uid string, before time.Time, limit int) ([]*Conversion, error) {
	q := s.fs.Collection(conversionsCol(s.env)).Where("uid", "==", uid).OrderBy("created_at", firestore.Desc)
	if !before.IsZero() {
		q = q.StartAfter(before)
	}
	return s.collect(q.Limit(limit).Documents(ctx))
}

// ListUserConversionsSince is an account's runs created since t (same
// index), at most limit.
func (s *Store) ListUserConversionsSince(ctx context.Context, uid string, since time.Time, limit int) ([]*Conversion, error) {
	return s.collect(s.fs.Collection(conversionsCol(s.env)).Where("uid", "==", uid).Where("created_at", ">=", since).
		OrderBy("created_at", firestore.Desc).Limit(limit).Documents(ctx))
}
