package store

import (
	"context"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Photo-pack credit ledger (Customer.PhotoCredits). Packs were withdrawn
// on 2026-09-02; the balances they granted are spent down here and
// nothing grants new ones.

// ConsumePhotoCredit takes one leftover credit if any remain. ok=false
// (no write) when the balance is zero or the customer is unknown.
func (s *Store) ConsumePhotoCredit(ctx context.Context, uid string) (remaining int64, ok bool, err error) {
	ref := s.fs.Collection(customersCol(s.env)).Doc(uid)
	err = s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, gerr := tx.Get(ref)
		if status.Code(gerr) == codes.NotFound {
			return nil
		}
		if gerr != nil {
			return gerr
		}
		var c Customer
		if derr := snap.DataTo(&c); derr != nil {
			return derr
		}
		if c.PhotoCredits <= 0 {
			remaining = 0
			return nil
		}
		c.PhotoCredits--
		remaining, ok = c.PhotoCredits, true
		return tx.Set(ref, &c)
	})
	return remaining, ok, err
}

// RefundPhotoCredit gives back a credit for a credited run that never
// delivered (failed / canceled / expired).
func (s *Store) RefundPhotoCredit(ctx context.Context, uid string) error {
	_, err := s.UpdateCustomer(ctx, uid, func(c *Customer) error {
		c.PhotoCredits++
		return nil
	})
	return err
}
