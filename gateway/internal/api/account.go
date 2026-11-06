package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
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
//
// Body (optional): {balance_confirmed?: bool, keep_sign_in?: bool}.
// keep_sign_in (honoured only from svs-backend, with its proxy key) leaves
// the Firebase user for svs-backend to remove last; the answer says who
// removed it: {deleted: true, sign_in_removed}.
func (s *Service) HandleDeleteAccount(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var body struct {
		BalanceConfirmed bool `json:"balance_confirmed"`
		KeepSignIn       bool `json:"keep_sign_in"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body)
	_, _, viaProxy := httpx.TrustedClientIP(ctx)
	keepSignIn := body.KeepSignIn && viaProxy
	cust, err := s.Store.GetCustomer(ctx, user.UID)
	// refusals carry the plan, so the sheet can say "Your Studio plan
	// won't renew" before the person confirms
	refuse := func(err error) {
		var api *httpx.APIError
		if errors.As(err, &api) && api.Status != http.StatusBadGateway {
			if plan := deletionPlan(cust); plan != nil {
				if api.Details == nil {
					api.Details = map[string]any{}
				}
				for k, v := range plan {
					api.Details[k] = v
				}
			}
		}
		httpx.WriteErr(ctx, w, err)
	}
	if errors.Is(err, store.ErrNotFound) {
		cust, err = nil, nil
	}
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if cust != nil && cust.DeletionPending { // N8: already waiting for the closure case
		writePendingDeletion(w, cust.DeletionCaseID, 0, deletionPlan(cust))
		return
	}
	// Owner 2026-11-06: a renewing plan (a step-down waiting counts) is
	// cancelled first, by the person; it stays valid to its period end and
	// keeps running after the deletion. Checked before anything is charged.
	if planRenewing(cust) {
		e := httpx.Err(http.StatusConflict, deleteBlockPlanRenewing,
			"Cancel your plan first. It stays valid until the end of the period you paid for.")
		refuse(e)
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
			refuse(e)
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
		refuse(e)
		return
	case deleteBlockOwed:
		httpx.Log(ctx).Warn("account delete refused: balance due", "uid", user.UID,
			"unpaid", len(unpaid), "failed_batches", len(failed), "charging_batches", len(charging))
		refuse(s.balanceDueErr(ctx, unpaid, failed, charging, open, minimum))
		return
	}

	// N8 step 3: money left in the balance is refunded by a closure case;
	// the web confirms "Delete and refund" ({balance_confirmed: true}).
	// With cash to pay out, the deletion waits for that case's decision:
	// 202 {deleted: false, deletion_pending: true, case_id, refund_cents}.
	if b, berr := s.Store.GetBalance(ctx, user.UID); berr == nil && b.Exists() && b.Available() > 0 {
		if !body.BalanceConfirmed {
			e := httpx.Err(http.StatusConflict, "balance_remaining",
				fmt.Sprintf("You have %s left in your balance. We'll refund it to your payment method.", money(b.Available())))
			e.Details = map[string]any{"cents": b.Available()}
			refuse(e)
			return
		}
		// N8b: the closure case (manual) refunds the unspent cash top-ups;
		// non-cash credit is never paid out, so without cash the deletion
		// goes ahead now.
		if b.CashCents() > 0 {
			cs, cerr := s.requestBalanceRefund(ctx, user.UID, ReasonClosure, "", "system", "customer", "account deletion")
			if cerr != nil {
				s.Slack.Alert(ctx, "closure_balance", fmt.Sprintf("account `%s` asked to delete with %s in its balance; case not opened: %v",
					user.UID, money(b.Available()), cerr))
				httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "delete_failed", "could not delete your account; try again"))
				return
			}
			now := time.Now().UTC()
			if _, err := s.Store.UpdateCustomer(ctx, user.UID, func(c *store.Customer) error {
				c.DeletionPending, c.DeletionCaseID, c.DeletionRequestedAt = true, cs.ID, &now
				return nil
			}); err != nil {
				httpx.WriteErr(ctx, w, err)
				return
			}
			s.pauseAutoReload(ctx, user.UID, "deletion")
			httpx.Log(ctx).Info("deletion waits for the closure case", "uid", user.UID, "case_id", cs.ID)
			after, _ := s.Store.GetCustomer(ctx, user.UID)
			writePendingDeletion(w, cs.ID, cs.RequestedCents, deletionPlan(after))
			return
		}
	}

	if err := s.finishAccountDeletionKeeping(ctx, user.UID, keepSignIn); err != nil {
		httpx.Log(ctx).Error("account delete failed", "uid", user.UID, "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "delete_failed",
			"could not delete your account; try again"))
		return
	}
	pending := int64(0)
	if open != nil {
		pending = open.TotalCents // below the card minimum: left uncollected
	}
	httpx.Log(ctx).Info("account deleted", "uid", user.UID, "uncollected_cents", pending)
	out := map[string]any{"deleted": true, "sign_in_removed": !keepSignIn && s.Auth != nil}
	if after, err := s.Store.GetCustomer(ctx, user.UID); err == nil {
		for k, v := range deletionPlan(after) { // a cancelled plan: valid until current_period_end
			out[k] = v
		}
	}
	httpx.WriteOK(w, out)
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

func writePendingDeletion(w http.ResponseWriter, caseID string, cents int64, plan map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	out := map[string]any{"success": true, "deleted": false, "deletion_pending": true,
		"case_id": caseID, "refund_cents": cents,
		"message": "We'll delete your account once your refund is decided, within 2 business days."}
	for k, v := range plan {
		out[k] = v
	}
	_ = json.NewEncoder(w).Encode(out)
}

// deleteBlockPlanRenewing: the plan renews; cancel it first.
const deleteBlockPlanRenewing = "plan_renewing"

// deletionPlan is the account's web plan for the deletion answers (svs-app
// contract): {plan: business|studio|pro, plan_id, current_period_end,
// cancel_at_period_end}; nil without a current plan. Merged into the
// answer (or the refusal's details) at its top level.
func deletionPlan(c *store.Customer) map[string]any {
	if c == nil || c.Plan == nil || c.Plan.SubscriptionID == "" || !c.Plan.Active(time.Now()) {
		return nil
	}
	out := map[string]any{"plan": c.Plan.Tier, "plan_id": c.Plan.Key(), "cancel_at_period_end": c.Plan.CancelAtPeriodEnd}
	if c.Plan.CurrentPeriodEnd != nil {
		out["current_period_end"] = c.Plan.CurrentPeriodEnd.UTC().Format(time.RFC3339)
	}
	return out
}

// planRenewing: the account's web plan will renew (not cancelled at the
// period end; a scheduled step-down still renews, a scheduled cancel
// doesn't).
func planRenewing(c *store.Customer) bool {
	return c != nil && c.Plan != nil && c.Plan.SubscriptionID != "" && c.Plan.Active(time.Now()) && !c.Plan.CancelAtPeriodEnd
}

func errDeletionPending() error {
	return httpx.Err(http.StatusForbidden, "deletion_pending", "your account is being deleted once your refund is decided")
}

// finishAccountDeletion soft-deletes the customer record and removes the
// sign-in. Saved methods are never detached (B12 step 5).
func (s *Service) finishAccountDeletion(ctx context.Context, uid string) error {
	return s.finishAccountDeletionKeeping(ctx, uid, false)
}

// finishAccountDeletionKeeping: keepSignIn leaves the Firebase user for
// the caller to remove last (svs-backend, which still needs it for its own
// steps). A cancelled plan is left running to its period end (owner
// 2026-11-06): the Stripe customer, email, plan dates and credits already
// granted stay for Restore Purchases; nothing is granted again.
func (s *Service) finishAccountDeletionKeeping(ctx context.Context, uid string, keepSignIn bool) error {
	now := time.Now().UTC()
	if _, err := s.Store.GetCustomer(ctx, uid); err == nil {
		if _, err := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
			c.AccountDeleted = true
			c.DeletedAt = &now
			c.DeletionPending = false
			return nil
		}); err != nil {
			return err
		}
	}
	if n, err := s.Store.DeleteUserCustomerPasskeys(ctx, uid); err != nil { // ADR 0136: the passkeys go with the account
		return err
	} else if n > 0 {
		slog.InfoContext(ctx, "passkeys removed with the account", "count", n)
	}
	s.removeSamples(ctx, uid)                                                                                      // the onboarding sample goes with the account
	s.planCreditOp(ctx, uid, store.EntryPlanCreditRemoval, "deleted", "", "account deleted", "plancredit_deleted") // never paid out
	s.revokePlanEntitlement(ctx, uid, "account deleted")                                                           // the app's business/studio, never pro
	if s.Auth == nil || keepSignIn {
		return nil
	}
	return s.Auth.DeleteUser(ctx, uid) // a missing user is fine
}

// finishPendingDeletions deletes accounts whose closure case has been
// decided (N8 step 3), from the cases sweep and after an admin decision.
func (s *Service) finishPendingDeletions(ctx context.Context) int {
	pending, err := s.Store.ListPendingDeletions(ctx, 100)
	if err != nil {
		return 0
	}
	n := 0
	for uid, c := range pending {
		if planRenewing(c) { // resumed while the case was decided: the person cancels it first
			slog.WarnContext(ctx, "pending deletion waits: the plan renews again", "uid", uid)
			continue
		}
		if s.closureDecided(ctx, c.DeletionCaseID) && s.finishAccountDeletion(ctx, uid) == nil {
			slog.InfoContext(ctx, "account deleted after its closure case", "uid", uid, "case_id", c.DeletionCaseID)
			n++
		}
	}
	return n
}

func (s *Service) closureDecided(ctx context.Context, caseID string) bool {
	if caseID == "" {
		return true
	}
	cs, err := s.Store.GetCase(ctx, caseID)
	if err != nil {
		return false
	}
	return !cs.Open || cs.Decision != nil
}
