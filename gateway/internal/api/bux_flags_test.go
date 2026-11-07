package api

import (
	"context"
	"net/http"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// BUX-24: web_pro_weekly_hidden (absent = off everywhere) tells the web to
// leave Pro Weekly out; while on, a web checkout of it and a change to it
// are refused (409 plan_unavailable), other plans unaffected.
func TestWebProWeeklyHidden(t *testing.T) {
	ctx := context.Background()
	for _, env := range []string{"test", "prod"} {
		if got := pricing.NewStatic(pricing.DefaultsFor(env)).Public(ctx)["web_pro_weekly_hidden"]; got != false {
			t.Fatalf("%s default %v", env, got)
		}
	}
	s, _ := e0Service(t)
	s.Cfg.StripePMCWeb, s.Cfg.SiteURL = "pmc_web", "https://site"
	r := pricing.DefaultsFor("test")
	r.WebProWeeklyHidden = true
	s.Pricing = pricing.NewStatic(r)
	if s.Pricing.Public(ctx)["web_pro_weekly_hidden"] != true {
		t.Fatal("not on /v1/pricing")
	}
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	start := func(plan string) (int, map[string]any) {
		return callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandleStartPlan(w, r, &AuthedUser{UID: uid}) },
			"POST", `{"plan":"`+plan+`"}`)
	}
	if code, out := start("pro_weekly"); code != 409 || out["error"] != "plan_unavailable" {
		t.Fatalf("weekly checkout %d %v", code, out)
	}
	if code, out := start("pro_monthly"); code != 200 {
		t.Fatalf("monthly checkout %d %v", code, out)
	}
	// a monthly plan can't change to weekly while it's hidden
	f := newPlanFixture(t, "pro_monthly", "pro", 499, 10, 30)
	f.s.Pricing = s.Pricing
	if code, out := f.post(f.s.HandlePlanChange, `{"to":"pro_weekly","confirm":true}`); code != 409 || out["error"] != "plan_unavailable" {
		t.Fatalf("change to weekly %d %v", code, out)
	}
}

func bonusRates() *pricing.Rates {
	r := pricing.DefaultsFor("test")
	r.TopupBonus = []pricing.BonusTier{{MinCents: 5000, Pct: 0.05}, {MinCents: 10000, Pct: 0.10}}
	return r
}

// BUX-23: topup_bonus tiers (absent = none) on /v1/pricing; the highest
// tier a top-up reaches, rounded down; nonsense tiers ignored.
func TestTopupBonusTiers(t *testing.T) {
	ctx := context.Background()
	if got := pricing.NewStatic(pricing.DefaultsFor("prod")).Public(ctx)["topup_bonus"]; len(got.([]pricing.BonusTier)) != 0 {
		t.Fatalf("default %v", got)
	}
	r := bonusRates()
	for cents, want := range map[int64]int64{2500: 0, 4999: 0, 5000: 250, 9999: 499, 10000: 1000, 25000: 2500} {
		if got := r.TopupBonusFor(cents); got != want {
			t.Fatalf("%d: bonus %d, want %d", cents, got, want)
		}
	}
	r.TopupBonus = append(r.TopupBonus, pricing.BonusTier{MinCents: 20000, Pct: 0.9}) // over 50%: ignored
	if r.TopupBonusFor(25000) != 2500 {
		t.Fatal("an invalid tier counted")
	}
	pub := pricing.NewStatic(bonusRates()).Public(ctx)["topup_bonus"].([]pricing.BonusTier)
	if len(pub) != 2 || pub[0].MinCents != 5000 || pub[1].Pct != 0.10 {
		t.Fatalf("public %v", pub)
	}
}

// BUX-23: a $100 top-up says bonus_cents 1000 and, paid, adds $10 of
// usage credit (a topup_bonus ledger row) — never cash: a withdrawal of
// the top-up pays back only what was paid and takes the bonus's share
// with it; a dispute of a top-up takes what is left of its bonus. No bonus
// on an auto-reload.
func TestTopupBonusUsageOnly(t *testing.T) {
	ctx := context.Background()
	s, fake := e0Service(t)
	s.Cfg.StripePMCWeb, s.Cfg.SiteURL = "pmc_web", "https://site"
	s.Pricing = pricing.NewStatic(bonusRates())
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	code, out := callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandleTopup(w, r, &AuthedUser{UID: uid}) },
		"POST", `{"amount_cents":10000,"ui":"elements"}`)
	if code != 200 || out["bonus_cents"] != float64(1000) {
		t.Fatalf("topup %d %v", code, out)
	}
	id := out["topup_id"].(string)
	if err := s.applyTopupPayment(ctx, id, stripexPaidE0("pi_"+id, 10000)); err != nil {
		t.Fatal(err)
	}
	s.applyTopupPayment(ctx, id, stripexPaidE0("pi_"+id, 10000)) // the webhook again: once
	b, _ := s.Store.GetBalance(ctx, uid)
	if b.BalanceCents != 11000 || b.CashCents() != 10000 {
		t.Fatalf("balance %d cash %d", b.BalanceCents, b.CashCents())
	}
	rows := s.ledgerRowsOf(t, uid)
	if r := rows["topup_bonus"]; r == nil || r["cents"] != int64(1000) || r["topup_id"] != id {
		t.Fatalf("ledger %v", rows)
	}
	// withdraw the top-up: $100 back to the card, the $10 bonus goes too
	cs, err := s.requestBalanceRefund(ctx, uid, ReasonTopupWithdraw, id, "support", "owner@x", "changed my mind")
	if err != nil || cs.RequestedCents != 10000 {
		t.Fatalf("case %v %+v", err, cs)
	}
	if err := s.applyCaseAction(ctx, cs, caseActionReq{Action: "approve"}, "owner@x"); err != nil {
		t.Fatal(err)
	}
	if b, _ = s.Store.GetBalance(ctx, uid); b.BalanceCents != 0 || len(fake.refunds) != 1 {
		t.Fatalf("after the withdrawal: balance %d refunds %v", b.BalanceCents, fake.refunds)
	}
	if r := s.ledgerRowsOf(t, uid)["topup_bonus_removed"]; r == nil || r["cents"] != int64(-1000) {
		t.Fatalf("bonus removal row %v", r)
	}

	// a second top-up, $50 (5%: $2.50), $1 of it spent, then disputed
	uid2 := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid2, &store.Customer{StripeCustomerID: "cus_2"})
	_, out = callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandleTopup(w, r, &AuthedUser{UID: uid2}) },
		"POST", `{"amount_cents":5000,"ui":"elements"}`)
	id2 := out["topup_id"].(string)
	pi2 := "pi_" + id2
	fake.pis[pi2] = map[string]any{"status": "succeeded", "amount_received": int64(5000), "payment_method": "pm_1",
		"metadata": map[string]string{"topup_id": id2, "user_id": uid2, "env": "test", "product": "svs-web"}}
	s.applyTopupPayment(ctx, id2, stripexPaidE0(pi2, 5000))
	s.Store.BalanceTx(ctx, uid2, func(*store.Balance) ([]store.BalanceOp, error) {
		return []store.BalanceOp{{Kind: store.EntryDebtPayment, Cents: 100, Ref: "st_x", EntryID: "debt_x"}}, nil // spends bonus first
	})
	raw := []byte(`{"id":"du_` + id2 + `","amount":5000,"reason":"fraudulent","status":"needs_response","payment_intent":"` + pi2 + `","evidence_details":{"due_by":1900000000}}`)
	if err := s.handleDisputeEvent(ctx, "charge.dispute.created", raw); err != nil {
		t.Fatal(err)
	}
	b2, _ := s.Store.GetBalance(ctx, uid2)
	if b2.BalanceCents != 5000 || b2.FrozenCents != 5000 { // the unspent $1.50 of bonus gone; the paid $50 frozen
		t.Fatalf("after the dispute: balance %d frozen %d", b2.BalanceCents, b2.FrozenCents)
	}

	// an auto-reload earns nothing
	uid3 := "u" + store.NewID()
	auto := &store.Topup{ID: "r" + store.NewID(), UID: uid3, Cents: 10000, Currency: "usd", State: store.TopupOpen, Auto: true,
		BonusCents: 1000} // even if one were set
	s.Store.CreateTopup(ctx, auto)
	s.applyTopupPayment(ctx, auto.ID, stripexPaidE0("pi_"+auto.ID, 10000))
	if b3, _ := s.Store.GetBalance(ctx, uid3); b3.BalanceCents != 10000 {
		t.Fatalf("auto-reload balance %d", b3.BalanceCents)
	}
}

func stripexPaidE0(pi string, cents int64) stripex.Outcome {
	return stripex.Outcome{Paid: true, PaymentIntentID: pi, AmountReceived: cents, PaymentMethod: "pm_1"}
}

// ledgerRowsOf: the account's Balance history rows by kind (the last of each).
func (s *Service) ledgerRowsOf(t *testing.T, uid string) map[string]map[string]any {
	t.Helper()
	page, _, err := s.Store.ListEntries(context.Background(), uid, 100, "")
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]map[string]any{}
	for _, e := range page {
		if row := ledgerRow(e); row != nil {
			out[row["kind"].(string)] = row
		}
	}
	return out
}

// BUX-25: Business billed yearly behind config business_yearly (absent =
// off): 10 × the monthly price a year, Business's credit every month;
// tier business, plan id business_yearly; checkout and changes to it
// refused while off.
func TestBusinessYearly(t *testing.T) {
	ctx := context.Background()
	off := pricing.DefaultsFor("test")
	if pub := pricing.NewStatic(off).Public(ctx); pub["business_yearly"] != false || pub["plans"].(map[string]any)["business_yearly"] != nil {
		t.Fatalf("default: %v / %v", pub["business_yearly"], pub["plans"])
	}
	// not in config: Business's terms, yearly at 10 × the month
	d, ok := off.Plan(pricing.PlanBusinessYearly)
	if !ok || d.Interval != "year" || d.PriceCents != 299000 || d.CreditCents != 40000 || d.CreditInterval != "month" || d.LookupKey != "svs_web_business_yearly" {
		t.Fatalf("derived %+v %v", d, ok)
	}

	s, fake := e0Service(t)
	s.Cfg.StripePMCWeb, s.Cfg.SiteURL = "pmc_web", "https://site"
	s.Pricing = pricing.NewStatic(off)
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	start := func() (int, map[string]any) {
		return callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandleStartPlan(w, r, &AuthedUser{UID: uid}) },
			"POST", `{"plan":"business_yearly"}`)
	}
	if code, out := start(); code != 409 || out["error"] != "plan_unavailable" {
		t.Fatalf("while off %d %v", code, out)
	}
	on := pricing.DefaultsFor("test")
	on.BusinessYearly = true
	by := on.Plans[pricing.TierBusiness]
	by.Interval, by.PriceCents, by.StripePriceID, by.LookupKey = "year", 299000, "price_test_business_yearly", "svs_web_business_yearly"
	on.Plans[pricing.PlanBusinessYearly] = by
	s.Pricing = pricing.NewStatic(on)
	if p := s.Pricing.Public(ctx)["plans"].(map[string]any)["business_yearly"].(pricing.PlanDef); p.PriceCents != 299000 || p.Interval != "year" {
		t.Fatalf("public %+v", p)
	}
	code, out := start()
	if code != 200 || out["plan"] != "business_yearly" {
		t.Fatalf("checkout %d %v", code, out)
	}
	form := fake.sessionForms[len(fake.sessionForms)-1]
	if form["line_items[0][price]"] != "price_test_business_yearly" || form["subscription_data[metadata][plan]"] != "business" ||
		form["subscription_data[metadata][plan_id]"] != "business_yearly" {
		t.Fatalf("session %v", form)
	}

	// a monthly Business plan steps up to yearly (10 months' price less the unused month)
	f := newPlanFixture(t, "business", "business", 29900, 10, 30)
	f.s.Pricing = pricing.NewStatic(off)
	if code, out := f.post(f.s.HandlePreviewPlanChange, `{"to":"business_yearly"}`); code != 409 || out["error"] != "plan_unavailable" {
		t.Fatalf("change while off %d %v", code, out)
	}
	f.s.Pricing = s.Pricing
	code, out = f.post(f.s.HandlePreviewPlanChange, `{"to":"business_yearly"}`)
	if code != 200 || out["kind"] != "step_up" || out["new_plan_cents"] != float64(299000) {
		t.Fatalf("preview %d %v", code, out)
	}
	// the synced yearly subscription: tier business, plan id business_yearly, yearly, Business's credit monthly
	f.s.Store.UpdateCustomer(ctx, f.uid, func(c *store.Customer) error {
		c.Plan.PlanID, c.Plan.Interval, c.Plan.Tier = "business_yearly", "year", "business"
		return nil
	})
	pj := f.s.planJSON(ctx, f.uid)
	if pj["plan"] != "business" || pj["plan_id"] != "business_yearly" || pj["interval"] != "year" || pj["price_cents"] != int64(299000) ||
		pj["credit_cents"] != int64(40000) || pj["credit_interval"] != "month" {
		t.Fatalf("plan json %v", pj)
	}
}
