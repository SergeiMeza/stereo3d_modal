package api

import (
	"context"
	"net/http"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
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
