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
// removed it: {deleted: true, sign_in_removed}. It deletes at once, as
// before the wait (svs-backend's own cleanup follows the answer).
//
// With account_delete_delay_hours > 0 (owner 2026-11-07, test: 48) the
// same checks run and collect the same dues, then the deletion is
// scheduled instead: 202 {success, deleted: false, state:
// "pending_deletion", pending_deletion: true, delete_after,
// requested_at, sign_in_removed: false, plan fields}. A repeat while
// pending answers the same delete_after without running anything. The
// client signs the person out; the sweep runs the deletion at
// delete_after (deletion_schedule.go).
func (s *Service) HandleDeleteAccount(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var body struct {
		BalanceConfirmed bool `json:"balance_confirmed"`
		KeepSignIn       bool `json:"keep_sign_in"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body)
	_, _, viaProxy := httpx.TrustedClientIP(ctx)
	keepSignIn := body.KeepSignIn && viaProxy
	o := deletionOpts{BalanceConfirmed: body.BalanceConfirmed, KeepSignIn: keepSignIn, Pay: payContextOf(r), By: "request"}
	if !user.Anonymous { // an anonymous account (no sign-in method) never waits
		o.Delay = s.accountDeleteDelay(ctx)
	}
	if o.Delay > 0 {
		if d := s.Store.PendingAccountDeletion(ctx, user.UID); d != nil { // idempotent: the same delete_after
			writeScheduledDeletion(w, d, nil)
			return
		}
		o.Email, o.Source = user.Email, "web"
		if viaProxy {
			o.Source = "api"
		}
	}
	status, out, err := s.runDeletion(ctx, user.UID, o)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(out)
}

// deletionOpts: how runDeletion runs.
type deletionOpts struct {
	BalanceConfirmed bool
	KeepSignIn       bool
	Pay              payContext
	// Delay > 0 schedules the deletion that far ahead once the checks
	// pass (the request); 0 runs it now (the sweep, the proxy, prod).
	Delay  time.Duration
	Email  string // the account's address for the schedule's mails
	Source string
	By     string // request | sweep | admin:<who>, on the schedule row
	// RequestedAt: when the person asked (a scheduled deletion's request).
	RequestedAt *time.Time
}

// runDeletion is the account deletion (unchanged since 2026-11-06, now
// shared by the request and the sweep): a renewing plan refuses, dues are
// collected, a cash balance needs balance_confirmed and waits for its
// closure case (202), and otherwise the account is soft-deleted (200).
// Refusals are *httpx.APIError with the plan merged into their details.
func (s *Service) runDeletion(ctx context.Context, uid string, o deletionOpts) (int, map[string]any, error) {
	cust, err := s.Store.GetCustomer(ctx, uid)
	// refusals carry the plan, so the sheet can say "Your Studio plan
	// won't renew" before the person confirms
	refuse := func(err error) (int, map[string]any, error) {
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
		return 0, nil, err
	}
	if errors.Is(err, store.ErrNotFound) {
		cust, err = nil, nil
	}
	if err != nil {
		return 0, nil, err
	}
	if cust != nil && cust.DeletionPending { // N8: already waiting for the closure case
		return http.StatusAccepted, pendingDeletionBody(cust.DeletionCaseID, 0, deletionPlan(cust)), nil
	}
	// Owner 2026-11-06: a renewing plan (a step-down waiting counts) is
	// cancelled first, by the person; it stays valid to its period end and
	// keeps running after the deletion. Checked before anything is charged.
	if planRenewing(cust) {
		return refuse(httpx.Err(http.StatusConflict, deleteBlockPlanRenewing,
			"Cancel your plan first. It stays valid until the end of the period you paid for."))
	}
	active, err := s.Store.CountActiveForUser(ctx, uid)
	if err != nil {
		return 0, nil, err
	}
	if active == 0 && cust != nil && cust.StripeCustomerID != "" {
		s.settleForDeletion(ctx, uid, cust.StripeCustomerID)
		s.payDebtsFromBalance(ctx, uid) // N8 step 2: debts from the balance first
		// C11 trigger=delete: off-session with backups; a live settle (P2
		// open, an iOS bank check) answers 402 balance_due with its amount.
		res, cerr := s.collectOutstanding(ctx, uid, settleDelete, o.Pay)
		if cerr == nil && res.Settle != nil && res.Settle.State == store.SettleSettling {
			e := httpx.Err(http.StatusPaymentRequired, deleteBlockOwed,
				"you have a payment to finish before we can delete your account")
			e.Details = map[string]any{"amount_cents": res.Settle.AmountCents, "settle_id": res.Settle.ID,
				"publishable_key": s.Stripe.PublishableKey}
			return refuse(e)
		}
	}

	unpaid, err := s.Store.ListUserByPIStatus(ctx, uid, store.PIChargeFailed, unpaidLimit)
	if err != nil {
		return 0, nil, err
	}
	failed, err := s.Store.ListUserBatchesByState(ctx, uid, store.BatchFailed, unpaidLimit)
	if err != nil {
		return 0, nil, err
	}
	charging, err := s.Store.ListUserBatchesByState(ctx, uid, store.BatchCharging, unpaidLimit)
	if err != nil {
		return 0, nil, err
	}
	open, err := s.Store.OpenBatchFor(ctx, uid)
	if err != nil {
		return 0, nil, err
	}
	minimum := s.Pricing.Rates(ctx).MinimumCents
	block := deletionBlock(active, len(unpaid), len(failed)+len(charging), open, minimum)
	switch block {
	case deleteBlockActive:
		e := httpx.Err(http.StatusConflict, deleteBlockActive,
			"cancel or wait for your running jobs before deleting your account")
		e.Details = map[string]any{"active": active}
		return refuse(e)
	case deleteBlockOwed:
		httpx.Log(ctx).Warn("account delete refused: balance due", "uid", uid,
			"unpaid", len(unpaid), "failed_batches", len(failed), "charging_batches", len(charging))
		return refuse(s.balanceDueErr(ctx, unpaid, failed, charging, open, minimum))
	}

	// N8 step 3: money left in the balance is refunded by a closure case;
	// the web confirms "Delete and refund" ({balance_confirmed: true}).
	// With cash to pay out, the deletion waits for that case's decision:
	// 202 {deleted: false, deletion_pending: true, case_id, refund_cents}.
	// Only cash counts (unspent top-ups): plan credit is never money; a
	// cancelled plan's credit is kept for Restore Purchases.
	b, berr := s.Store.GetBalance(ctx, uid)
	cash := berr == nil && b.Exists() && b.CashCents() > 0
	if cash && !o.BalanceConfirmed {
		e := httpx.Err(http.StatusConflict, "balance_remaining",
			fmt.Sprintf("You have %s left in your balance. We'll refund it to your payment method.", money(b.CashCents())))
		e.Details = map[string]any{"cents": b.CashCents(), "plan_credit_cents": b.PlanCreditCents()}
		return refuse(e)
	}

	// The 48-hour wait (owner 2026-11-07): everything above passed, so
	// the deletion is scheduled; the sweep comes back to this function at
	// delete_after. The closure case opens then, so a cancel has nothing
	// to undo.
	if o.Delay > 0 {
		return s.scheduleDeletion(ctx, uid, cust, o)
	}

	if cash {
		// N8b: the closure case (manual) refunds the unspent cash top-ups.
		cs, cerr := s.requestBalanceRefund(ctx, uid, ReasonClosure, "", "system", "customer", "account deletion")
		if cerr != nil {
			s.Slack.Alert(ctx, "closure_balance", fmt.Sprintf("account `%s` asked to delete with %s in its balance; case not opened: %v",
				uid, money(b.CashCents()), cerr))
			return 0, nil, httpx.Err(http.StatusBadGateway, "delete_failed", "could not delete your account; try again")
		}
		now := time.Now().UTC()
		requested := now
		if o.RequestedAt != nil {
			requested = *o.RequestedAt
		}
		if _, err := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
			c.DeletionPending, c.DeletionCaseID, c.DeletionRequestedAt = true, cs.ID, &requested
			c.DeletionKeepSignIn = o.KeepSignIn // svs-backend's: call back when the case completes it
			return nil
		}); err != nil {
			return 0, nil, err
		}
		s.pauseAutoReload(ctx, uid, "deletion")
		httpx.Log(ctx).Info("deletion waits for the closure case", "uid", uid, "case_id", cs.ID)
		if err := s.Store.FinishAccountDeletionRow(ctx, uid, o.By, store.DeletionOutcomeRefundCase, now); err != nil {
			slog.WarnContext(ctx, "deletion row not marked", "err", err)
		}
		after, _ := s.Store.GetCustomer(ctx, uid)
		return http.StatusAccepted, pendingDeletionBody(cs.ID, cs.RequestedCents, deletionPlan(after)), nil
	}

	if err := s.finishAccountDeletionKeeping(ctx, uid, o.KeepSignIn); err != nil {
		httpx.Log(ctx).Error("account delete failed", "uid", uid, "err", err)
		return 0, nil, httpx.Err(http.StatusBadGateway, "delete_failed", "could not delete your account; try again")
	}
	if err := s.Store.FinishAccountDeletionRow(ctx, uid, o.By, store.DeletionOutcomeDeleted, time.Now().UTC()); err != nil {
		slog.WarnContext(ctx, "deletion row not marked", "err", err)
	}
	pending := int64(0)
	if open != nil {
		pending = open.TotalCents // below the card minimum: left uncollected
	}
	httpx.Log(ctx).Info("account deleted", "uid", uid, "uncollected_cents", pending)
	out := map[string]any{"deleted": true, "sign_in_removed": !o.KeepSignIn && s.Auth != nil}
	if after, err := s.Store.GetCustomer(ctx, uid); err == nil {
		for k, v := range deletionPlan(after) { // a cancelled plan: valid until current_period_end
			out[k] = v
		}
	}
	return http.StatusOK, out, nil
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

func pendingDeletionBody(caseID string, cents int64, plan map[string]any) map[string]any {
	out := map[string]any{"success": true, "deleted": false, "deletion_pending": true,
		"case_id": caseID, "refund_cents": cents,
		"message": "We'll delete your account once your refund is decided, within 2 business days."}
	for k, v := range plan {
		out[k] = v
	}
	return out
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
	// Deletion never detaches payment methods: saved cards stay on the Stripe customer (owner 2026-11-06).
	now := time.Now().UTC()
	s.recordPlanRestore(ctx, uid) // a plan still in its period waits for Restore Purchases (before its credit and emails go)
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
	if n, err := s.Store.ReleaseAllAccountEmails(ctx, uid, "deleted"); err != nil { // free for a new account; rows kept for support and Restore
		slog.WarnContext(ctx, "account emails not released", "err", err)
	} else if n > 0 {
		slog.InfoContext(ctx, "account emails released", "count", n)
	}
	s.removeSamples(ctx, uid)                                                                                               // the onboarding sample goes with the account
	s.planCreditOpAll(ctx, uid, store.EntryPlanCreditRemoval, "deleted", "", "account deleted", "plancredit_deleted", true) // never paid out
	s.revokePlanEntitlement(ctx, uid, "account deleted")                                                                    // the app's business/studio, never pro
	s.rcAttrsClear(ctx, uid)                                                                                                // the web_* attributes go; delete_account is svs-backend's
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
		if s.closureDecided(ctx, c.DeletionCaseID) && s.finishAccountDeletionKeeping(ctx, uid, c.DeletionKeepSignIn) == nil {
			slog.InfoContext(ctx, "account deleted after its closure case", "uid", uid, "case_id", c.DeletionCaseID)
			if c.DeletionKeepSignIn { // asked through svs-backend: its cleanup starts now
				requested := time.Now().UTC()
				if c.DeletionRequestedAt != nil {
					requested = *c.DeletionRequestedAt
				}
				s.deletionCompleted(ctx, uid, requested, viaRefundCase)
			}
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
