package api

import (
	"context"
	"errors"
	"fmt"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Credit and balance first (owner 2026-11-07): a run the balance doesn't
// cover in full still spends what it has — plan, Pro and admin credit
// first, soonest to expire, then cash top-ups (consumeFifo) — as a
// partial hold on the run; its card flow pays only the rest. The hold
// settles with the run's terminal transition like a balance run's and is
// released in full when it fails or is cancelled (closeRunHold); the
// card part is refunded or never charged as before.

// partialMinCardCents: a card remainder charged on its own (precharge,
// the sheet) is at least Stripe's minimum.
const partialMinCardCents = 50

// partialHoldCents is how much of amount the balance holds for a card run
// of flow: what's available, leaving at least partialMinCardCents to a
// card charged alone; 0 = none.
func (s *Service) partialHoldCents(ctx context.Context, uid string, cust *store.Customer, amount int64, flow string) int64 {
	if amount <= 0 || s.Store == nil || (cust != nil && cust.UnderReview) {
		return 0
	}
	switch flow {
	case store.FlowAfter, store.FlowPrecharge, store.FlowPayNow:
	default:
		return 0 // China pays server-side in full; free and balance runs need none
	}
	b, err := s.Store.GetBalance(ctx, uid)
	if err != nil || !b.Exists() {
		return 0
	}
	avail := max(b.Available(), 0)
	if avail <= 0 {
		return 0
	}
	hold := min(avail, amount)
	if flow != store.FlowAfter { // batched card parts may be any size
		hold = min(hold, amount-partialMinCardCents)
	}
	return max(hold, 0)
}

// runCardCents is what a card pays for a run: its price less a partial
// balance hold (the whole price without one).
func runCardCents(c *store.Conversion) int64 {
	if c == nil {
		return 0
	}
	if rb := c.RunBalance; rb != nil && rb.Partial {
		return max(c.Quote.AmountCents-rb.HoldCents, 0)
	}
	return c.Quote.AmountCents
}

// createRunRecord writes a run: with its partial hold in one transaction
// when it has one (a lost race writes it without, the card paying all).
func (s *Service) createRunRecord(ctx context.Context, conv *store.Conversion) error {
	if rb := conv.RunBalance; rb == nil || !rb.Partial {
		return s.Store.CreateConversion(ctx, conv)
	}
	fx, err := s.Store.CreateConversionWithHold(ctx, conv, 0)
	if errors.Is(err, store.ErrInsufficientBalance) {
		conv.RunBalance = nil
		return s.Store.CreateConversion(ctx, conv)
	}
	if err == nil {
		s.handleBalanceEffects(ctx, conv.UID, fx)
	}
	return err
}

// paySplit is the quote's split: what the credit and the balance cover
// and what goes to the card, with a line for the UI ("$20.00 from credit ·
// $3.78 to your card"); nil when one source pays it all.
func (s *Service) paySplit(ctx context.Context, uid string, cust *store.Customer, amount int64, flow string) map[string]any {
	hold := s.partialHoldCents(ctx, uid, cust, amount, flow)
	if hold <= 0 || hold >= amount {
		return nil
	}
	b, err := s.Store.GetBalance(ctx, uid)
	if err != nil {
		return nil
	}
	credit := min(hold, max(b.PlanCreditCents()-b.PlanCreditFrozen(), 0))
	cash := hold - credit
	card := amount - hold
	line := ""
	if credit > 0 {
		line = money(credit) + " from credit · "
	}
	if cash > 0 {
		line += money(cash) + " from your balance · "
	}
	line += money(card) + " to your card"
	return map[string]any{"credit_cents": credit, "balance_cents": cash, "card_cents": card,
		"covered_cents": hold, "text": line}
}

// splitBilling is a split run's billing block addition.
func splitBilling(c *store.Conversion) map[string]any {
	rb := c.RunBalance
	if rb == nil || !rb.Partial {
		return nil
	}
	return map[string]any{"covered_cents": rb.HoldCents, "card_cents": runCardCents(c), "hold_state": rb.State,
		"settled_cents": rb.SettledCents, "released_cents": rb.ReleasedCents,
		"text": fmt.Sprintf("%s from credit or balance · %s to your card", money(rb.HoldCents), money(runCardCents(c)))}
}
