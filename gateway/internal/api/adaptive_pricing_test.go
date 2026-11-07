package api

import (
	"context"
	"net/http"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Option B (owner 2026-11-07): every web Checkout Session — run sheet,
// hand-off, settle, first top-up and plans — carries
// adaptive_pricing[enabled] from config adaptive_pricing_enabled, sent as
// false too so the Dashboard default never decides it. Test is on by
// default, prod off. The amount stays USD.
func TestAdaptivePricingOnEveryCheckout(t *testing.T) {
	for _, env := range []string{"test", "prod"} {
		want := map[string]string{"test": "true", "prod": "false"}[env]
		s, fake := e0Service(t)
		ctx := context.Background()
		s.Cfg.StripePMCWeb = "pmc_web"
		s.Cfg.SiteURL = "https://site"
		s.Pricing = pricing.NewStatic(pricing.DefaultsFor(env))
		if got := s.rates(ctx).AdaptivePricingEnabled; got != (env == "test") {
			t.Fatalf("%s default %v", env, got)
		}
		uid := "u" + store.NewID()
		s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})

		run := createdRun(t, s, nil)
		run.Stripe.CustomerID = "cus_1"
		if _, err := s.openRunSession(ctx, run, "elements", "computer", "", ""); err != nil {
			t.Fatal(err)
		}
		hand := createdRun(t, s, nil)
		hand.Stripe.CustomerID = "cus_1"
		if _, err := s.openRunSessionTo(ctx, hand, "hosted_page", "phone", "", "", "https://site/h"); err != nil {
			t.Fatal(err)
		}
		s.openSettleSession(ctx, &store.Settle{ID: store.NewID(), UID: uid, AmountCents: 1500, Currency: "usd"}, payContext{Device: "computer"})
		if code, out := callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandleTopup(w, r, &AuthedUser{UID: uid}) },
			"POST", `{"amount_cents":2500,"ui":"elements"}`); code != 200 {
			t.Fatalf("%s topup %d %v", env, code, out)
		}
		if env == "test" { // plans are on in test only
			if code, out := callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandleStartPlan(w, r, &AuthedUser{UID: uid}) },
				"POST", `{"plan":"pro_monthly"}`); code != 200 {
				t.Fatalf("plan %d %v", code, out)
			}
		}
		n := map[string]int{"test": 5, "prod": 4}[env]
		if len(fake.sessionForms) != n {
			t.Fatalf("%s: %d sessions, want %d", env, len(fake.sessionForms), n)
		}
		for i, f := range fake.sessionForms {
			if f["adaptive_pricing[enabled]"] != want {
				t.Fatalf("%s session %d (%s %s): adaptive_pricing %q", env, i, f["mode"], f["ui_mode"], f["adaptive_pricing[enabled]"])
			}
			if f["mode"] == "payment" && f["line_items[0][price_data][currency]"] != "usd" {
				t.Fatalf("%s session %d currency %v", env, i, f)
			}
		}
	}
}
