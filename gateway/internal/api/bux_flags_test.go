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
