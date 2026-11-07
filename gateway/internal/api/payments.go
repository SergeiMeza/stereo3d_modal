package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Payment layer, spec v6 §C1 and §E0. The invariants, each enforced here
// and tested:
//
//	E0-1 One live payment object per run (current_payment), replaced by
//	     compare-and-swap: close the old one (expire / cancel — if it was
//	     paid, that IS the payment and nothing new is made), create the new
//	     one, swap in a transaction; a lost swap closes what it just made.
//	E0-2 Money on an object that isn't current: adopt it while the run is
//	     unpaid, else refund it in full (late_or_duplicate).
//	E0-3 The run's clock follows its payment: expires_at = the object's
//	     expiry + 5 min (30 min with no object); the reconciler resolves the
//	     object before it ever expires a run.
//	E0-4 Record before money; one writer: every object is created after its
//	     record, under a deterministic key; a lease gives a group one writer
//	     and only the gateway writes failure.

const (
	runPaymentGrace  = 5 * time.Minute  // run clock past its object's expiry (E0-3)
	noObjectHold     = 30 * time.Minute // a run waiting with no payment object yet
	leaseTTL         = 2 * time.Minute
	secondTryTimeout = 25 * time.Second // the pre-charge's 2nd try only if the 1st was faster (V6)
)

// ------------------------------------------------------------ C1: flow

// hasCredit: a saved reusable method has paid us (C1 "credit"). The
// method that last paid must still be the default or recorded as paid;
// detaching one prunes it (payment_method.detached). Accounts from before
// the payment layer that have paid (lifetime) with the default they still
// hold count too, until the launch backfill (I.2) records it.
func hasCredit(c *store.Customer) bool {
	if c == nil || c.DefaultPaymentMethod == "" {
		return false
	}
	if slices.Contains(c.PaidMethods, c.DefaultPaymentMethod) {
		return true
	}
	if c.LastGoodMethod != "" && slices.Contains(c.PaidMethods, c.LastGoodMethod) {
		return true
	}
	return len(c.PaidMethods) == 0 && c.LifetimePaidCents > 0
}

// decideFlow is C1's table for a run of amountCents. China mode pays every
// run server-side; an account with nothing saved, whose methods all failed,
// or flagged sheet_only pays in the sheet; credit runs at or under the
// threshold are charged when done, above it at start; saved methods with
// no credit yet are charged at start. Outstanding / under-review accounts
// are refused before this (blockedForPayment).
//
// deferred false (owner 2026-11-07, every env until deferred payments are
// fixed after the release, BL-32): every card-paid run pays in the sheet
// before it starts; no "after" batching, no off-session pre-charge.
func decideFlow(c *store.Customer, amountCents, thresholdCents int64, china, deferred bool) (flow, reason string) {
	switch {
	case china:
		return store.FlowChina, "china"
	case c == nil || c.DefaultPaymentMethod == "":
		return store.FlowPayNow, "no_method"
	case c.AllMethodsFailed:
		return store.FlowPayNow, "all_methods_failed"
	case c.SheetOnly:
		return store.FlowPayNow, "account_flag"
	case !deferred:
		return store.FlowPayNow, ""
	case hasCredit(c) && amountCents <= thresholdCents:
		return store.FlowAfter, ""
	}
	return store.FlowPrecharge, ""
}

// ------------------------------------------------------- account facts

// noteMethodPaid records that a saved method paid us (C1): it becomes the
// last good method and joins the paid list; all_methods_failed clears.
func (s *Service) noteMethodPaid(ctx context.Context, uid, pm string) {
	if pm == "" {
		return
	}
	if _, err := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		c.LastGoodMethod = pm
		if !slices.Contains(c.PaidMethods, pm) {
			c.PaidMethods = append(c.PaidMethods, pm)
		}
		c.AllMethodsFailed = false
		return nil
	}); err != nil {
		slog.WarnContext(ctx, "account facts: paid method not recorded", "uid", uid, "err", err)
	}
}

// paidAtStart: a run paid before it runs — the payment lifts B14's
// limits (lifetime credit waits for delivery) and E1 is recorded and sent
// before the run is queued.
func (s *Service) paidAtStart(ctx context.Context, conv *store.Conversion) {
	s.notePaidOnce(ctx, conv.UID)
	s.mailOrderConfirmation(ctx, conv)
}

// notePaidOnce records that a payment went through (B14).
func (s *Service) notePaidOnce(ctx context.Context, uid string) {
	if c, err := s.Store.GetCustomer(ctx, uid); err == nil && c.PaidOnce {
		return
	}
	if _, err := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		c.PaidOnce = true
		return nil
	}); err != nil {
		slog.WarnContext(ctx, "account facts: paid_once not recorded", "uid", uid, "err", err)
	}
}

// setSheetOnly makes the account pay every run in the sheet (a stop code,
// a dispute) and tells the owner.
func (s *Service) setSheetOnly(ctx context.Context, uid, reason string) {
	if _, err := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		c.SheetOnly, c.SheetOnlyReason = true, reason
		return nil
	}); err != nil {
		slog.WarnContext(ctx, "account facts: sheet_only not recorded", "uid", uid, "err", err)
	}
	s.Slack.SettleFailed(ctx, "-", uid, "sheet_only", errors.New(reason))
}

// --------------------------------------------------------- E0-1 / E0-2

// closePayment makes a payment object unpayable (expire a session, cancel
// a PaymentIntent) and reports how it ended. Paid or Processing objects
// can't be closed: their money is the run's (or extra, E0-2).
func (s *Service) closePayment(p *store.Payment) (stripex.Outcome, error) {
	if p == nil || p.ID == "" {
		return stripex.Outcome{}, nil
	}
	if p.Kind == store.PaymentCheckoutSession {
		return s.Stripe.CloseCheckoutSession(p.ID)
	}
	return s.Stripe.ClosePaymentIntent(p.ID)
}

// runClock is a created run's expiry for its payment object (E0-3).
func runClock(p *store.Payment, now time.Time) time.Time {
	if p != nil && p.ExpiresAt != nil {
		return p.ExpiresAt.Add(runPaymentGrace)
	}
	return now.Add(noObjectHold)
}

// errAlreadyPaid: closing the current object found it paid; the run is
// (now) paid and no new object was made.
var errAlreadyPaid = errors.New("already paid")

// replaceRunPayment swaps a created run's payment object for a new one
// (E0-1): Try again, Pay here instead, Continue to payment. create makes
// the new object for the given attempt number under a deterministic key.
// Returns the run as stored; errAlreadyPaid when the old object had been
// paid (the run is paid, nothing was created).
func (s *Service) replaceRunPayment(ctx context.Context, conv *store.Conversion,
	create func(attempt int) (*store.Payment, error)) (*store.Conversion, error) {
	if conv.State != store.StateCreated {
		return conv, fmt.Errorf("%w: run is %s", store.ErrStateConflict, conv.State)
	}
	old := conv.CurrentPayment
	if old != nil {
		out, err := s.closePayment(old)
		if err != nil {
			return conv, err
		}
		if out.Paid || out.Processing {
			paid, perr := s.applyRunPayment(ctx, conv.ID, *old, out)
			if perr != nil {
				return conv, perr
			}
			return paid, errAlreadyPaid
		}
	}
	next, err := create(len(conv.Payments) + 1)
	if err != nil {
		return conv, err
	}
	oldID := ""
	if old != nil {
		oldID = old.ID
	}
	now := time.Now().UTC()
	expiry := runClock(next, now)
	swapped, err := s.Store.Transition(ctx, conv.ID, []string{store.StateCreated}, func(c *store.Conversion) error {
		cur := ""
		if c.CurrentPayment != nil {
			cur = c.CurrentPayment.ID
		}
		if cur != oldID {
			return fmt.Errorf("%w: current payment moved", store.ErrStateConflict)
		}
		c.CurrentPayment = next
		c.Payments = append(c.Payments, *next)
		c.ExpiresAt = &expiry
		return nil
	})
	if err != nil {
		// Lost the swap (someone else replaced it, or the run moved on):
		// close what we just made; if it was paid meanwhile, E0-2.
		if out, cerr := s.closePayment(next); cerr == nil && (out.Paid || out.Processing) {
			if _, aerr := s.applyRunPayment(ctx, conv.ID, *next, out); aerr != nil {
				slog.ErrorContext(ctx, "lost-swap payment not applied", "conversion_id", conv.ID, "err", aerr)
			}
		}
		if fresh, gerr := s.Store.GetConversion(ctx, conv.ID); gerr == nil {
			return fresh, nil
		}
		return conv, err
	}
	return swapped, nil
}

// applyRunPayment applies money found on one of a run's payment objects
// (a webhook, a close, a sweep):
//   - the run is created and the object is current → paid (or waiting for
//     an async payment, P2);
//   - the run is created and the object isn't current → adopt it (E0-2):
//     swap it in, then close the previous current object — if that one
//     was paid too, it is the extra payment and is refunded;
//   - the run is already paid or terminal → the money is extra: refunded.
func (s *Service) applyRunPayment(ctx context.Context, convID string, p store.Payment, out stripex.Outcome) (*store.Conversion, error) {
	conv, err := s.Store.GetConversion(ctx, convID)
	if err != nil {
		return nil, err
	}
	if !out.Paid && !out.Processing {
		return conv, nil
	}
	if conv.State != store.StateCreated || conv.Stripe.PIStatus == store.PISucceeded {
		if conv.Stripe.PaymentIntentID == out.PaymentIntentID {
			s.notePresentmentQuiet(ctx, store.PresentRun, convID, out) // a retry fills a missed one
			return conv, nil                                           // the payment the run already has: nothing extra
		}
		if out.Paid {
			s.refundLatePayment(ctx, conv, out.PaymentIntentID, out.AmountReceived, "paid after the run was "+conv.State)
		}
		return conv, nil
	}
	var previous *store.Payment
	now := time.Now().UTC()
	updated, err := s.Store.Transition(ctx, convID, []string{store.StateCreated}, func(c *store.Conversion) error {
		if c.Stripe.PIStatus == store.PISucceeded {
			return fmt.Errorf("%w: already paid", store.ErrStateConflict)
		}
		if c.CurrentPayment == nil || c.CurrentPayment.ID != p.ID {
			previous = c.CurrentPayment // adopt (E0-2)
			cp := p
			c.CurrentPayment = &cp
		}
		c.Stripe.PaymentIntentID = out.PaymentIntentID
		if out.Processing {
			c.Stripe.PIStatus = store.PIProcessing
			return nil
		}
		c.State = store.StatePaid
		c.Stripe.Mode = store.BillingModeAutoPrecharge // refunded in full if it won't deliver (E0-6)
		c.Stripe.PIStatus = store.PISucceeded
		c.Stripe.CapturedCents = out.AmountReceived
		c.Stripe.CapturedAt = &now
		c.Stripe.ClientSecret = ""
		return nil
	})
	if errors.Is(err, store.ErrStateConflict) {
		// Raced another payment that got there first: this one is extra.
		if out.Paid {
			if fresh, gerr := s.Store.GetConversion(ctx, convID); gerr == nil && fresh.Stripe.PaymentIntentID != out.PaymentIntentID {
				s.refundLatePayment(ctx, fresh, out.PaymentIntentID, out.AmountReceived, "a second payment for the same run")
				return fresh, nil
			}
		}
		return s.Store.GetConversion(ctx, convID)
	}
	if err != nil {
		return nil, err
	}
	if previous != nil {
		if pout, cerr := s.closePayment(previous); cerr == nil && pout.Paid && pout.PaymentIntentID != out.PaymentIntentID {
			s.refundLatePayment(ctx, updated, pout.PaymentIntentID, pout.AmountReceived, "the replaced payment was paid too")
		}
	}
	if updated.State == store.StatePaid {
		s.notePresentmentQuiet(ctx, store.PresentRun, convID, out)
		if updated.Stripe.Presentment == nil && updated.Stripe.PaymentIntentID == out.PaymentIntentID {
			updated.Stripe.Presentment = presentmentOf(out.Presentment) // for the receipt mail (E1)
		}
		s.afterRunPaid(ctx, updated, out.PaymentMethod)
	}
	return updated, nil
}

// afterRunPaid: account facts, then queue the run. (The order
// confirmation mail E1 joins here with the mails, §G3.)
func (s *Service) afterRunPaid(ctx context.Context, conv *store.Conversion, pm string) {
	s.paidAtStart(ctx, conv)
	if pm != "" {
		if cust, err := s.Store.GetCustomer(ctx, conv.UID); err == nil && cust.DefaultPaymentMethod == pm {
			s.noteMethodPaid(ctx, conv.UID, pm)
		}
	}
	if err := s.submitToModal(ctx, conv.ID); err != nil {
		slog.WarnContext(ctx, "submit after payment failed; reconciler retries", "conversion_id", conv.ID, "err", err)
	}
}

// refundLatePayment gives back money that arrived on an object a run no
// longer needed (E0-2: late or duplicate). Auto, full amount, logged and
// posted to Slack. The refund policy door (requestRefund →
// late_or_duplicate case, §C12) takes this over with the refund layer.
func (s *Service) refundLatePayment(ctx context.Context, conv *store.Conversion, piID string, amount int64, why string) {
	if piID == "" {
		return
	}
	reason := ReasonLate
	if strings.HasPrefix(why, "account deletion") {
		reason = ReasonDeletion
	}
	var related store.CaseRelated
	switch {
	case strings.HasPrefix(conv.ID, "topup:"):
		related.TopupID = strings.TrimPrefix(conv.ID, "topup:")
	case strings.HasPrefix(conv.ID, "settle:"):
	default:
		related.ConversionIDs = []string{conv.ID}
	}
	if s.Store == nil {
		s.Stripe.RefundOrCancel(piID)
		return
	}
	s.refundExtraPayment(ctx, conv.UID, piID, amount, reason, why, related) // C12: an auto case, the ledger
}

// ---------------------------------------------------------------- E0-3

// resolveRunClocks resolves created runs whose clock ran out (E0-3): their
// current object is closed FIRST — paid means the run is paid, processing
// means it waits — and only an unpaid run expires, "not charged".
func (s *Service) resolveRunClocks(ctx context.Context) int {
	created, err := s.Store.ListByState(ctx, store.StateCreated, 200)
	if err != nil {
		return 0
	}
	now := time.Now().UTC()
	n := 0
	for _, c := range created {
		if c.ExpiresAt == nil || now.Before(*c.ExpiresAt) || c.Stripe.PIStatus == store.PICharging || c.Stripe.PIStatus == store.PIProcessing {
			continue
		}
		if c.CurrentPayment != nil {
			out, cerr := s.closePayment(c.CurrentPayment)
			if cerr != nil {
				slog.WarnContext(ctx, "run clock: payment not resolved", "conversion_id", c.ID, "err", cerr)
				continue
			}
			if out.Paid || out.Processing {
				if _, aerr := s.applyRunPayment(ctx, c.ID, *c.CurrentPayment, out); aerr == nil {
					n++
				}
				continue
			}
		}
		expired, terr := s.Store.Transition(ctx, c.ID, []string{store.StateCreated}, func(cc *store.Conversion) error {
			if cc.ExpiresAt == nil || now.Before(*cc.ExpiresAt) {
				return store.ErrStateConflict // a replace moved the clock
			}
			if (cc.CurrentPayment == nil) != (c.CurrentPayment == nil) ||
				(cc.CurrentPayment != nil && cc.CurrentPayment.ID != c.CurrentPayment.ID) {
				return store.ErrStateConflict
			}
			cc.State = store.StateExpired
			cc.Stripe.PIStatus = store.PICanceled
			cc.Stripe.CanceledAt = &now
			return nil
		})
		if terr == nil {
			s.restoreCredit(ctx, expired)
			n++
		}
	}
	return n
}

// ---------------------------------------------------------------- E0-4

// leaseOwner names this instance's lease holds.
var leaseOwner = "gw-" + store.NewID()

// acquireBatchLease takes a group's lease (E0-4) unless another holder's
// is live; the caller then is the only one charging it.
func (s *Service) acquireBatchLease(ctx context.Context, b *store.Batch) (*store.Batch, bool) {
	now := time.Now().UTC()
	updated, err := s.Store.TransitionBatch(ctx, b.ID, []string{store.BatchCharging, store.BatchOpen, store.BatchFailed}, func(bb *store.Batch) error {
		if bb.Lease.Held(now) && bb.Lease.Owner != leaseOwner {
			return store.ErrStateConflict
		}
		bb.Lease = &store.Lease{Owner: leaseOwner, Until: now.Add(leaseTTL)}
		return nil
	}, nil, nil)
	if err != nil {
		return b, false
	}
	return updated, true
}

// releaseBatchLease drops our lease (best effort; it lapses anyway).
func (s *Service) releaseBatchLease(ctx context.Context, id string) {
	_, _ = s.Store.TransitionBatch(ctx, id, []string{store.BatchCharging, store.BatchOpen, store.BatchFailed, store.BatchPaid}, func(bb *store.Batch) error {
		if bb.Lease == nil || bb.Lease.Owner != leaseOwner {
			return store.ErrStateConflict
		}
		bb.Lease = nil
		return nil
	}, nil, nil)
}

// chinaMode: the web app runs in China mode (no Stripe.js; server-side
// Alipay / WeChat Pay) and says so with X-Client-Mode: china.
func chinaMode(r *http.Request) bool {
	return r != nil && strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Client-Mode")), "china")
}

// errChinaPaymentsUnavailable answers a China-mode payment while config
// china_payments_enabled is off (owner 2026-11-07): 403
// china_payments_unavailable. The Alipay code stays, dark.
func errChinaPaymentsUnavailable() error {
	return httpx.Err(http.StatusForbidden, "china_payments_unavailable", "Payments in mainland China are coming soon.")
}

// chinaPaymentsOff: China-mode payments are switched off.
func (s *Service) chinaPaymentsOff(ctx context.Context) bool {
	return !s.rates(ctx).ChinaPaymentsEnabled
}
