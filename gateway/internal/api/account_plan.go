package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The person's own cancel and resume of a web plan (Business, Studio,
// web Pro), for clients that only need the renewal switch (the app through
// svs-backend, before the web's billing page is on prod):
//
//   - POST /v1/account/plan/cancel → {plan, plan_id, cancel_at_period_end:
//     true, current_period_end}: the plan stays until current_period_end
//     and doesn't renew. A waiting step-down is replaced (its schedule
//     released). Idempotent.
//   - POST /v1/account/plan/resume → the same with cancel_at_period_end
//     false: it renews again (a released step-down is not brought back).
//   - 404 no_plan without a current plan; 502 plan_unavailable when Stripe
//     fails (try again).

func (s *Service) currentPlan(ctx context.Context, uid string) (*store.Customer, error) {
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil || cust.Plan == nil || cust.Plan.SubscriptionID == "" || !cust.Plan.Active(time.Now()) {
		return nil, httpx.Err(http.StatusNotFound, "no_plan", "you don't have a plan")
	}
	return cust, nil
}

// cancelPlanAtPeriodEnd ends the plan at its period end, replacing a
// waiting step-down, and mirrors it on the account.
func (s *Service) cancelPlanAtPeriodEnd(ctx context.Context, uid string, cust *store.Customer) error {
	p := cust.Plan
	if err := s.endAtPeriodEnd(ctx, p.SubscriptionID); err != nil {
		return err
	}
	sub, err := s.Stripe.GetSubscription(p.SubscriptionID)
	if err != nil {
		return err
	}
	s.syncPlan(ctx, sub)
	end := p.CurrentPeriodEnd
	_, err = s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if c.Plan != nil && c.Plan.SubscriptionID == p.SubscriptionID {
			c.Plan.CancelAtPeriodEnd = true
			c.Plan.ScheduleID, c.Plan.ScheduledTo, c.Plan.ScheduledAt = "", planNone, end
		}
		return nil
	})
	return err
}

func (s *Service) planSwitchJSON(ctx context.Context, uid string) map[string]any {
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil {
		return map[string]any{}
	}
	if out := deletionPlan(cust); out != nil {
		return out
	}
	return map[string]any{}
}

// POST /v1/account/plan/cancel.
func (s *Service) HandleAccountPlanCancel(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	cust, err := s.currentPlan(ctx, user.UID)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if err := s.cancelPlanAtPeriodEnd(ctx, user.UID, cust); err != nil {
		httpx.WriteErr(ctx, w, planStripeFailure(ctx, "plan_cancel", err, "couldn't cancel your plan; try again"))
		return
	}
	httpx.WriteOK(w, s.planSwitchJSON(ctx, user.UID))
}

// POST /v1/account/plan/resume.
func (s *Service) HandleAccountPlanResume(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	cust, err := s.currentPlan(ctx, user.UID)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	p := cust.Plan
	if p.CancelAtPeriodEnd && planNotRenewable(p) {
		httpx.WriteErr(ctx, w, errNotRenewable(p))
		return
	}
	if p.CancelAtPeriodEnd {
		sub, err := s.Stripe.SetCancelAtPeriodEnd(p.SubscriptionID, false)
		if err != nil {
			httpx.WriteErr(ctx, w, planStripeFailure(ctx, "plan_resume", err, "couldn't keep your plan; try again"))
			return
		}
		s.syncPlan(ctx, sub)
		s.Store.UpdateCustomer(ctx, user.UID, func(c *store.Customer) error {
			if c.Plan != nil && c.Plan.SubscriptionID == p.SubscriptionID {
				c.Plan.CancelAtPeriodEnd = false
				if c.Plan.ScheduledTo == planNone {
					c.Plan.ScheduledTo, c.Plan.ScheduledAt = "", nil
				}
			}
			return nil
		})
	}
	httpx.WriteOK(w, s.planSwitchJSON(ctx, user.UID))
}

// GET /v1/account/delete: what a delete would do, without doing it (no
// charge, no change), so the app and the web show the right sheet first:
//
//	{can_delete, block: deletion_pending | plan_renewing | active_runs |
//	 null, plan_state: renewing | cancelled | none, plan?, plan_id?,
//	 current_period_end?, cancel_at_period_end?, active_runs, dues_cents,
//	 balance_cents, cash_balance_cents, plan_credit_cents,
//	 balance_confirmation_needed, waits_for_refund_case,
//	 deletion_pending, case_id?, pending_deletion, delete_after,
//	 delete_delay_hours}
//
// pending_deletion/delete_after: the 48-hour wait (deletion_schedule.go);
// deletion_pending is the older wait for a refund case.
//
// Only cash_balance_cents (unspent top-ups) is refunded and asks for a
// confirmation. plan_credit_cents is informational: plan credit is never
// money, and a cancelled plan's is kept for Restore Purchases.
//
// dues_cents is charged to the card on file when the delete goes ahead
// (402 balance_due if that charge can't be made); with a balance the
// delete first answers 409 balance_remaining until {balance_confirmed:
// true}, and with cash in it waits for the refund case (202).
func (s *Service) HandleDeletePreview(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	cust, err := s.Store.GetCustomer(ctx, user.UID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if err != nil {
		cust = nil
	}
	out := map[string]any{"plan_state": "none", "deletion_pending": cust != nil && cust.DeletionPending}
	s.addDeletionState(ctx, user.UID, out) // the 48-hour wait: pending_deletion, delete_after
	out["delete_delay_hours"] = int(s.accountDeleteDelay(ctx) / time.Hour)
	for k, v := range deletionPlan(cust) {
		out[k] = v
	}
	if plan := deletionPlan(cust); plan != nil {
		out["plan_state"] = "cancelled"
		if planRenewing(cust) {
			out["plan_state"] = "renewing"
		}
	}
	active, err := s.Store.CountActiveForUser(ctx, user.UID)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	out["active_runs"] = active
	var dues int64
	unpaid, err := s.Store.ListUserByPIStatus(ctx, user.UID, store.PIChargeFailed, unpaidLimit)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	for _, c := range unpaid {
		if c.Stripe.BatchID == "" {
			dues += c.Quote.AmountCents
		}
	}
	for _, st := range []string{store.BatchFailed, store.BatchCharging} {
		bs, err := s.Store.ListUserBatchesByState(ctx, user.UID, st, unpaidLimit)
		if err != nil {
			httpx.WriteErr(ctx, w, err)
			return
		}
		for _, b := range bs {
			dues += b.TotalCents
		}
	}
	if open, err := s.Store.OpenBatchFor(ctx, user.UID); err == nil && open != nil && !s.belowChargeMinimum(ctx, open) {
		dues += open.TotalCents
	}
	out["dues_cents"] = dues
	var balance, cash, planCredit int64
	if b, err := s.Store.GetBalance(ctx, user.UID); err == nil && b.Exists() {
		balance, cash, planCredit = b.Available(), b.CashCents(), b.PlanCreditCents()
	}
	out["balance_cents"], out["cash_balance_cents"], out["plan_credit_cents"] = balance, cash, planCredit
	block := any(nil)
	switch {
	case cust != nil && cust.DeletionPending:
		block = "deletion_pending"
		out["case_id"] = cust.DeletionCaseID
	case planRenewing(cust):
		block = deleteBlockPlanRenewing
	case active > 0:
		block = deleteBlockActive
	}
	out["block"] = block
	// not a block: the delete asks {balance_confirmed: true} first, and
	// with cash in it waits for the refund case (202)
	out["balance_confirmation_needed"] = cash > 0
	out["waits_for_refund_case"] = cash > 0
	out["can_delete"] = block == nil
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, out)
}
