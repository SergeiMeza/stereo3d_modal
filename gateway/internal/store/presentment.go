package store

import (
	"context"
	"fmt"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Presentment is what the customer saw and paid in their own currency
// when Stripe's Adaptive Pricing presented one of our USD amounts (owner
// 2026-11-07). Every amount_cents, the ledger and the invoices stay USD;
// this is shown beside them. AmountMinor is in the currency's smallest
// unit (¥1, ₩1, 1 cent).
type Presentment struct {
	AmountMinor int64  `firestore:"amount_minor" json:"amount_minor"`
	Currency    string `firestore:"currency" json:"currency"` // lowercase ISO, e.g. "jpy"
}

// Which record a presentment goes on.
const (
	PresentRun    = "run"    // conversions: stripe.presentment
	PresentSettle = "settle" // settles: presentment
	PresentTopup  = "topup"  // top-ups: presentment
	PresentCharge = "charge" // statement charges (invoices): presentment
)

// SetPresentment records p on the record once, only while the record is
// paid by that PaymentIntent: a retry, a second webhook or a later read
// finds it set and changes nothing (false). ErrNotFound when the record
// isn't there.
func (s *Store) SetPresentment(ctx context.Context, kind, id, pi string, p Presentment) (bool, error) {
	var doc *firestore.DocumentRef
	piPath, field := "payment_intent_id", "presentment"
	switch kind {
	case PresentRun:
		doc, piPath, field = s.convDoc(id), "stripe.payment_intent_id", "stripe.presentment"
	case PresentSettle:
		doc = s.settleDoc(id)
	case PresentTopup:
		doc = s.topupDoc(id)
	case PresentCharge:
		doc = s.chargeDoc(id)
	default:
		return false, fmt.Errorf("presentment: unknown record kind %q", kind)
	}
	if pi == "" || p.AmountMinor <= 0 || p.Currency == "" {
		return false, nil
	}
	set := false
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		set = false
		snap, err := tx.Get(doc)
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if got, err := snap.DataAt(piPath); err != nil || got != pi {
			return nil // paid by another PaymentIntent (or not yet): not ours to mark
		}
		if cur, err := snap.DataAt(field); err == nil && cur != nil {
			return nil // already recorded
		}
		set = true
		return tx.Update(doc, []firestore.Update{{Path: field, Value: p}})
	})
	return set, err
}
