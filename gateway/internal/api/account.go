package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Account deletion collects what the user owes before the account goes.
// Until 2026-10-28 the web app deleted only the sign-in (client-side
// user.delete()), so a deleted account kept its open batch and a failed
// $3.33 batch nobody could ever settle. Records stay whole (soft delete,
// the same rule as the other apps); the saved card stays too until the
// owner's manual cleanup.

// Reasons an account can't be deleted yet.
const (
	deleteBlockActive = "active_runs" // a run would bill after the account is gone
	deleteBlockOwed   = "balance_due" // a charge failed or is still in flight
)

// deletionBlock says why the account can't be deleted yet, or "" when
// nothing collectable is outstanding. A pending balance below the card
// minimum can't be charged on its own, so it doesn't block.
func deletionBlock(active, unpaid, failedBatches int, open *store.Batch, minimumCents int64) string {
	if active > 0 {
		return deleteBlockActive
	}
	if unpaid > 0 || failedBatches > 0 {
		return deleteBlockOwed
	}
	if open != nil && open.TotalCents >= minimumCents && open.TotalCents > 0 {
		return deleteBlockOwed
	}
	return ""
}

// settleForDeletion charges everything collectable now: failed batches and
// charges are retried on the current card, and the open batch is closed
// and charged without waiting for its window.
func (s *Service) settleForDeletion(ctx context.Context, uid, customerID string) {
	s.refreshCardCache(ctx, uid, customerID)
	s.closeWaitingRuns(ctx, uid)
	open, err := s.Store.OpenBatchFor(ctx, uid)
	if err != nil {
		httpx.Log(ctx).Warn("account delete: open batch lookup failed", "uid", uid, "err", err)
		return
	}
	if open == nil || open.TotalCents <= 0 || s.belowChargeMinimum(ctx, open) {
		return
	}
	if _, err := s.closeAndCharge(ctx, open.ID, store.BatchCloseAccountDelete); err != nil {
		httpx.Log(ctx).Warn("account delete: batch charge failed", "batch_id", open.ID, "err", err)
	}
}

// closeWaitingRuns is B12 step 1: every run still waiting for its payment
// has that payment closed; a run whose payment had completed is refunded
// in full (deletion_undelivered) and canceled, the rest expire.
func (s *Service) closeWaitingRuns(ctx context.Context, uid string) {
	runs, err := s.Store.ListUserConversions(ctx, uid, 200)
	if err != nil {
		return
	}
	now := time.Now().UTC()
	for _, c := range runs {
		if c.State != store.StateCreated || (c.PaymentFlow != store.FlowPayNow && c.PaymentFlow != store.FlowChina) {
			continue
		}
		out, cerr := s.closePayment(c.CurrentPayment)
		if cerr != nil {
			continue
		}
		if out.Paid {
			s.refundLatePayment(ctx, c, out.PaymentIntentID, out.AmountReceived, "account deletion closed a paid run before it started")
		}
		if expired, terr := s.Store.Transition(ctx, c.ID, []string{store.StateCreated}, func(cc *store.Conversion) error {
			cc.State = store.StateCanceled
			cc.Stripe.PIStatus = store.PICanceled
			cc.Stripe.CanceledAt = &now
			return nil
		}); terr == nil {
			s.restoreCredit(ctx, expired)
		}
	}
}

// POST /v1/account/delete — delete the caller's account once nothing is
// owed. Refuses with 409 active_runs while a run is going, and with 402
// balance_due (details: amount_cents, plus requires_action/client_secret
// for a 3DS challenge) when the outstanding charge didn't go through.
func (s *Service) HandleDeleteAccount(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	cust, err := s.Store.GetCustomer(ctx, user.UID)
	if errors.Is(err, store.ErrNotFound) {
		cust, err = nil, nil
	}
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	active, err := s.Store.CountActiveForUser(ctx, user.UID)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if active == 0 && cust != nil && cust.StripeCustomerID != "" {
		s.settleForDeletion(ctx, user.UID, cust.StripeCustomerID)
		s.payDebtsFromBalance(ctx, user.UID) // N8 step 2: debts from the balance first
		// C11 trigger=delete: off-session with backups; a live settle (P2
		// open, an iOS bank check) answers 402 balance_due with its amount.
		res, cerr := s.collectOutstanding(ctx, user.UID, settleDelete, payContextOf(r))
		if cerr == nil && res.Settle != nil && res.Settle.State == store.SettleSettling {
			e := httpx.Err(http.StatusPaymentRequired, deleteBlockOwed,
				"you have a payment to finish before we can delete your account")
			e.Details = map[string]any{"amount_cents": res.Settle.AmountCents, "settle_id": res.Settle.ID,
				"publishable_key": s.Stripe.PublishableKey}
			httpx.WriteErr(ctx, w, e)
			return
		}
	}

	unpaid, err := s.Store.ListUserByPIStatus(ctx, user.UID, store.PIChargeFailed, unpaidLimit)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	failed, err := s.Store.ListUserBatchesByState(ctx, user.UID, store.BatchFailed, unpaidLimit)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	charging, err := s.Store.ListUserBatchesByState(ctx, user.UID, store.BatchCharging, unpaidLimit)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	open, err := s.Store.OpenBatchFor(ctx, user.UID)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	minimum := s.Pricing.Rates(ctx).MinimumCents
	block := deletionBlock(active, len(unpaid), len(failed)+len(charging), open, minimum)
	switch block {
	case deleteBlockActive:
		e := httpx.Err(http.StatusConflict, deleteBlockActive,
			"cancel or wait for your running jobs before deleting your account")
		e.Details = map[string]any{"active": active}
		httpx.WriteErr(ctx, w, e)
		return
	case deleteBlockOwed:
		httpx.Log(ctx).Warn("account delete refused: balance due", "uid", user.UID,
			"unpaid", len(unpaid), "failed_batches", len(failed), "charging_batches", len(charging))
		httpx.WriteErr(ctx, w, s.balanceDueErr(ctx, unpaid, failed, charging, open, minimum))
		return
	}

	// N8 step 3: money left in the balance is refunded by a closure case;
	// the web confirms "Delete and refund" ({balance_confirmed: true}).
	if b, berr := s.Store.GetBalance(ctx, user.UID); berr == nil && b.Exists() && b.Available() > 0 {
		var body struct {
			BalanceConfirmed bool `json:"balance_confirmed"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if !body.BalanceConfirmed {
			e := httpx.Err(http.StatusConflict, "balance_remaining",
				fmt.Sprintf("You have %s left in your balance. We'll refund it to your payment method.", money(b.Available())))
			e.Details = map[string]any{"cents": b.Available()}
			httpx.WriteErr(ctx, w, e)
			return
		}
		// N8b: the closure case (manual) refunds the unspent cash top-ups;
		// the Stripe customer and its methods stay, so it can pay out
		// after the sign-in is gone.
		if b.CashCents() > 0 {
			if cs, cerr := s.requestBalanceRefund(ctx, user.UID, ReasonClosure, "", "system", "customer", "account deleted"); cerr != nil {
				s.Slack.Alert(ctx, "closure_balance", fmt.Sprintf("account `%s` deleted with %s in its balance; case not opened: %v",
					user.UID, money(b.Available()), cerr))
			} else {
				httpx.Log(ctx).Info("closure case opened", "uid", user.UID, "case_id", cs.ID)
			}
		}
	}

	now := time.Now().UTC()
	if cust != nil {
		if _, err := s.Store.UpdateCustomer(ctx, user.UID, func(c *store.Customer) error {
			c.AccountDeleted = true
			c.DeletedAt = &now
			return nil
		}); err != nil {
			httpx.WriteErr(ctx, w, err)
			return
		}
	}
	if err := s.Auth.DeleteUser(ctx, user.UID); err != nil {
		httpx.Log(ctx).Error("account delete: sign-in removal failed", "uid", user.UID, "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "delete_failed",
			"could not delete your account; try again"))
		return
	}
	pending := int64(0)
	if open != nil {
		pending = open.TotalCents // below the card minimum: left uncollected
	}
	httpx.Log(ctx).Info("account deleted", "uid", user.UID, "uncollected_cents", pending)
	httpx.WriteOK(w, map[string]any{"deleted": true})
}

// balanceDueErr is the 402 for a refused deletion: the amount owed, and
// the 3DS challenge when the bank asked for one.
func (s *Service) balanceDueErr(ctx context.Context, unpaid []*store.Conversion, failed, charging []*store.Batch,
	open *store.Batch, minimum int64) error {
	var cents int64
	details := map[string]any{}
	for _, b := range append(failed, charging...) {
		cents += b.TotalCents
	}
	for _, b := range failed {
		if details["requires_action"] == true {
			break
		}
		if entry := s.failedBatchEntry(ctx, b); entry["needs_action"] == true {
			details["requires_action"] = true
			details["client_secret"] = entry["client_secret"]
		}
	}
	for _, c := range unpaid {
		if c.Stripe.BatchID != "" {
			continue // counted with its batch
		}
		cents += c.Quote.AmountCents
		if details["requires_action"] != true {
			if entry := s.unpaidEntry(ctx, c); entry["needs_action"] == true {
				details["requires_action"] = true
				details["client_secret"] = entry["client_secret"]
			}
		}
	}
	if open != nil && open.TotalCents >= minimum {
		cents += open.TotalCents
	}
	details["amount_cents"] = cents
	details["publishable_key"] = s.Stripe.PublishableKey
	msg := "your unpaid balance couldn't be charged — update your payment method, then delete your account"
	if len(charging) > 0 && len(failed) == 0 && len(unpaid) == 0 {
		msg = "your last payment is still processing — try again in a minute"
	}
	e := httpx.Err(http.StatusPaymentRequired, deleteBlockOwed, msg)
	e.Details = details
	return e
}
