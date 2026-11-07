package api

import (
	"context"
	"errors"
	"log/slog"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Adaptive Pricing (owner 2026-11-07, Option B): Stripe may present a
// Checkout amount in the customer's currency. Our records, the ledger and
// the invoices stay USD; the customer's side — {amount_minor, currency} —
// is kept on the paid record and shown beside the USD amount.

// presentmentOf converts Stripe's presentment for the store.
func presentmentOf(p *stripex.Presentment) *store.Presentment {
	if p == nil {
		return nil
	}
	return &store.Presentment{AmountMinor: p.AmountMinor, Currency: p.Currency}
}

// notePresentment records a paid Checkout outcome's presentment on its
// record (store.PresentRun, PresentSettle, PresentTopup) once. A USD
// payment, an outcome read from a PaymentIntent or an unpaid one has none
// and changes nothing, so every off-session path stays as it was. Safe to
// call again: a webhook retry or a later read finds it set.
func (s *Service) notePresentment(ctx context.Context, kind, id string, out stripex.Outcome) error {
	p := presentmentOf(out.Presentment)
	if p == nil || !out.Paid || out.PaymentIntentID == "" || id == "" {
		return nil
	}
	set, err := s.Store.SetPresentment(ctx, kind, id, out.PaymentIntentID, *p)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if set {
		slog.InfoContext(ctx, "payment presented locally", "record", kind, "id", id, "currency", p.Currency, "amount_minor", p.AmountMinor)
	}
	return nil
}

// notePresentmentQuiet is notePresentment where the caller can't retry
// (a read path): a failure is logged; the next webhook or read fills it.
func (s *Service) notePresentmentQuiet(ctx context.Context, kind, id string, out stripex.Outcome) {
	if err := s.notePresentment(ctx, kind, id, out); err != nil {
		slog.WarnContext(ctx, "presentment not recorded", "record", kind, "id", id, "err", err)
	}
}
