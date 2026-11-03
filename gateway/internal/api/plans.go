package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Web plans (pricing 2026-11, test only): Business $299/month with $400
// of credit, Studio $999 with $1,500, each spent at the plan's own prices
// (its tier), the credit gone at the period's end; usage beyond it at the
// plan's prices from the balance or a card. Stripe Billing runs the
// subscription; customer.subscription.* mirrors it on the account and
// invoice.paid grants each period's credit (non-cash, in the ledger).

func planLookupKey(tier string) string { return "svs_web_" + tier + "_monthly" }

// POST /v1/billing/plan {plan: business|studio, ui: elements|hosted_page}
// → {checkout {client_secret, expires_at}, url?, plan, publishable_key}.
// 409 plan_active when the account already has a plan (cancel it first).
func (s *Service) HandleStartPlan(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		Plan string `json:"plan"`
		UI   string `json:"ui"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	def, ok := s.rates(ctx).Plan(req.Plan)
	if !ok {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "unknown_plan", "plan must be business or studio"))
		return
	}
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	cust, _ := s.Store.GetCustomer(ctx, user.UID)
	if cust != nil && cust.Plan.Active(time.Now()) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "plan_active", "you already have a plan; cancel it before choosing another"))
		return
	}
	if cust != nil && cust.UnderReview {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusForbidden, "under_review", "we're checking a payment on your account; contact support to continue"))
		return
	}
	priceID := def.StripePriceID
	if priceID == "" {
		if priceID, err = s.Stripe.PriceByLookupKey(planLookupKey(req.Plan)); err != nil || priceID == "" {
			httpx.Log(ctx).Error("plan price missing", "plan", req.Plan, "err", err)
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusServiceUnavailable, "plan_unavailable", "plans aren't available right now"))
			return
		}
	}
	ui := "elements"
	if req.UI == "hosted_page" || req.UI == "hosted" {
		ui = "hosted_page"
	}
	sess, err := s.Stripe.CreatePlanSession(stripex.PlanSessionSpec{
		CustomerID: customerID, PMC: s.Cfg.StripePMCWeb, PriceID: priceID, UI: ui, Tier: req.Plan, UID: user.UID,
		ReturnURL: s.Cfg.SiteURL + "/account/billing?plan=" + req.Plan, // the web keeps /billing redirecting there
		IdemKey:   fmt.Sprintf("plan_%s_%s_%s_%d", s.Cfg.Env, user.UID, req.Plan, time.Now().Unix()/60),
	})
	if err != nil {
		httpx.Log(ctx).Error("plan session failed", "plan", req.Plan, "err", stripex.ErrMessage(err))
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "the payment couldn't be opened; try again"))
		return
	}
	exp := sess.Expires()
	resp := map[string]any{"plan": req.Plan, "publishable_key": s.Stripe.PublishableKey,
		"checkout": map[string]any{"client_secret": sess.ClientSecret, "expires_at": exp.Format(time.RFC3339)}}
	if ui == "hosted_page" {
		resp["url"] = sess.URL
	}
	httpx.WriteOK(w, resp)
}

// POST /v1/billing/plan/cancel {resume?: bool} → the plan: cancels at the
// period's end (the credit and prices last until then), or resumes.
func (s *Service) HandleCancelPlan(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		Resume bool `json:"resume"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	cust, err := s.Store.GetCustomer(ctx, user.UID)
	if err != nil || cust.Plan == nil || cust.Plan.SubscriptionID == "" || !cust.Plan.Active(time.Now()) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusNotFound, "no_plan", "you don't have a plan"))
		return
	}
	sub, err := s.Stripe.SetCancelAtPeriodEnd(cust.Plan.SubscriptionID, !req.Resume)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "couldn't change the plan; try again"))
		return
	}
	s.syncPlan(ctx, sub)
	httpx.WriteOK(w, s.planJSON(ctx, user.UID))
}

// planJSON is the account's plan for GET /v1/billing (nil without one).
func (s *Service) planJSON(ctx context.Context, uid string) map[string]any {
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil || cust.Plan == nil || cust.Plan.Tier == "" {
		return nil
	}
	p := cust.Plan
	out := map[string]any{"plan": p.Tier, "status": p.Status, "active": p.Active(time.Now()), "cancel_at_period_end": p.CancelAtPeriodEnd}
	if def, ok := s.rates(ctx).Plan(p.Tier); ok {
		out["name"], out["monthly_cents"], out["credit_cents"] = def.Name, def.MonthlyCents, def.CreditCents
	}
	if p.CurrentPeriodEnd != nil {
		out["current_period_end"] = p.CurrentPeriodEnd.Format(time.RFC3339)
	}
	if b, berr := s.Store.GetBalance(ctx, uid); berr == nil {
		out["credit_left_cents"] = b.PlanCreditCents()
	}
	return out
}

// syncPlan mirrors a subscription of ours onto the account.
func (s *Service) syncPlan(ctx context.Context, sub *stripex.Subscription) {
	if sub == nil || sub.Metadata["product"] != "svs-web" || sub.Metadata["env"] != s.Cfg.Env {
		return
	}
	uid, tier := sub.Metadata["user_id"], sub.Metadata["plan"]
	if uid == "" || tier == "" {
		return
	}
	start, end := sub.Period()
	if _, err := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if c.Plan != nil && c.Plan.SubscriptionID != "" && c.Plan.SubscriptionID != sub.ID && c.Plan.Active(time.Now()) && sub.Status != "active" {
			return nil // an older or incomplete subscription doesn't replace the live one
		}
		next := &store.Plan{Tier: tier, SubscriptionID: sub.ID, Status: sub.Status, CurrentPeriodStart: &start,
			CurrentPeriodEnd: &end, CancelAtPeriodEnd: sub.CancelAtPeriodEnd, UpdatedAt: time.Now().UTC()}
		if c.Plan != nil && c.Plan.SubscriptionID == sub.ID { // keep the RevenueCat grant record
			next.RCGrantInvoice, next.RCGrantedUntil, next.RCGrantError = c.Plan.RCGrantInvoice, c.Plan.RCGrantedUntil, c.Plan.RCGrantError
			next.RCRevokedAt, next.RCRevokeReason = c.Plan.RCRevokedAt, c.Plan.RCRevokeReason
		}
		c.Plan = next
		return nil
	}); err != nil {
		slog.WarnContext(ctx, "plan not recorded", "uid", uid, "subscription", sub.ID, "err", err)
		return
	}
	slog.InfoContext(ctx, "plan synced", "uid", uid, "plan", tier, "status", sub.Status)
}

// handleSubscriptionEvent: customer.subscription.created/updated/deleted.
func (s *Service) handleSubscriptionEvent(ctx context.Context, raw json.RawMessage) {
	var sub stripex.Subscription
	if json.Unmarshal(raw, &sub) != nil || sub.ID == "" {
		return
	}
	if fresh, err := s.Stripe.GetSubscription(sub.ID); err == nil {
		sub = *fresh // events can arrive out of order: read the current one
	}
	s.syncPlan(ctx, &sub)
}

// handlePlanInvoicePaid grants a period's credit when its invoice is paid
// (once per invoice).
func (s *Service) handlePlanInvoicePaid(ctx context.Context, raw json.RawMessage) {
	var inv struct {
		ID           string `json:"id"`
		Subscription string `json:"subscription"`
		Parent       struct {
			SubscriptionDetails struct {
				Subscription string            `json:"subscription"`
				Metadata     map[string]string `json:"metadata"`
			} `json:"subscription_details"`
		} `json:"parent"`
	}
	if json.Unmarshal(raw, &inv) != nil {
		return
	}
	subID := inv.Subscription
	if subID == "" {
		subID = inv.Parent.SubscriptionDetails.Subscription
	}
	if subID == "" {
		return
	}
	sub, err := s.Stripe.GetSubscription(subID)
	if err != nil || sub.Metadata["product"] != "svs-web" || sub.Metadata["env"] != s.Cfg.Env {
		return
	}
	s.syncPlan(ctx, sub)
	uid, tier := sub.Metadata["user_id"], sub.Metadata["plan"]
	_, periodEnd := sub.Period()
	s.grantPlanEntitlements(ctx, uid, tier, inv.ID, periodEnd) // the app's entitlements; never blocks the credit
	def, ok := s.rates(ctx).Plan(tier)
	if !ok || def.CreditCents <= 0 {
		return
	}
	_, end := sub.Period()
	_, fx, err := s.Store.BalanceTx(ctx, uid, func(b *store.Balance) ([]store.BalanceOp, error) {
		return []store.BalanceOp{{Kind: store.EntryPlanCredit, Cents: def.CreditCents, EntryID: "plancredit_" + inv.ID,
			Ref: sub.ID, ExpiresAt: &end, Note: def.Name + " credit"}}, nil
	})
	if err != nil {
		slog.ErrorContext(ctx, "plan credit not granted", "uid", uid, "invoice", inv.ID, "err", err)
		s.Slack.Alert(ctx, "plan_credit_failed", fmt.Sprintf("uid `%s` invoice %s: %v", uid, inv.ID, err))
		return
	}
	slog.InfoContext(ctx, "plan credit granted", "uid", uid, "plan", tier, "cents", def.CreditCents, "until", end)
	s.handleBalanceEffects(ctx, uid, fx)
	s.notePaidOnce(ctx, uid)
	s.payDebtsFromBalance(ctx, uid)
}

// planCreditSweep expires plan credit past its period (reconciler).
func (s *Service) planCreditSweep(ctx context.Context) int {
	bs, err := s.Store.ListBalancesWithPlanCredit(ctx, 100)
	if err != nil {
		slog.WarnContext(ctx, "plan credit sweep: list failed", "err", err)
		return 0
	}
	n := 0
	now := time.Now()
	for _, b := range bs {
		if !b.PlanCreditDue(now) {
			continue
		}
		if _, _, err := s.Store.BalanceTx(ctx, b.UID, func(x *store.Balance) ([]store.BalanceOp, error) {
			if !x.PlanCreditDue(time.Now()) {
				return nil, nil
			}
			return []store.BalanceOp{{Kind: store.EntryPlanCreditExpiry}}, nil
		}); err == nil {
			n++
		}
	}
	return n
}
