package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"slices"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Plan changes (owner 2026-11-04, test only), between pro_weekly <
// pro_monthly < pro_yearly < business < studio, and "none" (pay per
// video):
//   - A step-up takes effect now: a full new period from today
//     (billing_cycle_anchor=now, also at the same interval), charged today
//     less our credit for the old plan's unused part (oldPlanCredit, a
//     pending invoice item on the switch invoice; no Stripe proration).
//     The new plan's credit and free previews come in full that day.
//   - A step-down takes effect at the end of the paid period: a
//     subscription schedule switches the price then (→ none:
//     cancel_at_period_end). No charge, no refund; the current plan's
//     grants run to that date, the new one's start then.
//   - Business → Studio is on hold (proposal B): 409 change_on_hold.
// POST /v1/plans/preview-change {to} quotes it; POST /v1/plans/change {to,
// confirm: true, quote_at?} applies it (nothing changes without confirm);
// DELETE /v1/plans/scheduled-change takes a waiting step-down back.

const (
	changeStepUp   = "step_up"
	changeStepDown = "step_down"
	planNone       = "none"
	quoteValidFor  = 15 * time.Minute
)

var planOrder = []string{planNone, "pro_weekly", "pro_monthly", "pro_yearly", pricing.TierBusiness, pricing.TierStudio}

func planRank(id string) int { return slices.Index(planOrder, id) }

// creditShares are what's left of the old plan's period: time today;
// usage (the plan's credit and free previews) for a rule not in force yet.
type creditShares struct {
	TimeLeft  float64
	UsageLeft *float64 // nil: not used by today's rule
}

// oldPlanCredit is the credit for the old plan's unused part on a step-up:
// what they paid for the period (intro prices as paid) × the share of the
// period left. A pending owner rule may make it min(time, usage).
func oldPlanCredit(paidCents int64, sh creditShares) int64 {
	share := sh.TimeLeft // later: min(sh.TimeLeft, *sh.UsageLeft)
	share = max(0, min(1, share))
	return int64(math.Round(float64(paidCents) * share))
}

// timeLeftShare of the plan's current period at t.
func timeLeftShare(p *store.Plan, at time.Time) float64 {
	if p == nil || p.CurrentPeriodStart == nil || p.CurrentPeriodEnd == nil {
		return 0
	}
	total := p.CurrentPeriodEnd.Sub(*p.CurrentPeriodStart)
	if total <= 0 {
		return 0
	}
	return max(0, min(1, float64(p.CurrentPeriodEnd.Sub(at))/float64(total)))
}

// planTarget is a plan id's price and tier.
type planTarget struct {
	ID, Tier, Name, Interval string
	PriceCents               int64
	PriceID, LookupKey       string
}

func (s *Service) planTarget(ctx context.Context, id string) (planTarget, bool) {
	r := s.rates(ctx)
	if p, ok := r.ProPlan(id); ok {
		return planTarget{ID: id, Tier: pricing.TierPro, Name: "Pro", Interval: p.Interval, PriceCents: p.PriceCents,
			PriceID: p.StripePriceID, LookupKey: p.LookupKey}, true
	}
	if d, ok := r.Plan(id); ok {
		return planTarget{ID: id, Tier: id, Name: d.Name, Interval: d.Interval, PriceCents: d.PriceCents,
			PriceID: d.StripePriceID, LookupKey: planLookupKey(d, id)}, true
	}
	if id == planNone {
		return planTarget{ID: planNone, Name: "pay per video"}, true
	}
	return planTarget{}, false
}

func (s *Service) priceIDOf(t planTarget) (string, error) {
	if t.PriceID != "" {
		return t.PriceID, nil
	}
	return s.Stripe.PriceByLookupKey(t.LookupKey)
}

// planChangeQuote is a change worked out at quoteAt.
type planChangeQuote struct {
	Kind        string
	From, To    planTarget
	CreditCents int64
	TodayCents  int64
	RenewsAt    time.Time
	EffectiveAt time.Time
	QuoteAt     time.Time
}

func (q planChangeQuote) json() map[string]any {
	out := map[string]any{"kind": q.Kind, "from": q.From.ID, "to": q.To.ID, "today_cents": q.TodayCents,
		"new_plan_cents": q.To.PriceCents, "quote_at": q.QuoteAt.Unix()}
	if q.Kind == changeStepUp {
		out["unused_credit_cents"], out["renews_at"] = q.CreditCents, q.RenewsAt.Format(time.RFC3339)
	} else {
		out["effective_at"] = q.EffectiveAt.Format(time.RFC3339)
	}
	return out
}

// nextRenewal is at plus one interval (months clamped like Stripe's).
func nextRenewal(at time.Time, interval string) time.Time {
	switch interval {
	case "week":
		return at.AddDate(0, 0, 7)
	case "year":
		return store.AddMonths(at, 12)
	}
	return store.AddMonths(at, 1)
}

// quotePlanChange: the one place both the preview and the change price it.
func (s *Service) quotePlanChange(ctx context.Context, cust *store.Customer, to string, at time.Time) (*planChangeQuote, *httpx.APIError) {
	if cust == nil || cust.Plan == nil || !cust.Plan.Active(at) || cust.Plan.SubscriptionID == "" {
		return nil, httpx.Err(http.StatusNotFound, "no_plan", "you don't have a plan to change")
	}
	from, ok := s.planTarget(ctx, cust.Plan.Key())
	if !ok {
		return nil, httpx.Err(http.StatusConflict, "plan_unknown", "your current plan can't be changed here")
	}
	if to == "pay_per_video" {
		to = planNone // the same as /v1/billing/plan/cancel
	}
	target, ok := s.planTarget(ctx, to)
	if !ok {
		return nil, httpx.ErrInvalid("to is pro_weekly, pro_monthly, pro_yearly, business, studio or pay_per_video (none)")
	}
	if target.ID == from.ID {
		return nil, httpx.Err(http.StatusConflict, "same_plan", "that's your plan already")
	}
	if from.ID == pricing.TierBusiness && target.ID == pricing.TierStudio {
		return nil, httpx.Err(http.StatusConflict, "change_on_hold", "Business to Studio isn't available yet")
	}
	q := &planChangeQuote{From: from, To: target, QuoteAt: at}
	if planRank(target.ID) > planRank(from.ID) {
		paid := cust.Plan.PeriodPaidCents
		if paid <= 0 {
			paid = from.PriceCents
		}
		q.Kind = changeStepUp
		q.CreditCents = oldPlanCredit(paid, creditShares{TimeLeft: timeLeftShare(cust.Plan, at)})
		q.TodayCents = max(0, target.PriceCents-q.CreditCents)
		q.RenewsAt = nextRenewal(at, target.Interval)
		return q, nil
	}
	q.Kind = changeStepDown
	if cust.Plan.CurrentPeriodEnd != nil {
		q.EffectiveAt = *cust.Plan.CurrentPeriodEnd
	}
	return q, nil
}

// POST /v1/plans/preview-change {to} → step_up: {kind, from, to,
// today_cents, new_plan_cents, unused_credit_cents, renews_at, quote_at};
// step_down: {kind, from, to, today_cents: 0, new_plan_cents,
// effective_at, quote_at}.
func (s *Service) HandlePreviewPlanChange(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		To string `json:"to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	cust, _ := s.Store.GetCustomer(ctx, user.UID)
	q, qerr := s.quotePlanChange(ctx, cust, req.To, time.Now().UTC().Truncate(time.Second))
	if qerr != nil {
		httpx.WriteErr(ctx, w, qerr)
		return
	}
	httpx.WriteOK(w, q.json())
}

// POST /v1/plans/change {to, confirm: true, quote_at?} → {change, plan}.
// quote_at (from the preview, within 15 minutes) prices it exactly as
// previewed.
func (s *Service) HandlePlanChange(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		To      string `json:"to"`
		Confirm bool   `json:"confirm"`
		QuoteAt int64  `json:"quote_at"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	if !req.Confirm {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "confirm_required", "send confirm: true to change the plan"))
		return
	}
	now := time.Now().UTC().Truncate(time.Second)
	at := now
	if req.QuoteAt > 0 {
		at = time.Unix(req.QuoteAt, 0).UTC()
		if at.After(now) || now.Sub(at) > quoteValidFor {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "quote_expired", "that price has expired; preview the change again"))
			return
		}
	}
	cust, _ := s.Store.GetCustomer(ctx, user.UID)
	q, qerr := s.quotePlanChange(ctx, cust, req.To, at)
	if qerr != nil {
		httpx.WriteErr(ctx, w, qerr)
		return
	}
	var err error
	if q.Kind == changeStepUp {
		err = s.applyStepUp(ctx, cust, q)
	} else {
		err = s.scheduleStepDown(ctx, user.UID, cust, q)
	}
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	httpx.WriteOK(w, map[string]any{"change": q.json(), "plan": s.planJSON(ctx, user.UID)})
}

func (s *Service) applyStepUp(ctx context.Context, cust *store.Customer, q *planChangeQuote) error {
	p := cust.Plan
	priceID, err := s.priceIDOf(q.To)
	if err != nil || priceID == "" {
		return httpx.Err(http.StatusServiceUnavailable, "plan_unavailable", "that plan isn't available right now")
	}
	sub, err := s.Stripe.GetSubscription(p.SubscriptionID)
	if err != nil || sub.ItemID() == "" {
		return httpx.Err(http.StatusBadGateway, "payment_error", "couldn't read your plan; try again")
	}
	if p.ScheduleID != "" { // a waiting step-down gives way
		if rerr := s.Stripe.ReleaseSchedule(p.ScheduleID); rerr != nil {
			slog.WarnContext(ctx, "schedule not released", "schedule", p.ScheduleID, "err", rerr)
		}
	}
	key := fmt.Sprintf("planchange_%s_%s_%d", p.SubscriptionID, q.To.ID, q.QuoteAt.Unix())
	creditItem := ""
	if q.CreditCents > 0 {
		desc := fmt.Sprintf("Unused time on %s", q.From.Name)
		if creditItem, err = s.Stripe.AddPendingCredit(cust.StripeCustomerID, p.SubscriptionID, q.CreditCents, desc, key+"_credit"); err != nil {
			return httpx.Err(http.StatusBadGateway, "payment_error", "couldn't change the plan; try again")
		}
	}
	updated, err := s.Stripe.ChangePlan(stripex.PlanChange{SubscriptionID: p.SubscriptionID, ItemID: sub.ItemID(), PriceID: priceID,
		Metadata: map[string]string{"plan": q.To.Tier, "plan_id": q.To.ID, "changed_from": q.From.ID, "change_kind": changeStepUp}}, key)
	if err != nil {
		if creditItem != "" {
			if derr := s.Stripe.RemovePendingCredit(creditItem); derr != nil {
				s.Slack.Alert(ctx, "plan_change_credit_left", fmt.Sprintf("pending credit %s left after a failed change on %s: %v", creditItem, p.SubscriptionID, derr))
			}
		}
		if stripex.PaymentRequired(err) {
			return httpx.Err(http.StatusPaymentRequired, "payment_failed", "the payment didn't go through; your plan hasn't changed")
		}
		return httpx.Err(http.StatusBadGateway, "payment_error", "couldn't change the plan; try again")
	}
	s.syncPlan(ctx, updated)
	s.Store.UpdateCustomer(ctx, sub.Metadata["user_id"], func(c *store.Customer) error {
		if c.Plan != nil {
			c.Plan.ScheduleID, c.Plan.ScheduledTo, c.Plan.ScheduledAt = "", "", nil
		}
		return nil
	})
	slog.InfoContext(ctx, "plan stepped up", "subscription", p.SubscriptionID, "from", q.From.ID, "to", q.To.ID, "credit", q.CreditCents)
	return nil
}

func (s *Service) scheduleStepDown(ctx context.Context, uid string, cust *store.Customer, q *planChangeQuote) error {
	p := cust.Plan
	if p.ScheduleID != "" || p.CancelAtPeriodEnd {
		return httpx.Err(http.StatusConflict, "change_scheduled", "a change is already waiting; take it back first")
	}
	scheduleID := ""
	if q.To.ID == planNone {
		sub, err := s.Stripe.SetCancelAtPeriodEnd(p.SubscriptionID, true)
		if err != nil {
			return httpx.Err(http.StatusBadGateway, "payment_error", "couldn't change the plan; try again")
		}
		s.syncPlan(ctx, sub)
	} else {
		priceID, err := s.priceIDOf(q.To)
		if err != nil || priceID == "" {
			return httpx.Err(http.StatusServiceUnavailable, "plan_unavailable", "that plan isn't available right now")
		}
		key := fmt.Sprintf("planstepdown_%s_%s_%d", p.SubscriptionID, q.To.ID, q.QuoteAt.Unix())
		scheduleID, err = s.Stripe.ScheduleStepDown(p.SubscriptionID, priceID,
			map[string]string{"plan": q.To.Tier, "plan_id": q.To.ID, "changed_from": q.From.ID, "change_kind": changeStepDown}, key)
		if err != nil {
			if scheduleID != "" {
				s.Stripe.ReleaseSchedule(scheduleID)
			}
			return httpx.Err(http.StatusBadGateway, "payment_error", "couldn't schedule the change; try again")
		}
	}
	eff := q.EffectiveAt
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if c.Plan != nil && c.Plan.SubscriptionID == p.SubscriptionID {
			c.Plan.ScheduleID, c.Plan.ScheduledTo, c.Plan.ScheduledAt = scheduleID, q.To.ID, &eff
		}
		return nil
	})
	return nil
}

// DELETE /v1/plans/scheduled-change → the plan ("Keep Studio").
func (s *Service) HandleCancelScheduledChange(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	cust, err := s.Store.GetCustomer(ctx, user.UID)
	if err != nil || cust.Plan == nil || (cust.Plan.ScheduledTo == "" && !cust.Plan.CancelAtPeriodEnd) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusNotFound, "no_scheduled_change", "no change is waiting"))
		return
	}
	p := cust.Plan
	if p.ScheduleID != "" {
		if err := s.Stripe.ReleaseSchedule(p.ScheduleID); err != nil {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "couldn't keep your plan; try again"))
			return
		}
	}
	if p.CancelAtPeriodEnd {
		sub, err := s.Stripe.SetCancelAtPeriodEnd(p.SubscriptionID, false)
		if err != nil {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "couldn't keep your plan; try again"))
			return
		}
		s.syncPlan(ctx, sub)
	}
	s.Store.UpdateCustomer(ctx, user.UID, func(c *store.Customer) error {
		if c.Plan != nil {
			c.Plan.ScheduleID, c.Plan.ScheduledTo, c.Plan.ScheduledAt = "", "", nil
		}
		return nil
	})
	httpx.WriteOK(w, s.planJSON(ctx, user.UID))
}

// planPeriodPaid records what the period's plan line cost.
func (s *Service) planPeriodPaid(ctx context.Context, uid string, sub *stripex.Subscription, paid int64) {
	if paid <= 0 {
		return
	}
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if c.Plan != nil && c.Plan.SubscriptionID == sub.ID {
			c.Plan.PeriodPaidCents = paid
		}
		return nil
	})
}

// stepDownApplied: the switch date's invoice is paid. The waiting change
// is done; a Business or Studio entitlement the new plan doesn't have
// goes (pro stays: the new grant covers it).
func (s *Service) stepDownApplied(ctx context.Context, uid string, sub *stripex.Subscription) {
	from := sub.Metadata["changed_from"]
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil || cust.Plan == nil {
		return
	}
	if cust.Plan.ScheduledTo != "" && cust.Plan.ScheduledTo == cust.Plan.Key() {
		s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
			if c.Plan != nil {
				c.Plan.ScheduleID, c.Plan.ScheduledTo, c.Plan.ScheduledAt = "", "", nil
			}
			return nil
		})
	}
	if (from == pricing.TierBusiness || from == pricing.TierStudio) && from != cust.Plan.Tier && s.RevenueCat.CanGrant() {
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		if err := s.RevenueCat.RevokePromotionals(rctx, uid, from); err != nil {
			s.Slack.Alert(ctx, "rc_revoke_failed", fmt.Sprintf("RevenueCat %s not revoked for `%s` after a step-down: %v", from, uid, err))
		}
	}
}

// scheduledChangeJSON is the plan block's scheduled_change (nil = none).
func scheduledChangeJSON(p *store.Plan) any {
	switch {
	case p == nil:
		return nil
	case p.ScheduledTo != "" && p.ScheduledAt != nil:
		return map[string]any{"to": p.ScheduledTo, "effective_at": p.ScheduledAt.Format(time.RFC3339)}
	case p.CancelAtPeriodEnd && p.CurrentPeriodEnd != nil:
		return map[string]any{"to": planNone, "effective_at": p.CurrentPeriodEnd.Format(time.RFC3339)}
	}
	return nil
}

// proIntroCycle puts Weekly Pro's intro coupon on its next cycles' draft
// invoices (the first had it at Checkout), once each, up to the intro's
// cycles (invoice.created).
func (s *Service) proIntroCycle(ctx context.Context, raw json.RawMessage) {
	var inv struct {
		ID            string `json:"id"`
		Status        string `json:"status"`
		BillingReason string `json:"billing_reason"`
		Parent        struct {
			SubscriptionDetails struct {
				Subscription string            `json:"subscription"`
				Metadata     map[string]string `json:"metadata"`
			} `json:"subscription_details"`
		} `json:"parent"`
	}
	if json.Unmarshal(raw, &inv) != nil || inv.Status != "draft" || inv.BillingReason != "subscription_cycle" {
		return
	}
	md := inv.Parent.SubscriptionDetails.Metadata
	uid := md["user_id"]
	if md["product"] != "svs-web" || md["env"] != s.Cfg.Env || md["plan"] != pricing.TierPro || uid == "" {
		return
	}
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil || cust.Plan == nil || !cust.Plan.Intro || cust.Plan.SubscriptionID != inv.Parent.SubscriptionDetails.Subscription {
		return
	}
	def, ok := s.rates(ctx).ProPlan(cust.Plan.PlanID)
	if !ok || def.Intro == nil || def.Intro.Cycles <= 1 || slices.Contains(cust.Plan.IntroInvoices, inv.ID) ||
		len(cust.Plan.IntroInvoices) >= def.Intro.Cycles-1 {
		return
	}
	if err := s.Stripe.AddInvoiceCoupon(inv.ID, def.Intro.CouponID); err != nil {
		slog.WarnContext(ctx, "pro intro not applied", "invoice", inv.ID, "err", err)
		return
	}
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if c.Plan != nil && !slices.Contains(c.Plan.IntroInvoices, inv.ID) {
			c.Plan.IntroInvoices = append(c.Plan.IntroInvoices, inv.ID)
		}
		return nil
	})
}
