package store

import (
	"context"
	"strings"
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
