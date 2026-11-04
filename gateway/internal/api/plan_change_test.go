package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/revenuecat"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func f64(v float64) *float64 { return &v }

func TestOldPlanCredit(t *testing.T) {
	// the owner's cases (2026-11-04)
	if got := oldPlanCredit(29900, creditShares{TimeLeft: 0.5, UsageLeft: f64(50.0 / 400)}); got != 3738 {
		t.Fatalf("Business $350 of $400 used: %d", got)
	}
	if got := oldPlanCredit(29900, creditShares{TimeLeft: 0.5, UsageLeft: f64(300.0 / 400)}); got != 14950 {
		t.Fatalf("Business $100 used: %d", got)
	}
	if got := oldPlanCredit(899, creditShares{TimeLeft: 20.0 / 30, UsageLeft: f64(2.0 / 20)}); got != 90 {
		t.Fatalf("Pro Monthly 18 of 20 previews: %d", got)
	}
	if oldPlanCredit(899, creditShares{TimeLeft: 0.5, UsageLeft: f64(1)}) != 450 || oldPlanCredit(29900, creditShares{TimeLeft: 0.9, UsageLeft: f64(0)}) != 0 {
		t.Fatal("no usage = time share; all used = 0")
	}
	if got := oldPlanCredit(399, creditShares{TimeLeft: 0.5}); got != 200 { // Weekly at the intro price
		t.Fatalf("weekly intro %d", got)
	}
	if got := oldPlanCredit(4799, creditShares{TimeLeft: 0.25}); got != 1200 { // Yearly at the intro price
		t.Fatalf("yearly intro %d", got)
	}
	// Docs/payments/plan-changes.md worked examples (Business $299 today).
	if got := oldPlanCredit(899, creditShares{TimeLeft: 20.0 / 30, UsageLeft: f64(15.0 / 20)}); got != 599 || 29900-got != 29301 {
		t.Fatalf("Pro Monthly → Business, day 10, 5 of 20 previews: %d", got)
	}
	if got := oldPlanCredit(4799, creditShares{TimeLeft: 200.0 / 365, UsageLeft: f64(190.0 / 240)}); got != 2630 || 29900-got != 27270 {
		t.Fatalf("Pro Yearly intro → Business, 200 of 365 days, 50 of 240 previews: %d", got)
	}
	if oldPlanCredit(899, creditShares{TimeLeft: 1.4}) != 899 || oldPlanCredit(899, creditShares{TimeLeft: -1}) != 0 {
		t.Fatal("clamped")
	}
}

type planFixture struct {
	t    *testing.T
	s    *Service
	fake *fakeStripe
	uid  string
	sub  string
}

func newPlanFixture(t *testing.T, planID, tier string, paid int64, daysIn, periodDays int) planFixture {
	t.Helper()
	s, fake := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	s.RevenueCat = revenuecat.New("")
	uid, sub := "u"+store.NewID(), "sub_"+store.NewID()
	now := time.Now().UTC()
	start, end := now.Add(-time.Duration(daysIn)*24*time.Hour), now.Add(time.Duration(periodDays-daysIn)*24*time.Hour)
	pid := planID
	if pid == tier {
		pid = ""
	}
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1", Email: "a@example.com",
		Plan: &store.Plan{Tier: tier, PlanID: pid, SubscriptionID: sub, Status: "active", CurrentPeriodStart: &start,
			CurrentPeriodEnd: &end, PeriodPaidCents: paid}})
	md := map[string]string{"product": "svs-web", "env": "test", "user_id": uid, "plan": tier}
	if pid != "" {
		md["plan_id"] = pid
	}
	fake.subs[sub] = map[string]any{"id": sub, "status": "active", "customer": "cus_1", "metadata": md,
		"current_period_start": start.Unix(), "current_period_end": end.Unix(),
		"items": map[string]any{"data": []any{map[string]any{"id": "si_1", "price": map[string]any{"id": "price_old"}}}}}
	return planFixture{t, s, fake, uid, sub}
}

func (f planFixture) post(h func(http.ResponseWriter, *http.Request, *AuthedUser), body string) (int, map[string]any) {
	f.t.Helper()
	return callJSON(f.t, func(w http.ResponseWriter, r *http.Request) { h(w, r, &AuthedUser{UID: f.uid}) }, "POST", body)
}

// A step-up at the same interval: a full new period from today, today's
// charge = the new price − our credit, exactly as previewed; the new
// plan's credit comes in full on the switch day.
func TestStepUpSameInterval(t *testing.T) {
	f := newPlanFixture(t, "pro_monthly", "pro", 899, 10, 30)
	ctx := context.Background()
	code, prev := f.post(f.s.HandlePreviewPlanChange, `{"to":"business"}`)
	if code != 200 || prev["kind"] != "step_up" || prev["new_plan_cents"] != float64(29900) {
		t.Fatalf("preview %d %v", code, prev)
	}
	credit := int64(prev["unused_credit_cents"].(float64))
	if credit < 595 || credit > 602 { // 899 × ~20/30
		t.Fatalf("credit %d", credit)
	}
	if prev["today_cents"] != float64(29900-credit) {
		t.Fatalf("today %v", prev["today_cents"])
	}
	quoteAt := int64(prev["quote_at"].(float64))
	if code, _ := f.post(f.s.HandlePlanChange, `{"to":"business"}`); code != 400 {
		t.Fatal("no confirm, no change")
	}
	code, out := f.post(f.s.HandlePlanChange, `{"to":"business","confirm":true,"quote_at":`+itoa(int(quoteAt))+`}`)
	if code != 200 {
		t.Fatalf("change %d %v", code, out)
	}
	if len(f.fake.invItems) != 1 || len(f.fake.subUpdates) != 1 {
		t.Fatalf("items %v updates %v", f.fake.invItems, f.fake.subUpdates)
	}
	var item int64
	for _, a := range f.fake.invItems {
		item = a
	}
	up := f.fake.subUpdates[0]
	charge := 29900 + item // the new period's price plus our credit line
	if charge != int64(prev["today_cents"].(float64)) {
		t.Fatalf("charge %d != preview %v", charge, prev["today_cents"])
	}
	if up["billing_cycle_anchor"] != "now" || up["proration_behavior"] != "none" || up["payment_behavior"] != "error_if_incomplete" ||
		up["metadata[plan]"] != "business" || up["metadata[changed_from]"] != "pro_monthly" || up["metadata[change_kind]"] != "step_up" {
		t.Fatalf("update %v", up)
	}
	// the switch invoice is paid: Business's credit in full today
	inv, _ := json.Marshal(map[string]any{"id": "in_switch", "subscription": f.sub,
		"lines": map[string]any{"data": []any{map[string]any{"amount": 29900}, map[string]any{"amount": item}}}})
	f.s.handlePlanInvoicePaid(ctx, inv)
	b, _ := f.s.Store.GetBalance(ctx, f.uid)
	c, _ := f.s.Store.GetCustomer(ctx, f.uid)
	if b == nil || b.PlanCreditCents() != 40000 || c.Plan.Tier != "business" || c.Plan.PeriodPaidCents != 29900 {
		t.Fatalf("switch day: credit %v plan %+v", b, c.Plan)
	}
	if at := f.s.accountTier(ctx, f.uid); at.Tier != "business" || !strings.HasPrefix(at.PeriodKey, "plan:"+f.sub) {
		t.Fatalf("tier %+v", at)
	}
}

// A payment that fails changes nothing and takes our credit back.
func TestStepUpPaymentFails(t *testing.T) {
	f := newPlanFixture(t, "pro_weekly", "pro", 399, 3, 7)
	f.fake.failNextChange = true
	code, out := f.post(f.s.HandlePlanChange, `{"to":"pro_monthly","confirm":true}`)
	if code != 402 || out["error"] != "payment_failed" || len(f.fake.invItems) != 0 {
		t.Fatalf("failed change %d %v items %v", code, out, f.fake.invItems)
	}
}

// Step-downs wait for the period's end: no charge today, the current
// plan's grants keep running, Keep takes it back.
func TestStepDowns(t *testing.T) {
	for _, tc := range []struct{ from, tier, to string }{
		{"studio", "studio", "business"}, {"business", "business", "pro_monthly"}, {"pro_yearly", "pro", "pro_monthly"},
		{"pro_monthly", "pro", "pro_weekly"}, {"business", "business", "none"},
	} {
		f := newPlanFixture(t, tc.from, tc.tier, 0, 5, 30)
		ctx := context.Background()
		code, prev := f.post(f.s.HandlePreviewPlanChange, `{"to":"`+tc.to+`"}`)
		if code != 200 || prev["kind"] != "step_down" || prev["today_cents"] != float64(0) || prev["effective_at"] == nil {
			t.Fatalf("%s→%s preview %d %v", tc.from, tc.to, code, prev)
		}
		code, out := f.post(f.s.HandlePlanChange, `{"to":"`+tc.to+`","confirm":true}`)
		if code != 200 || len(f.fake.invItems) != 0 || len(f.fake.subUpdates) != 0 {
			t.Fatalf("%s→%s change %d %v (charged? %v %v)", tc.from, tc.to, code, out, f.fake.invItems, f.fake.subUpdates)
		}
		sc, _ := out["plan"].(map[string]any)["scheduled_change"].(map[string]any)
		if sc == nil || sc["to"] != tc.to {
			t.Fatalf("%s→%s scheduled %v", tc.from, tc.to, out["plan"])
		}
		if tc.to != "none" {
			sch := f.fake.schedules["sub_sched_1"]
			if sch["phases[1][metadata][change_kind]"] != "step_down" || sch["phases[0][end_date]"] != "2000" || sch["end_behavior"] != "release" {
				t.Fatalf("%s→%s schedule %v", tc.from, tc.to, sch)
			}
		}
		if at := f.s.accountTier(ctx, f.uid); at.Tier != tc.tier {
			t.Fatalf("%s→%s grants stopped early: %+v", tc.from, tc.to, at)
		}
		// Keep it
		code, kept := callJSON(t, func(w http.ResponseWriter, r *http.Request) {
			f.s.HandleCancelScheduledChange(w, r, &AuthedUser{UID: f.uid})
		}, "DELETE", "")
		if code != 200 || kept["scheduled_change"] != nil {
			t.Fatalf("%s→%s keep %d %v", tc.from, tc.to, code, kept)
		}
		if tc.to != "none" && f.fake.schedules["sub_sched_1"]["released"] != "true" {
			t.Fatal("schedule not released")
		}
	}
}

func TestPlanChangeRules(t *testing.T) {
	f := newPlanFixture(t, "business", "business", 29900, 5, 30)
	if code, out := f.post(f.s.HandlePreviewPlanChange, `{"to":"business"}`); code != 409 || out["error"] != "same_plan" {
		t.Fatalf("same %d %v", code, out)
	}
	if code, _ := f.post(f.s.HandlePlanChange, `{"to":"pro_monthly","confirm":true,"quote_at":1}`); code != 409 {
		t.Fatal("an old quote")
	}
}

// Pro on our Stripe: Checkout with the intro coupon once per account; the
// paid invoice makes the plan read as Pro with its own free previews.
func TestStartProPlan(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	start := func(plan string) (int, map[string]any) {
		return callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandleStartPlan(w, r, &AuthedUser{UID: uid}) }, "POST", `{"plan":"`+plan+`"}`)
	}
	if code, out := start("pro_weekly"); code != 200 || out["plan"] != "pro_weekly" {
		t.Fatalf("start %d %v", code, out)
	}
	form := fake.sessionForms[0]
	if form["discounts[0][coupon]"] != "svs_pro_weekly_intro" || form["subscription_data[metadata][plan]"] != "pro" ||
		form["subscription_data[metadata][plan_id]"] != "pro_weekly" || form["line_items[0][price]"] != "price_1UXwaTAVV5NpxADIYIOw5hyj" {
		t.Fatalf("session %v", form)
	}
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error { c.ProIntroUsed = true; return nil })
	start("pro_yearly")
	if fake.sessionForms[1]["discounts[0][coupon]"] != "" {
		t.Fatal("intro twice")
	}
	// /v1/pricing lists them
	rates := s.rates(ctx)
	if pl := rates.ProPlanList(); len(pl) != 3 || pl[0].Intro.PriceCents != 399 || pl[0].Intro.Cycles != 4 || pl[1].Intro != nil || pl[2].Intro.PriceCents != 4799 {
		t.Fatalf("pro plans %+v", pl)
	}
	// a running Pro plan: Pro prices, its own free previews
	end := time.Now().Add(6 * 24 * time.Hour)
	st := time.Now().Add(-24 * time.Hour)
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		c.Plan = &store.Plan{Tier: "pro", PlanID: "pro_weekly", SubscriptionID: "sub_p", Status: "active", CurrentPeriodStart: &st, CurrentPeriodEnd: &end}
		return nil
	})
	if at := s.accountTier(ctx, uid); at.Tier != "pro" || at.AllowanceKey != "pro_weekly" {
		t.Fatalf("pro tier %+v", at)
	}
	if pj := s.planJSON(ctx, uid); pj["plan_id"] != "pro_weekly" || pj["price_cents"] != int64(599) || pj["interval"] != "week" {
		t.Fatalf("plan json %v", pj)
	}
}

// /v1/pro for Pro on our Stripe: source plan, plan id, a waiting step-down.
func TestProStatusWebPlan(t *testing.T) {
	f := newPlanFixture(t, "pro_yearly", "pro", 7999, 30, 365)
	if code, _ := f.post(f.s.HandlePlanChange, `{"to":"pro_monthly","confirm":true}`); code != 200 {
		t.Fatal("step-down")
	}
	_, out := callJSON(t, func(w http.ResponseWriter, r *http.Request) { f.s.HandleProStatus(w, r, &AuthedUser{UID: f.uid}) }, "GET", "")
	sc, _ := out["scheduled_change"].(map[string]any)
	if out["pro"] != true || out["source"] != "web" || out["source_detail"] != "plan" || out["period"] != "yearly" || out["renews_at"] == nil ||
		out["plan_id"] != "pro_yearly" || sc == nil || sc["to"] != "pro_monthly" ||
		out["free_previews"].(map[string]any)["allowance"] != "pro_yearly" {
		t.Fatalf("pro status %v", out)
	}
	// pay_per_video is the same as cancelling at the period's end
	g := newPlanFixture(t, "pro_monthly", "pro", 899, 3, 30)
	code, res := g.post(g.s.HandlePlanChange, `{"to":"pay_per_video","confirm":true}`)
	if sc, _ := res["plan"].(map[string]any)["scheduled_change"].(map[string]any); code != 200 || sc["to"] != "none" {
		t.Fatalf("pay per video %d %v", code, res)
	}
}

// Business → Studio, day 15 of 30: the credit uses the plan credit left;
// today = $11,988 − credit; Business's leftover ends when Studio's comes.
func TestBusinessToStudio(t *testing.T) {
	for _, tc := range []struct {
		used, credit, today int64
	}{{35000, 3738, 1195062}, {10000, 14950, 1183850}} {
		f := newPlanFixture(t, "business", "business", 29900, 15, 30)
		ctx := context.Background()
		end := time.Now().Add(15 * 24 * time.Hour)
		f.s.Store.BalanceTx(ctx, f.uid, func(b *store.Balance) ([]store.BalanceOp, error) {
			return []store.BalanceOp{{Kind: store.EntryPlanCredit, Cents: 40000 - tc.used, EntryID: "plancredit_x_" + store.NewID(), Ref: f.sub, ExpiresAt: &end}}, nil
		})
		code, prev := f.post(f.s.HandlePreviewPlanChange, `{"to":"studio"}`)
		basis, _ := prev["credit_basis"].(map[string]any)
		if code != 200 || prev["unused_credit_cents"] != float64(tc.credit) || prev["today_cents"] != float64(tc.today) ||
			basis["paid_cents"] != float64(29900) || basis["usage_share"] == nil {
			t.Fatalf("used %d: preview %d %v", tc.used, code, prev)
		}
		code, out := f.post(f.s.HandlePlanChange, `{"to":"studio","confirm":true,"quote_at":`+itoa(int(prev["quote_at"].(float64)))+`}`)
		var item int64
		for _, a := range f.fake.invItems {
			item = a
		}
		if code != 200 || 1198800+item != tc.today {
			t.Fatalf("used %d: change %d %v item %d", tc.used, code, out, item)
		}
		// the switch invoice: Business's leftover goes, Studio's month comes
		inv, _ := json.Marshal(map[string]any{"id": "in_sw_" + store.NewID(), "subscription": f.sub, "billing_reason": "subscription_update",
			"lines": map[string]any{"data": []any{map[string]any{"amount": 1198800}, map[string]any{"amount": item}}}})
		f.fake.subs[f.sub]["items"] = map[string]any{"data": []any{map[string]any{"id": "si_1", "price": map[string]any{"id": "price_1UXjsfAVV5NpxADIVWtelcNn", "recurring": map[string]any{"interval": "year"}}}}}
		f.fake.subs[f.sub]["current_period_end"] = time.Now().AddDate(1, 0, 0).Unix()
		f.s.handlePlanInvoicePaid(ctx, inv)
		b, _ := f.s.Store.GetBalance(ctx, f.uid)
		if b.PlanCreditCents() != 150000 {
			t.Fatalf("used %d: plan credit %d, want Studio's 150000 alone", tc.used, b.PlanCreditCents())
		}
	}
}

// Pro Monthly, 18 of 20 previews used by day 10: credit $0.90.
func TestProToBusinessUsageShare(t *testing.T) {
	f := newPlanFixture(t, "pro_monthly", "pro", 899, 10, 30)
	ctx := context.Background()
	at := f.s.accountTier(ctx, f.uid)
	allowance := f.s.freePreviewStatus(ctx, f.uid, at, 0).Allowance
	if allowance != 20 {
		t.Skipf("pro_monthly allowance is %d, not 20", allowance)
	}
	for i := 0; i < 18; i++ { // 18 used, over two days so no daily cap bites
		day := "d" + itoa(i%9)
		if ok, err := f.s.Store.ConsumeFreePreviews(ctx, f.uid, at.PeriodKey, day, 1, allowance, 100, false); err != nil || !ok {
			t.Fatalf("consume %d: %v %v", i, ok, err)
		}
	}
	_, prev := f.post(f.s.HandlePreviewPlanChange, `{"to":"business"}`)
	if prev["unused_credit_cents"] != float64(90) {
		t.Fatalf("pro usage credit %v", prev)
	}
}
