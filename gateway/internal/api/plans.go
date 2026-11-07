package api

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Web plans (pricing 2026-11, test only): Business $299/month with $400
// of credit, Studio $999 with $1,500, each spent at the plan's own prices
// (its tier), the credit gone at the period's end; usage beyond it at the
// plan's prices from the balance or a card. Stripe Billing runs the
// subscription; customer.subscription.* mirrors it on the account and
// invoice.paid grants each period's credit (non-cash, in the ledger).

func planLookupKey(def pricing.PlanDef, tier string) string {
	if def.LookupKey != "" {
		return def.LookupKey
	}
	return "svs_web_" + tier + "_monthly"
}

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
	if chinaMode(r) && s.chinaPaymentsOff(ctx) {
		httpx.WriteErr(ctx, w, errChinaPaymentsUnavailable())
		return
	}
	def, ok := s.rates(ctx).Plan(req.Plan)
	pro, isPro := s.rates(ctx).ProPlan(req.Plan)
	if !ok && !isPro {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "unknown_plan", "plan must be business, studio, pro_weekly, pro_monthly or pro_yearly"))
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
	priceID, lookup, tier, planID, coupon := def.StripePriceID, planLookupKey(def, req.Plan), req.Plan, "", ""
	if isPro {
		priceID, lookup, tier, planID = pro.StripePriceID, pro.LookupKey, pricing.TierPro, pro.ID
		if pro.Intro != nil && pro.Intro.CouponID != "" && (cust == nil || !cust.ProIntroUsed) {
			coupon = pro.Intro.CouponID // the intro price, once per account
		}
	}
	if priceID == "" {
		if priceID, err = s.Stripe.PriceByLookupKey(lookup); err != nil || priceID == "" {
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
		CustomerID: customerID, PMC: s.Cfg.StripePMCWeb, PriceID: priceID, UI: ui, Tier: tier, UID: user.UID,
		PlanID: planID, Coupon: coupon,
		ReturnURL:       s.Cfg.SiteURL + "/account/billing?plan=" + req.Plan, // the web keeps /billing redirecting there
		IdemKey:         fmt.Sprintf("plan_%s_%s_%s_%d", s.Cfg.Env, user.UID, req.Plan, time.Now().Unix()/60),
		AdaptivePricing: s.rates(ctx).AdaptivePricingEnabled,
	})
	if err != nil {
		httpx.Log(ctx).Error("plan session failed", append([]any{"plan", req.Plan}, stripex.FactsOf(err).LogArgs()...)...)
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
	if req.Resume && planNotRenewable(cust.Plan) {
		httpx.WriteErr(ctx, w, errNotRenewable(cust.Plan))
		return
	}
	sub, err := s.Stripe.SetCancelAtPeriodEnd(cust.Plan.SubscriptionID, !req.Resume)
	if err != nil {
		httpx.WriteErr(ctx, w, planStripeFailure(ctx, "cancel_plan", err, "couldn't change the plan; try again"))
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
	out := map[string]any{"plan": p.Tier, "plan_id": p.Key(), "status": p.Status, "active": p.Active(time.Now()), "cancel_at_period_end": p.CancelAtPeriodEnd,
		"renewable": !planNotRenewable(p), "restored_from": planNotRenewable(p)}
	if pro, ok := s.rates(ctx).ProPlan(p.PlanID); ok && p.Tier == pricing.TierPro {
		out["name"], out["interval"], out["price_cents"] = "Pro", pro.Interval, pro.PriceCents
	} else if def, ok := s.rates(ctx).Plan(p.Tier); ok {
		out["name"], out["monthly_cents"], out["credit_cents"] = def.Name, def.MonthlyCents, def.CreditCents
		out["interval"], out["price_cents"], out["credit_interval"] = def.Interval, def.PriceCents, def.CreditInterval
	}
	if k, _, to, ok := p.Month(time.Now()); ok && p.Yearly() {
		out["month_index"], out["credit_resets_at"] = k+1, to.Format(time.RFC3339) // month k+1 of 12
	}
	if p.CurrentPeriodEnd != nil {
		out["current_period_end"] = p.CurrentPeriodEnd.Format(time.RFC3339)
	}
	out["scheduled_change"] = scheduledChangeJSON(p) // {to, effective_at} or null
	if b, berr := s.Store.GetBalance(ctx, uid); berr == nil {
		out["credit_left_cents"] = b.PeriodCreditCents() // the plan's own; grants are in balance.credits
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
	defer s.rcAttrsTouch(ctx, uid, "plan") // web_plan, web_plan_renews_at
	if _, err := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if c.Plan != nil && c.Plan.SubscriptionID != "" && c.Plan.SubscriptionID != sub.ID && c.Plan.Active(time.Now()) && sub.Status != "active" {
			return nil // an older or incomplete subscription doesn't replace the live one
		}
		next := &store.Plan{Tier: tier, SubscriptionID: sub.ID, Status: sub.Status, CurrentPeriodStart: &start,
			CurrentPeriodEnd: &end, CancelAtPeriodEnd: sub.CancelAtPeriodEnd, UpdatedAt: time.Now().UTC(), Interval: sub.Interval(),
			PlanID: sub.Metadata["plan_id"]}
		if next.PlanID == tier {
			next.PlanID = ""
		}
		if c.Plan != nil && c.Plan.SubscriptionID == sub.ID { // keep the RevenueCat grant record
			next.RCGrantInvoice, next.RCGrantedUntil, next.RCGrantError = c.Plan.RCGrantInvoice, c.Plan.RCGrantedUntil, c.Plan.RCGrantError
			next.RCRevokedAt, next.RCRevokeReason = c.Plan.RCRevokedAt, c.Plan.RCRevokeReason
			next.LastInvoiceID, next.LastCreditCents = c.Plan.LastInvoiceID, c.Plan.LastCreditCents
			next.GrantsPaused = c.Plan.GrantsPaused
			next.StartedAt, next.AppProChecked = c.Plan.StartedAt, c.Plan.AppProChecked
			next.Intro, next.IntroInvoices = c.Plan.Intro, c.Plan.IntroInvoices
			next.PeriodPaidCents = c.Plan.PeriodPaidCents
			next.ScheduleID, next.ScheduledTo, next.ScheduledAt = c.Plan.ScheduleID, c.Plan.ScheduledTo, c.Plan.ScheduledAt
			next.RestoredFrom = c.Plan.RestoredFrom
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
		Lines struct {
			Data []struct {
				Amount int64 `json:"amount"`
			} `json:"data"`
		} `json:"lines"`
		TotalDiscountAmounts []struct {
			Amount int64 `json:"amount"`
		} `json:"total_discount_amounts"`
		BillingReason string `json:"billing_reason"`
	}
	if json.Unmarshal(raw, &inv) != nil {
		return
	}
	// What the plan's period cost them: its own lines after discounts (an
	// intro), leaving out our credit for an old plan.
	var pricePaid int64
	for _, l := range inv.Lines.Data {
		if l.Amount > 0 {
			pricePaid += l.Amount
		}
	}
	for _, d := range inv.TotalDiscountAmounts {
		pricePaid -= d.Amount
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
	// A deleted account's subscription only runs out (cancel_at_period_end
	// at the deletion): nothing is granted again, quietly.
	if cust, cerr := s.Store.GetCustomer(ctx, uid); cerr == nil && cust.AccountDeleted {
		slog.InfoContext(ctx, "plan invoice for a deleted account: nothing granted", "invoice", inv.ID)
		return
	}
	// A plan started: once per subscription, with the plans surface they
	// last clicked (renewals find it recorded).
	key, source := "plan:"+sub.ID, "checkout"
	if from := sub.Metadata["changed_from"]; from != "" {
		key, source = "plan:"+sub.ID+":"+cmp.Or(sub.Metadata["plan_id"], tier), "change" // a plan change starts the new one
	}
	s.planPeriodPaid(ctx, uid, sub, pricePaid)
	if from := sub.Metadata["changed_from"]; sub.Metadata["change_kind"] == changeStepUp && from != "" &&
		(inv.BillingReason == "subscription_update" || inv.BillingReason == "") {
		// Replace, not carry: the old plan's leftover credit ends as the new
		// plan's comes; its Business/Studio entitlement gives way.
		s.planCreditOp(ctx, uid, store.EntryPlanCreditRemoval, sub.ID, "", "replaced by "+tierLabel(tier), "plancredit_replaced_"+inv.ID)
		s.planSwapEntitlement(ctx, uid, from, tier)
	}
	if sub.Metadata["change_kind"] == changeStepDown {
		s.stepDownApplied(ctx, uid, sub) // the switch date: the old plan's entitlement goes
	} else if s.attributePlanStart(ctx, uid, tier, source, key, time.Now().UTC()) {
		s.planStarted(ctx, uid, tier, sub.ID) // first invoice: started_at and the receipt mail
	}
	if tier == pricing.TierPro && sub.Metadata["changed_from"] == "" {
		s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
			if !c.ProIntroUsed {
				c.ProIntroUsed = true
				if c.Plan != nil && c.Plan.SubscriptionID == sub.ID {
					c.Plan.Intro = true // the intro coupon was on the first invoice when it existed
				}
			}
			return nil
		})
	}
	_, periodEnd := sub.Period()
	s.grantPlanEntitlements(ctx, uid, tier, inv.ID, periodEnd) // the app's entitlements; never blocks the credit
	if tier == pricing.TierPro {
		defer s.ensureProCredit(ctx, uid) // web Pro: its monthly credit from the plan's anniversary (PRO-01)
	}
	def, ok := s.rates(ctx).Plan(tier)
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if c.Plan != nil && c.Plan.SubscriptionID == sub.ID {
			c.Plan.LastInvoiceID, c.Plan.LastCreditCents = inv.ID, def.CreditCents
		}
		return nil
	})
	if !ok || def.CreditCents <= 0 {
		return
	}
	if sub.Interval() == "year" {
		// A yearly plan's credit comes every month, from the scheduler; the
		// year's invoice starts month 1 now.
		if cust, cerr := s.Store.GetCustomer(ctx, uid); cerr == nil && cust.Plan != nil {
			s.grantPlanMonth(ctx, uid, cust.Plan, def, time.Now().UTC())
		}
		s.notePaidOnce(ctx, uid)
		s.payDebtsFromBalance(ctx, uid)
		return
	}
	if from := cmp.Or(sub.Metadata["restored_from"], sub.Metadata["moved_from"]); from != "" {
		if done, _ := s.Store.EntryExists(ctx, from, "plancredit_"+inv.ID); done {
			return // granted on the deleted account it was restored from (RP-01 carries the unspent part)
		}
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

// handlePlanInvoiceCreated (invoice.created): a Business or Studio
// subscription invoice still in draft gets the web's statement line
// ("SPATIALVID* SV STUDIO", from the account's prefix); Checkout in subscription mode takes no
// suffix, so plan charges otherwise showed the account's default.
// Idempotent: a draft that already has it, or an invoice past draft (the
// first one, which Checkout finalizes at once), is left alone.
func (s *Service) handlePlanInvoiceCreated(ctx context.Context, raw json.RawMessage) {
	var inv struct {
		ID                  string `json:"id"`
		Status              string `json:"status"`
		StatementDescriptor string `json:"statement_descriptor"`
		Subscription        string `json:"subscription"`
		Parent              struct {
			SubscriptionDetails struct {
				Subscription string            `json:"subscription"`
				Metadata     map[string]string `json:"metadata"`
			} `json:"subscription_details"`
		} `json:"parent"`
	}
	if json.Unmarshal(raw, &inv) != nil || inv.Status != "draft" {
		return
	}
	line := stripex.WebStatementDescriptor(s.Stripe.DescriptorPrefix())
	if inv.StatementDescriptor == line {
		return
	}
	md := inv.Parent.SubscriptionDetails.Metadata
	subID := cmp.Or(inv.Subscription, inv.Parent.SubscriptionDetails.Subscription)
	if subID == "" {
		return
	}
	if md["product"] == "" {
		sub, err := s.Stripe.GetSubscription(subID)
		if err != nil {
			slog.WarnContext(ctx, "plan invoice: subscription unreadable", "invoice", inv.ID, "err", err)
			return
		}
		md = sub.Metadata
	}
	if md["product"] != "svs-web" || md["env"] != s.Cfg.Env || md["plan"] == "" {
		return
	}
	if err := s.Stripe.SetInvoiceDescriptor(inv.ID, line); err != nil {
		slog.WarnContext(ctx, "plan invoice descriptor not set", "invoice", inv.ID, "err", err)
	}
}
